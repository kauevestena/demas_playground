"""
analysis.py - Geospatial & Demographic Analysis Engine for demas_driver.

Includes:
- Voronoi / Thiessen polygons clipped to municipal boundary
- Hexagonal binning (hexbins) at arbitrary radius (e.g. 500m, 1km, 5km)
- Point clustering for proximate facilities (e.g. 10m to 100m)
- Areal interpolation & demographic enrichment with Censo 2022 tracts
- PNAB overload ratio calculation (Equipe de Saúde da Família threshold = 3,500 hab)
- 1D statistical classification (Jenks/Fisher-Ckmeans, Quantiles, Equal Interval, Std Dev)
"""

import math
import json
from typing import Dict, Any, List, Optional, Tuple, Union

try:
    import numpy as np
    import pandas as pd
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

try:
    import geopandas as gpd
    import shapely
    from shapely.geometry import Point, MultiPoint, Polygon, MultiPolygon, box, shape
    from shapely.ops import voronoi_diagram, unary_union
    HAS_GEOPANDAS = True
except ImportError:
    HAS_GEOPANDAS = False

try:
    from scipy.spatial import cKDTree
    from scipy.sparse import lil_matrix
    from scipy.sparse.csgraph import connected_components
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False


# Sequential color ramps (YlOrRd family)
COLOR_RAMP_4 = ['#ffffb2', '#fecc5c', '#f03b20', '#bd0026']
COLOR_RAMP_5 = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026']
COLOR_RAMP_6 = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026']
COLOR_RAMP_10 = [
    '#ffffd4', '#fee391', '#fec44f', '#fe9929', '#ec7014',
    '#cc4c02', '#993404', '#7a2202', '#5e1502', '#3f0c02'
]


# ==========================================
# 1D STATISTICAL CLASSIFICATION
# ==========================================

def _compute_jenks_breaks(data: List[float], k: int = 5) -> List[float]:
    """Fisher-Jenks dynamic programming natural breaks."""
    clean = sorted([float(x) for x in data if x is not None and not np.isnan(x)])
    n = len(clean)
    if n == 0:
        return [0.0] * (k + 1)
    if n <= k:
        return [clean[0]] + clean + [clean[-1]] * (k - n)

    mat1 = np.zeros((n + 1, k + 1))
    mat2 = np.zeros((n + 1, k + 1))

    for i in range(1, k + 1):
        mat1[1][i] = 1
        mat2[1][i] = 0
        for j in range(2, n + 1):
            mat2[j][i] = float('inf')

    for l in range(2, n + 1):
        s1 = 0.0
        s2 = 0.0
        w = 0.0
        for m in range(1, l + 1):
            i3 = l - m + 1
            val = clean[i3 - 1]
            s2 += val * val
            s1 += val
            w += 1
            v = s2 - (s1 * s1) / w
            i4 = i3 - 1
            if i4 != 0:
                for j in range(2, k + 1):
                    if mat2[l][j] >= (v + mat2[i4][j - 1]):
                        mat1[l][j] = i3
                        mat2[l][j] = v + mat2[i4][j - 1]
        mat1[l][1] = 1
        mat2[l][1] = v

    kclass = [0.0] * (k + 1)
    kclass[k] = clean[n - 1]
    kclass[0] = clean[0]
    count = k
    while count >= 2:
        idx = int(mat1[n][count]) - 2
        kclass[count - 1] = clean[idx]
        n = int(mat1[n][count] - 1)
        count -= 1
    return kclass


def classify_1d(
    values: List[float],
    method: str = 'jenks',
    k: int = 5,
    unit: str = ''
) -> Dict[str, Any]:
    """
    Classify a 1D numerical array using statistical breaks.
    Supported methods: 'jenks', 'quantiles', 'equal_interval', 'std_dev'.
    """
    clean_vals = [float(v) for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not clean_vals:
        return {'breaks': [0.0, 0.0], 'colors': ['#e2e8f0'], 'labels': ['Sem dados'], 'method': method}

    min_v, max_v = min(clean_vals), max(clean_vals)
    k = max(2, min(k, 10))

    if method == 'quantiles':
        percentiles = np.linspace(0, 100, k + 1)
        breaks = [float(np.percentile(clean_vals, p)) for p in percentiles]
    elif method == 'equal_interval':
        breaks = [float(min_v + i * (max_v - min_v) / k) for i in range(k + 1)]
    elif method == 'std_dev':
        mean = float(np.mean(clean_vals))
        std = float(np.std(clean_vals)) or 1.0
        breaks = [min_v]
        for step in [-1.5, -0.5, 0.5, 1.5]:
            val = mean + step * std
            if min_v < val < max_v:
                breaks.append(round(val, 2))
        breaks.append(max_v)
        breaks = sorted(list(set(breaks)))
        k = len(breaks) - 1
    else:  # default 'jenks'
        breaks = _compute_jenks_breaks(clean_vals, k)

    # Ensure strictly non-decreasing breaks
    breaks = sorted(breaks)
    for i in range(1, len(breaks)):
        if breaks[i] < breaks[i - 1]:
            breaks[i] = breaks[i - 1]

    # Select color ramp
    if k <= 4:
        colors = COLOR_RAMP_4[:k]
    elif k == 5:
        colors = COLOR_RAMP_5
    elif k == 6:
        colors = COLOR_RAMP_6
    else:
        colors = COLOR_RAMP_10[:k]

    # Format labels
    labels = []
    for i in range(k):
        low = breaks[i]
        high = breaks[i + 1]
        if unit == 'R$':
            labels.append(f"R$ {int(round(low)):,} - R$ {int(round(high)):,}".replace(',', '.'))
        elif unit == '%':
            labels.append(f"{low:.1f}% - {high:.1f}%")
        elif unit == 'hab.':
            labels.append(f"{int(round(low)):,} - {int(round(high)):,} hab.".replace(',', '.'))
        else:
            suffix = f" {unit}".strip()
            labels.append(f"{low:.1f} - {high:.1f}{(' ' + suffix) if suffix else ''}")

    def get_color(val: float) -> str:
        if val is None or math.isnan(val):
            return '#94a3b8'
        for i in range(k):
            if val <= breaks[i + 1] or i == k - 1:
                return colors[i]
        return colors[-1]

    def get_class_index(val: float) -> int:
        if val is None or math.isnan(val):
            return 0
        for i in range(k):
            if val <= breaks[i + 1] or i == k - 1:
                return i
        return k - 1

    return {
        'method': method,
        'k': k,
        'breaks': breaks,
        'colors': colors,
        'labels': labels,
        'get_color': get_color,
        'get_class_index': get_class_index
    }


# ==========================================
# POINT CLUSTERING (NEARBY FACILITIES)
# ==========================================

def cluster_nearby_points(
    features: Union[Any, List[Dict[str, Any]]],
    max_distance_meters: float = 20.0
) -> Any:
    """
    Cluster proximate facility points (e.g. 10m to 100m) into single representative points.
    Preserves merged properties (aggregated CNES, combined names, count).
    """
    if not HAS_GEOPANDAS or not HAS_SCIPY:
        return features

    # Handle GeoDataFrame
    is_gdf = isinstance(features, gpd.GeoDataFrame)
    if is_gdf:
        gdf = features.copy()
    elif isinstance(features, dict) and features.get("type") == "FeatureCollection":
        gdf = gpd.GeoDataFrame.from_features(features["features"])
    elif isinstance(features, list):
        gdf = gpd.GeoDataFrame.from_features(features)
    else:
        return features

    if len(gdf) <= 1 or max_distance_meters <= 0:
        return gdf if is_gdf else json.loads(gdf.to_json())

    # Project to local planar coordinates in meters
    lons = gdf.geometry.x.values
    lats = gdf.geometry.y.values
    mid_lat = float(np.mean(lats))
    km_per_deg_lon = 111320.0 * math.cos(math.radians(mid_lat))
    km_per_deg_lat = 111320.0

    x_m = lons * km_per_deg_lon
    y_m = lats * km_per_deg_lat
    pts_m = np.column_stack([x_m, y_m])

    tree = cKDTree(pts_m)
    pairs = tree.query_pairs(r=max_distance_meters)

    n = len(gdf)
    mat = lil_matrix((n, n), dtype=int)
    for i, j in pairs:
        mat[i, j] = 1
        mat[j, i] = 1

    n_components, labels = connected_components(mat.tocsr())
    gdf["cluster_id"] = labels

    clustered_records = []
    for cid, group in gdf.groupby("cluster_id"):
        first = group.iloc[0].to_dict()
        rep_geom = group.iloc[0].geometry

        # Aggregate properties if multiple points in cluster
        if len(group) > 1:
            names = [str(n) for n in group["name"].dropna().unique()]
            cnes_list = [str(c) for c in group.get("ref:CNES", group.get("cnes", [])).dropna().unique()]
            first["name"] = " / ".join(names[:2]) + (f" (+{len(names)-2})" if len(names) > 2 else "")
            first["ref:CNES"] = ", ".join(cnes_list)
            first["cluster_size"] = len(group)
            first["clustered"] = True
            # Aggregate health teams properties across cluster
            if "qtd_equipes_esf" in group.columns:
                first["qtd_equipes_esf"] = int(group["qtd_equipes_esf"].fillna(0).sum())
            if "qtd_equipes_eap" in group.columns:
                first["qtd_equipes_eap"] = int(group["qtd_equipes_eap"].fillna(0).sum())
            if "qtd_equipes_total" in group.columns:
                first["qtd_equipes_total"] = int(group["qtd_equipes_total"].fillna(0).sum())
            if "capacidade_pnab" in group.columns:
                first["capacidade_pnab"] = int(group["capacidade_pnab"].fillna(3500).sum())
            elif "qtd_equipes_esf" in first:
                first["capacidade_pnab"] = int(max(1, first["qtd_equipes_esf"]) * 3500 + first.get("qtd_equipes_eap", 0) * 2000)
        else:
            first["cluster_size"] = 1
            first["clustered"] = False

        first["geometry"] = rep_geom
        clustered_records.append(first)

    res_gdf = gpd.GeoDataFrame(clustered_records, geometry="geometry", crs=gdf.crs or "EPSG:4326")
    res_gdf = res_gdf.drop(columns=["cluster_id"], errors="ignore")

    return res_gdf if is_gdf else json.loads(res_gdf.to_json())


# ==========================================
# AREAL INTERPOLATION & DEMOGRAPHIC ENRICHMENT
# ==========================================

def enrich_cells_with_census(
    cells: Any,
    tracts: Any
) -> Any:
    """
    Enrich spatial cells (Voronoi polygons or Hexagons) with census demographics
    using exact geometric areal interpolation (areal weighting).
    """
    if not HAS_GEOPANDAS:
        return cells

    # Standardize input to GeoDataFrames
    cells_gdf = cells.copy() if isinstance(cells, gpd.GeoDataFrame) else (
        gpd.GeoDataFrame.from_features(cells["features"]) if isinstance(cells, dict) else gpd.GeoDataFrame.from_features(cells)
    )
    tracts_gdf = tracts.copy() if isinstance(tracts, gpd.GeoDataFrame) else (
        gpd.GeoDataFrame.from_features(tracts["features"]) if isinstance(tracts, dict) else gpd.GeoDataFrame.from_features(tracts)
    )

    if cells_gdf.empty or tracts_gdf.empty:
        return cells

    # Ensure valid geometries
    tracts_gdf["geometry"] = tracts_gdf["geometry"].buffer(0)
    cells_gdf["geometry"] = cells_gdf["geometry"].buffer(0)

    # Project to local metric UTM CRS for distortion-free areal weighting
    try:
        utm_crs = cells_gdf.estimate_utm_crs()
        c_proj = cells_gdf.to_crs(utm_crs)
        t_proj = tracts_gdf.to_crs(utm_crs)
    except Exception:
        c_proj = cells_gdf
        t_proj = tracts_gdf

    t_proj["_tract_area"] = t_proj.geometry.area
    sindex = t_proj.sindex

    allocated_pop = []
    allocated_dom = []
    weighted_income = []
    weighted_agua = []
    weighted_esgoto = []
    pnab_overload = []
    pnab_class = []
    pnab_color = []

    pop_col = "populacao" if "populacao" in t_proj.columns else ("v0001" if "v0001" in t_proj.columns else None)
    dom_col = "domicilios" if "domicilios" in t_proj.columns else ("v0007" if "v0007" in t_proj.columns else None)
    inc_col = "renda_per_capita" if "renda_per_capita" in t_proj.columns else None
    agua_col = "pct_agua_encanada" if "pct_agua_encanada" in t_proj.columns else None
    esgoto_col = "pct_esgoto_coletado" if "pct_esgoto_coletado" in t_proj.columns else None

    for _, cell_row in c_proj.iterrows():
        cell_geom = cell_row.geometry
        if cell_geom is None or cell_geom.is_empty:
            allocated_pop.append(0)
            allocated_dom.append(0)
            weighted_income.append(0.0)
            weighted_agua.append(None)
            weighted_esgoto.append(None)
            pnab_overload.append(0.0)
            pnab_class.append("Adequada (≤ 3.500 hab)")
            pnab_color.append("#10b981")
            continue

        possible_matches_idx = list(sindex.intersection(cell_geom.bounds))
        if not possible_matches_idx:
            allocated_pop.append(0)
            allocated_dom.append(0)
            weighted_income.append(0.0)
            weighted_agua.append(None)
            weighted_esgoto.append(None)
            pnab_overload.append(0.0)
            pnab_class.append("Adequada (≤ 3.500 hab)")
            pnab_color.append("#10b981")
            continue

        candidates = t_proj.iloc[possible_matches_idx]

        total_p = 0.0
        total_d = 0.0
        w_income = 0.0
        w_agua = 0.0
        w_esgoto = 0.0
        agua_pop = 0.0
        esgoto_pop = 0.0

        for _, t in candidates.iterrows():
            t_geom = t.geometry
            t_area = t._tract_area
            if t_area <= 0:
                continue

            try:
                inter = cell_geom.intersection(t_geom)
                if not inter.is_empty:
                    w = min(1.0, inter.area / t_area)
                    p_val = float(t[pop_col]) if pop_col and pd.notna(t[pop_col]) else 0.0
                    d_val = float(t[dom_col]) if dom_col and pd.notna(t[dom_col]) else 0.0
                    p_part = p_val * w
                    d_part = d_val * w

                    total_p += p_part
                    total_d += d_part

                    if inc_col and pd.notna(t[inc_col]):
                        w_income += float(t[inc_col]) * p_part

                    if agua_col and pd.notna(t[agua_col]):
                        w_agua += float(t[agua_col]) * p_part
                        agua_pop += p_part

                    if esgoto_col and pd.notna(t[esgoto_col]):
                        w_esgoto += float(t[esgoto_col]) * p_part
                        esgoto_pop += p_part
            except Exception:
                pass

        final_p = int(round(total_p))
        final_d = int(round(total_d))
        final_inc = round(w_income / total_p, 2) if total_p > 0 and w_income > 0 else 0.0
        final_agua = round(w_agua / agua_pop, 1) if agua_pop > 0 else None
        final_esgoto = round(w_esgoto / esgoto_pop, 1) if esgoto_pop > 0 else None

        # Dynamic PNAB ratio & category based on facility health teams
        cell_cap = cell_row.get("capacidade_pnab") if "capacidade_pnab" in cell_row else None
        qtd_esf = cell_row.get("qtd_equipes_esf") if "qtd_equipes_esf" in cell_row else None

        try:
            cell_cap = float(cell_cap) if cell_cap is not None and pd.notna(cell_cap) and float(cell_cap) > 0 else None
        except (ValueError, TypeError):
            cell_cap = None

        try:
            qtd_esf = int(qtd_esf) if qtd_esf is not None and pd.notna(qtd_esf) and int(qtd_esf) > 0 else 1
        except (ValueError, TypeError):
            qtd_esf = 1

        cap = cell_cap if cell_cap else float(qtd_esf * 3500.0)
        ratio = round(final_p / cap, 2)
        crit_pop = int(round(cap * 1.714))

        if ratio > 1.8 or final_p > crit_pop:
            p_cat = f"Crítica (> {crit_pop:,} hab)".replace(",", ".")
            p_col = "#ef4444"
        elif ratio > 1.0 or final_p > cap:
            p_cat = f"Atenção ({int(cap)+1:,} a {crit_pop:,} hab)".replace(",", ".")
            p_col = "#f59e0b"
        else:
            p_cat = f"Adequada (≤ {int(cap):,} hab)".replace(",", ".")
            p_col = "#10b981"

        allocated_pop.append(final_p)
        allocated_dom.append(final_d)
        weighted_income.append(final_inc)
        weighted_agua.append(final_agua)
        weighted_esgoto.append(final_esgoto)
        pnab_overload.append(ratio)
        pnab_class.append(p_cat)
        pnab_color.append(p_col)

    cells_gdf["populacao_total"] = allocated_pop
    cells_gdf["domicilios"] = allocated_dom
    cells_gdf["renda_per_capita"] = weighted_income
    cells_gdf["pct_agua_encanada"] = weighted_agua
    cells_gdf["pct_esgoto_coletado"] = weighted_esgoto
    cells_gdf["sobrecarga_pnab"] = pnab_overload
    cells_gdf["classificacao_pnab"] = pnab_class
    cells_gdf["cor_pnab"] = pnab_color

    if isinstance(cells, gpd.GeoDataFrame):
        return cells_gdf
    return json.loads(cells_gdf.to_json())


# ==========================================
# VORONOI DIAGRAM
# ==========================================

def compute_voronoi(
    facilities: Any,
    boundary: Optional[Any] = None,
    census_tracts: Optional[Any] = None,
    metric: str = "category",
    cluster_distance_m: float = 0.0,
    classification_method: str = "jenks",
    n_classes: int = 5,
    as_gdf: bool = True
) -> Any:
    """
    Compute Voronoi / Thiessen polygons for healthcare facilities,
    clipped to municipal boundary, enriched with Census tracts,
    and styled according to chosen metric.
    """
    if not HAS_GEOPANDAS:
        raise RuntimeError("geopandas is required for Voronoi computation.")

    # Standardize facilities input
    if isinstance(facilities, gpd.GeoDataFrame):
        fac_gdf = facilities.copy()
    elif isinstance(facilities, dict) and facilities.get("type") == "FeatureCollection":
        fac_gdf = gpd.GeoDataFrame.from_features(facilities["features"], crs="EPSG:4326")
    elif isinstance(facilities, list):
        fac_gdf = gpd.GeoDataFrame.from_features(facilities, crs="EPSG:4326")
    else:
        raise ValueError("Invalid facilities input. Provide GeoDataFrame or GeoJSON FeatureCollection.")

    if cluster_distance_m > 0:
        fac_gdf = cluster_nearby_points(fac_gdf, max_distance_meters=cluster_distance_m)

    if len(fac_gdf) == 0:
        empty_gdf = gpd.GeoDataFrame(columns=["geometry"], crs="EPSG:4326")
        return empty_gdf if as_gdf else json.loads(empty_gdf.to_json())

    # Standardize boundary geometry
    boundary_geom = None
    if boundary is not None:
        if isinstance(boundary, gpd.GeoDataFrame):
            boundary_geom = unary_union(boundary.geometry)
        elif isinstance(boundary, dict):
            if boundary.get("type") == "FeatureCollection":
                b_geoms = [shape(f["geometry"]) for f in boundary.get("features", []) if f.get("geometry")]
                boundary_geom = unary_union(b_geoms) if b_geoms else None
            elif "geometry" in boundary:
                boundary_geom = shape(boundary["geometry"])
            elif "type" in boundary:
                boundary_geom = shape(boundary)

    # Determine bounding envelope
    if boundary_geom:
        minx, miny, maxx, maxy = boundary_geom.bounds
    else:
        minx, miny, maxx, maxy = fac_gdf.total_bounds
    
    pad_x = (maxx - minx) * 0.5 or 0.1
    pad_y = (maxy - miny) * 0.5 or 0.1
    envelope = box(minx - pad_x, miny - pad_y, maxx + pad_x, maxy + pad_y)

    points = MultiPoint(list(fac_gdf.geometry.values))
    vor_polys = voronoi_diagram(points, envelope=envelope)

    # Match each Voronoi cell to its generator facility point
    cells_records = []
    vor_geoms = list(vor_polys.geoms)

    for _, fac_row in fac_gdf.iterrows():
        pt = fac_row.geometry
        matched_geom = None
        min_dist = float("inf")

        for poly in vor_geoms:
            if poly.contains(pt):
                matched_geom = poly
                break
            d = poly.distance(pt)
            if d < min_dist:
                min_dist = d
                matched_geom = poly

        if matched_geom is None:
            continue

        if boundary_geom:
            clipped = matched_geom.intersection(boundary_geom)
            if clipped.is_empty:
                continue
            final_geom = clipped
        else:
            final_geom = matched_geom

        rec = fac_row.to_dict()
        rec["geometry"] = final_geom
        rec["facility_name"] = rec.get("name", "Estabelecimento")
        rec["cnes"] = rec.get("ref:CNES", rec.get("cnes", "—"))
        rec["category"] = rec.get("comment", rec.get("category", "Saúde"))
        cells_records.append(rec)

    res_gdf = gpd.GeoDataFrame(cells_records, geometry="geometry", crs="EPSG:4326")

    # Enrich with census tracts if provided
    if census_tracts is not None:
        res_gdf = enrich_cells_with_census(res_gdf, census_tracts)

    # Classify / style by metric
    classification_meta = None
    if metric == "population" and "populacao_total" in res_gdf.columns:
        classification_meta = classify_1d(res_gdf["populacao_total"].tolist(), classification_method, n_classes, "hab.")
        res_gdf["color"] = [classification_meta["get_color"](v) for v in res_gdf["populacao_total"]]
        res_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in res_gdf["populacao_total"]]
        res_gdf["metric_value"] = res_gdf["populacao_total"]
    elif metric == "income" and "renda_per_capita" in res_gdf.columns:
        classification_meta = classify_1d(res_gdf["renda_per_capita"].tolist(), classification_method, n_classes, "R$")
        res_gdf["color"] = [classification_meta["get_color"](v) for v in res_gdf["renda_per_capita"]]
        res_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in res_gdf["renda_per_capita"]]
        res_gdf["metric_value"] = res_gdf["renda_per_capita"]
    elif metric == "saneamento_agua" and "pct_agua_encanada" in res_gdf.columns:
        classification_meta = classify_1d(res_gdf["pct_agua_encanada"].dropna().tolist(), classification_method, n_classes, "%")
        res_gdf["color"] = [classification_meta["get_color"](v) for v in res_gdf["pct_agua_encanada"]]
        res_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in res_gdf["pct_agua_encanada"]]
        res_gdf["metric_value"] = res_gdf["pct_agua_encanada"]
    elif metric == "saneamento_esgoto" and "pct_esgoto_coletado" in res_gdf.columns:
        classification_meta = classify_1d(res_gdf["pct_esgoto_coletado"].dropna().tolist(), classification_method, n_classes, "%")
        res_gdf["color"] = [classification_meta["get_color"](v) for v in res_gdf["pct_esgoto_coletado"]]
        res_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in res_gdf["pct_esgoto_coletado"]]
        res_gdf["metric_value"] = res_gdf["pct_esgoto_coletado"]
    elif metric == "sobrecarga_pnab" and "cor_pnab" in res_gdf.columns:
        res_gdf["color"] = res_gdf["cor_pnab"]
        res_gdf["metric_value"] = res_gdf["sobrecarga_pnab"]

    if as_gdf:
        return res_gdf

    fc = json.loads(res_gdf.to_json())
    if classification_meta:
        fc["classification"] = {
            "method": classification_meta["method"],
            "breaks": classification_meta["breaks"],
            "colors": classification_meta["colors"],
            "labels": classification_meta["labels"]
        }
    return fc


# ==========================================
# HEXAGONAL BINNING (HEXBINS)
# ==========================================

def compute_hexbins(
    facilities: Optional[Any] = None,
    boundary: Optional[Any] = None,
    radius_km: float = 1.0,
    census_tracts: Optional[Any] = None,
    metric: str = "count",
    classification_method: str = "jenks",
    n_classes: int = 5,
    as_gdf: bool = True
) -> Any:
    """
    Generate regular hexagonal grid over municipality boundary or extent,
    count facilities per hexagon, enrich with census demographics,
    and classify by metric.
    """
    if not HAS_GEOPANDAS:
        raise RuntimeError("geopandas is required for hexbins computation.")

    # Determine bounds and boundary geometry
    boundary_geom = None
    if boundary is not None:
        if isinstance(boundary, gpd.GeoDataFrame):
            boundary_geom = unary_union(boundary.geometry)
        elif isinstance(boundary, dict):
            if boundary.get("type") == "FeatureCollection":
                b_geoms = [shape(f["geometry"]) for f in boundary.get("features", []) if f.get("geometry")]
                boundary_geom = unary_union(b_geoms) if b_geoms else None
            elif "geometry" in boundary:
                boundary_geom = shape(boundary["geometry"])
            elif "type" in boundary:
                boundary_geom = shape(boundary)

    if boundary_geom:
        minx, miny, maxx, maxy = boundary_geom.bounds
    elif facilities is not None:
        fac_gdf = facilities if isinstance(facilities, gpd.GeoDataFrame) else gpd.GeoDataFrame.from_features(facilities["features"] if isinstance(facilities, dict) else facilities)
        minx, miny, maxx, maxy = fac_gdf.total_bounds
    elif census_tracts is not None:
        c_gdf = census_tracts if isinstance(census_tracts, gpd.GeoDataFrame) else gpd.GeoDataFrame.from_features(census_tracts["features"] if isinstance(census_tracts, dict) else census_tracts)
        minx, miny, maxx, maxy = c_gdf.total_bounds
    else:
        raise ValueError("At least one of boundary, facilities, or census_tracts must be provided.")

    mid_lat = (miny + maxy) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(mid_lat))

    rx = radius_km / km_per_deg_lon
    ry = radius_km / km_per_deg_lat

    dx = math.sqrt(3) * rx
    dy = 1.5 * ry

    hexagons = []
    x_min = minx - dx
    x_max = maxx + dx
    y_min = miny - dy
    y_max = maxy + dy

    y = y_min
    row = 0
    while y <= y_max:
        x_offset = (dx / 2.0) if (row % 2 == 1) else 0.0
        x = x_min + x_offset
        while x <= x_max:
            pts = []
            for i in range(6):
                angle = math.pi / 6.0 + i * math.pi / 3.0
                px = x + rx * math.cos(angle)
                py = y + ry * math.sin(angle)
                pts.append((px, py))
            pts.append(pts[0])
            hex_poly = Polygon(pts)

            if boundary_geom:
                if boundary_geom.intersects(hex_poly):
                    clipped = hex_poly.intersection(boundary_geom)
                    if not clipped.is_empty and clipped.area > 0:
                        hexagons.append(clipped)
            else:
                hexagons.append(hex_poly)
            x += dx
        y += dy
        row += 1

    hex_gdf = gpd.GeoDataFrame({"geometry": hexagons}, crs="EPSG:4326")
    hex_gdf["hex_id"] = [f"hex_{i}" for i in range(len(hex_gdf))]

    # Count facilities within each hexagon if provided
    if facilities is not None:
        fac_gdf = facilities if isinstance(facilities, gpd.GeoDataFrame) else gpd.GeoDataFrame.from_features(facilities["features"] if isinstance(facilities, dict) else facilities)
        sindex = fac_gdf.sindex
        counts = []
        for h_geom in hex_gdf.geometry:
            matches = list(sindex.intersection(h_geom.bounds))
            c = sum(1 for m in matches if h_geom.contains(fac_gdf.geometry.iloc[m]))
            counts.append(c)
        hex_gdf["point_count"] = counts
    else:
        hex_gdf["point_count"] = 0

    # Enrich with census tracts if provided
    if census_tracts is not None:
        hex_gdf = enrich_cells_with_census(hex_gdf, census_tracts)

    # Classify by metric
    classification_meta = None
    if metric == "count":
        classification_meta = classify_1d(hex_gdf["point_count"].tolist(), classification_method, n_classes, "estab.")
        hex_gdf["color"] = [classification_meta["get_color"](v) for v in hex_gdf["point_count"]]
        hex_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in hex_gdf["point_count"]]
        hex_gdf["metric_value"] = hex_gdf["point_count"]
    elif metric == "population" and "populacao_total" in hex_gdf.columns:
        classification_meta = classify_1d(hex_gdf["populacao_total"].tolist(), classification_method, n_classes, "hab.")
        hex_gdf["color"] = [classification_meta["get_color"](v) for v in hex_gdf["populacao_total"]]
        hex_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in hex_gdf["populacao_total"]]
        hex_gdf["metric_value"] = hex_gdf["populacao_total"]
    elif metric == "income" and "renda_per_capita" in hex_gdf.columns:
        classification_meta = classify_1d(hex_gdf["renda_per_capita"].tolist(), classification_method, n_classes, "R$")
        hex_gdf["color"] = [classification_meta["get_color"](v) for v in hex_gdf["renda_per_capita"]]
        hex_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in hex_gdf["renda_per_capita"]]
        hex_gdf["metric_value"] = hex_gdf["renda_per_capita"]
    elif metric == "saneamento_agua" and "pct_agua_encanada" in hex_gdf.columns:
        classification_meta = classify_1d(hex_gdf["pct_agua_encanada"].dropna().tolist(), classification_method, n_classes, "%")
        hex_gdf["color"] = [classification_meta["get_color"](v) for v in hex_gdf["pct_agua_encanada"]]
        hex_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in hex_gdf["pct_agua_encanada"]]
        hex_gdf["metric_value"] = hex_gdf["pct_agua_encanada"]
    elif metric == "saneamento_esgoto" and "pct_esgoto_coletado" in hex_gdf.columns:
        classification_meta = classify_1d(hex_gdf["pct_esgoto_coletado"].dropna().tolist(), classification_method, n_classes, "%")
        hex_gdf["color"] = [classification_meta["get_color"](v) for v in hex_gdf["pct_esgoto_coletado"]]
        hex_gdf["class_index"] = [classification_meta["get_class_index"](v) for v in hex_gdf["pct_esgoto_coletado"]]
        hex_gdf["metric_value"] = hex_gdf["pct_esgoto_coletado"]
    elif metric == "sobrecarga_pnab" and "cor_pnab" in hex_gdf.columns:
        hex_gdf["color"] = hex_gdf["cor_pnab"]
        hex_gdf["metric_value"] = hex_gdf["sobrecarga_pnab"]

    if as_gdf:
        return hex_gdf

    fc = json.loads(hex_gdf.to_json())
    if classification_meta:
        fc["classification"] = {
            "method": classification_meta["method"],
            "breaks": classification_meta["breaks"],
            "colors": classification_meta["colors"],
            "labels": classification_meta["labels"]
        }
    return fc
