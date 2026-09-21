"""
census.py - Unified High-Level API for Censo 2022 tracts and demographic spatial analysis.
"""

import json
from pathlib import Path
from typing import Dict, Any, List, Optional, Union

from .resolver import resolve_municipality_code
from .parquet_engine import query_parquet_tracts
from .ibge_provider import get_uf_code, calc_ibge_digit7, fetch_municipality_boundary, fetch_ibge_tracts_direct
from .analysis import compute_voronoi, compute_hexbins, enrich_cells_with_census, classify_1d
from .core import retrieve_facilities

try:
    import geopandas as gpd
    HAS_GEOPANDAS = True
except ImportError:
    HAS_GEOPANDAS = False


def get_census_tracts(
    municipality: Union[str, int],
    themes: Optional[List[str]] = None,
    source: str = "auto",
    cache_dir: Optional[Union[str, Path]] = None,
    as_gdf: bool = True
) -> Any:
    """
    Retrieve Censo 2022 tracts with demographic attributes for any municipality in Brazil.

    Parameters:
    -----------
    municipality : str or int
        Municipality name (e.g. "Curitiba", "São Paulo, SP") or 6/7-digit IBGE code.
    themes : list of str, optional
        Census themes to attach: 'basico', 'renda', 'saneamento'. Default: all available.
    source : str, default 'auto'
        - 'auto': Queries fast decoupled Parquet cache first (< 50ms).
                  Falls back to on-demand direct retrieval from IBGE FTP with auto-caching.
        - 'parquet': Only queries decoupled Parquet cache.
        - 'ibge': Directly queries IBGE FTP GPKG.
    cache_dir : str or Path, optional
        Custom directory containing or storing Parquet files. Default: bundled playground or ~/.cache/demas/parquet.
    as_gdf : bool, default True
        If True, returns a GeoPandas GeoDataFrame (requires geopandas).
        If False, returns a GeoJSON FeatureCollection dictionary.

    Returns:
    --------
    GeoDataFrame or dict (GeoJSON FeatureCollection)
    """
    if themes is None:
        themes = ["basico", "renda", "saneamento"]

    code6 = resolve_municipality_code(municipality)
    id7 = calc_ibge_digit7(code6)
    uf = get_uf_code(code6)

    # 1. Tier 1: Parquet Engine (ultra-fast < 50ms)
    if source in ("auto", "parquet"):
        tracts = query_parquet_tracts(
            code6=code6,
            uf=uf,
            id7=id7,
            themes=themes,
            parquet_dir=cache_dir,
            as_gdf=as_gdf
        )
        if tracts is not None and (not hasattr(tracts, "empty") or not tracts.empty):
            return tracts

    if source == "parquet":
        return None

    # 2. Tier 2: On-Demand Direct Retrieval from IBGE FTP GPKG + Auto-caching
    if source in ("auto", "ibge"):
        return fetch_ibge_tracts_direct(
            code6=code6,
            uf=uf,
            id7=id7,
            auto_cache=True,
            cache_dir=cache_dir,
            as_gdf=as_gdf
        )

    raise ValueError(f"Invalid source '{source}'. Choose 'auto', 'parquet', or 'ibge'.")


def get_municipality_boundary(
    municipality: Union[str, int],
    as_gdf: bool = True
) -> Any:
    """
    Retrieve official municipal boundary polygon from local cache or IBGE localidade API.
    """
    code6 = resolve_municipality_code(municipality)
    id7 = calc_ibge_digit7(code6)

    # Check bundled playground data
    curr = Path(__file__).resolve()
    for parent in [curr.parent, curr.parent.parent, curr.parent.parent.parent]:
        cand = parent / "playground" / "data" / "boundaries" / f"{code6}.geojson"
        if cand.is_file():
            if HAS_GEOPANDAS and as_gdf:
                return gpd.read_file(cand)
            with open(cand, "r", encoding="utf-8") as f:
                return json.load(f)

    # Fetch from official IBGE API
    b_json = fetch_municipality_boundary(id7)
    if not b_json:
        raise RuntimeError(f"Could not retrieve municipal boundary for municipality {code6} (ID7: {id7}).")

    if HAS_GEOPANDAS and as_gdf:
        return gpd.GeoDataFrame.from_features(b_json["features"], crs="EPSG:4326")
    return b_json


def analyze_coverage(
    municipality: Union[str, int],
    facilities: Optional[Any] = None,
    boundary: Optional[Any] = None,
    census_tracts: Optional[Any] = None,
    mode: str = "voronoi",
    metric: str = "population",
    radius_km: float = 1.0,
    cluster_distance_m: float = 20.0,
    classification_method: str = "jenks",
    n_classes: int = 5,
    as_gdf: bool = True
) -> Any:
    """
    End-to-end spatial-demographic coverage analysis.
    Automatically retrieves facilities, municipal boundary, and Censo 2022 tracts if not provided,
    and computes Voronoi or Hexagonal catchment areas with demographic indicators and PNAB overload.
    """
    code6 = resolve_municipality_code(municipality)

    if boundary is None:
        boundary = get_municipality_boundary(code6, as_gdf=True)

    if facilities is None:
        facilities = retrieve_facilities(code6, output_format="geojson", public_only=True)

    uf = get_uf_code(code6)
    try:
        from .teams import enrich_facilities_with_teams
        facilities = enrich_facilities_with_teams(facilities, uf, code6)
    except Exception:
        pass

    if census_tracts is None:
        census_tracts = get_census_tracts(code6, as_gdf=True)

    m = mode.lower()
    if m == "voronoi":
        return compute_voronoi(
            facilities=facilities,
            boundary=boundary,
            census_tracts=census_tracts,
            metric=metric,
            cluster_distance_m=cluster_distance_m,
            classification_method=classification_method,
            n_classes=n_classes,
            as_gdf=as_gdf
        )
    elif m in ("hex", "hexbin", "hexbins"):
        return compute_hexbins(
            facilities=facilities,
            boundary=boundary,
            radius_km=radius_km,
            census_tracts=census_tracts,
            metric=metric,
            classification_method=classification_method,
            n_classes=n_classes,
            as_gdf=as_gdf
        )
    else:
        raise ValueError(f"Invalid mode '{mode}'. Choose 'voronoi' or 'hexbin'.")
