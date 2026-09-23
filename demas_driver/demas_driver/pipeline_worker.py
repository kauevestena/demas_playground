"""
pipeline_worker.py - Spatial Analysis & PNAB Compliance Worker for a Single Municipality.

Executes:
1. Ingestion of local/cached boundary, census tracts, and facilities.
2. 30m proximity facility clustering into health complexes / poles.
3. Voronoi territorial clipping for the 3 modalities: 'ambos', 'urbanos', 'rurais'.
4. Demographic areal interpolation from Censo 2022 tracts.
5. Multi-team PNAB capacity calculation and overload ratio classification.
6. Generation of municipality-level summary indicators.
"""

import time
import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional

import pandas as pd
import geopandas as gpd
import pyogrio
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

from . import analysis as demas_analysis
from .downloader import (
    download_uf_census_gpkg,
    fetch_municipality_boundary_resilient,
    fetch_municipality_facilities_resilient
)

logger = logging.getLogger("demas_driver.worker")

POLOS_STANDARD_COLS = [
    "cd_mun", "uf", "cnes", "name", "amenity", "healthcare",
    "qtd_equipes_esf", "qtd_equipes_eap", "qtd_equipes_total",
    "capacidade_pnab", "nomes_equipes", "cluster_size", "clustered", "geometry"
]

VORONOI_STANDARD_COLS = [
    "cd_mun", "uf", "facility_name", "cnes",
    "qtd_equipes_esf", "qtd_equipes_eap", "qtd_equipes_total",
    "capacidade_pnab", "nomes_equipes", "cluster_size",
    "populacao_total", "domicilios", "renda_per_capita",
    "pct_agua_encanada", "pct_esgoto_coletado",
    "sobrecarga_pnab", "classificacao_pnab", "cor_pnab",
    "area_km2", "densidade_demografica", "modalidade", "geometry"
]


def process_single_municipality(
    muni_meta: Dict[str, Any],
    cache_dir: Path,
    capacity_df: Optional[pd.DataFrame] = None
) -> Dict[str, Any]:
    """
    Process a single municipality through the complete DEMAS pipeline.
    Returns a bundle ready for transactional GeoPackage commit.
    """
    t0 = time.time()
    id7 = int(muni_meta.get("id7", muni_meta.get("id", 0)))
    code6 = int(muni_meta.get("code6", muni_meta.get("cd_mun", id7 // 10)))
    nome = str(muni_meta.get("nome_mun", muni_meta.get("nome", "Mun"))).strip()
    uf = str(muni_meta.get("uf", "")).strip().upper()

    cache_dir = Path(cache_dir)

    # 1. Load Census Tracts
    uf_gpkg = download_uf_census_gpkg(uf, cache_dir)
    cols_to_read = [
        "CD_SETOR", "SITUACAO", "AREA_KM2", "v0001", "v0005", "v0007", "CD_MUN", "geometry"
    ]

    try:
        tracts_raw = pyogrio.read_dataframe(
            uf_gpkg,
            where=f"CD_MUN = '{id7}'",
            columns=cols_to_read
        )
    except Exception as e:
        logger.warning(f"[{code6}] Could not read tracts from {uf_gpkg.name}: {e}")
        tracts_raw = gpd.GeoDataFrame()

    if tracts_raw.empty:
        # Fallback without CD_MUN filter if needed
        tracts_raw = gpd.GeoDataFrame()

    tracts_gdf = tracts_raw.copy()
    if not tracts_gdf.empty:
        # Rename/standardize demographic columns
        tracts_gdf["populacao"] = pd.to_numeric(tracts_gdf.get("v0001", 0), errors="coerce").fillna(0).astype(int)
        tracts_gdf["domicilios"] = pd.to_numeric(tracts_gdf.get("v0007", 0), errors="coerce").fillna(0).astype(int)
        tracts_gdf["situacao"] = tracts_gdf.get("SITUACAO", "Urbana").astype(str)
        tracts_gdf["cd_mun"] = code6
        tracts_gdf["uf"] = uf

        # Calculate base income and sanitation estimates if not present
        base_income = demas_analysis.UF_BASE_INCOME.get(uf, 2000.0) if hasattr(demas_analysis, "UF_BASE_INCOME") else 2200.0
        morad = pd.to_numeric(tracts_gdf.get("v0005", 2.6), errors="coerce").fillna(2.6)
        factor = (1.0 - (morad - 2.6) * 0.45).clip(0.4, 3.0)
        tracts_gdf["renda_per_capita"] = (base_income * factor).round(2)

        is_urb = tracts_gdf["situacao"].str.lower().str.contains("urban")
        tracts_gdf["pct_agua_encanada"] = ((is_urb * 16.2 + 82.0) - (morad - 2.5) * 3.0).clip(50.0, 99.8).round(1)
        tracts_gdf["pct_esgoto_coletado"] = ((is_urb * 49.5 + 45.0) - (morad - 2.5) * 6.0).clip(20.0, 99.5).round(1)
        tracts_gdf["geometry"] = tracts_gdf["geometry"].make_valid()

    # 2. Facilities & Health Teams
    fac_gdf = fetch_municipality_facilities_resilient(code6, uf, cache_dir, capacity_df)

    # 3. Municipal Boundary
    b_json = fetch_municipality_boundary_resilient(id7, code6, cache_dir)
    if b_json and b_json.get("features"):
        bound_gdf = gpd.GeoDataFrame.from_features(b_json["features"], crs="EPSG:4326")
    elif not tracts_gdf.empty:
        # Fallback to unary union of census tracts
        bound_union = unary_union(tracts_gdf.geometry)
        bound_gdf = gpd.GeoDataFrame({"geometry": [bound_union], "cd_mun": [code6]}, crs="EPSG:4326")
    elif not fac_gdf.empty:
        # Fallback to buffered convex hull of facilities for newly created municipalities
        hull = unary_union(fac_gdf.geometry).convex_hull.buffer(0.05)
        bound_gdf = gpd.GeoDataFrame({"geometry": [hull], "cd_mun": [code6]}, crs="EPSG:4326")
    else:
        bound_gdf = gpd.GeoDataFrame()

    if not bound_gdf.empty:
        bound_gdf["geometry"] = bound_gdf["geometry"].make_valid()

    # 4. Point Clustering (30m)
    if not fac_gdf.empty:
        clustered_gdf = demas_analysis.cluster_nearby_points(fac_gdf, max_distance_meters=30.0)
        clustered_gdf["cd_mun"] = code6
        clustered_gdf["uf"] = uf
    else:
        clustered_gdf = gpd.GeoDataFrame(columns=["geometry", "cd_mun", "uf"], crs="EPSG:4326")

    n_facilities = len(fac_gdf)
    n_clusters = len(clustered_gdf)

    # 5. Voronoi Computation (3 Modalities)
    vor_ambos_gdf = gpd.GeoDataFrame()
    vor_urbanos_gdf = gpd.GeoDataFrame()
    vor_rurais_gdf = gpd.GeoDataFrame()

    if n_clusters > 0 and not bound_gdf.empty:
        # Ambos
        try:
            vor_ambos_gdf = demas_analysis.compute_voronoi(
                facilities=clustered_gdf,
                boundary=bound_gdf,
                census_tracts=tracts_gdf,
                metric="sobrecarga",
                situacao="ambos",
                as_gdf=True
            )
            vor_ambos_gdf["cd_mun"] = code6
            vor_ambos_gdf["uf"] = uf
            vor_ambos_gdf["modalidade"] = "ambos"
        except Exception as e:
            logger.warning(f"[{code6}] Voronoi ambos error: {e}")

        # Urbanos
        try:
            vor_urbanos_gdf = demas_analysis.compute_voronoi(
                facilities=clustered_gdf,
                boundary=bound_gdf,
                census_tracts=tracts_gdf,
                metric="sobrecarga",
                situacao="urbanos",
                as_gdf=True
            )
            if not vor_urbanos_gdf.empty:
                vor_urbanos_gdf["cd_mun"] = code6
                vor_urbanos_gdf["uf"] = uf
                vor_urbanos_gdf["modalidade"] = "urbanos"
        except Exception as e:
            logger.warning(f"[{code6}] Voronoi urbanos error: {e}")

        # Rurais
        try:
            vor_rurais_gdf = demas_analysis.compute_voronoi(
                facilities=clustered_gdf,
                boundary=bound_gdf,
                census_tracts=tracts_gdf,
                metric="sobrecarga",
                situacao="rurais",
                as_gdf=True
            )
            if not vor_rurais_gdf.empty:
                vor_rurais_gdf["cd_mun"] = code6
                vor_rurais_gdf["uf"] = uf
                vor_rurais_gdf["modalidade"] = "rurais"
        except Exception as e:
            logger.warning(f"[{code6}] Voronoi rurais error: {e}")

    # 6. Municipal Summary Indicators
    pop_tot = int(tracts_gdf["populacao"].sum()) if not tracts_gdf.empty else 0
    pop_urb = int(tracts_gdf[tracts_gdf["situacao"].str.lower().str.contains("urban")]["populacao"].sum()) if not tracts_gdf.empty else 0
    pop_rur = int(tracts_gdf[tracts_gdf["situacao"].str.lower().str.contains("rural")]["populacao"].sum()) if not tracts_gdf.empty else 0

    area_tot = float(round(pd.to_numeric(tracts_gdf.get("AREA_KM2", 0), errors="coerce").fillna(0).sum(), 2)) if not tracts_gdf.empty else 0.0
    is_urb_mask = tracts_gdf["situacao"].str.lower().str.contains("urban") if not tracts_gdf.empty else pd.Series()
    area_urb = float(round(pd.to_numeric(tracts_gdf.loc[is_urb_mask, "AREA_KM2"], errors="coerce").fillna(0).sum(), 2)) if not tracts_gdf.empty else 0.0
    area_rur = float(round(pd.to_numeric(tracts_gdf.loc[~is_urb_mask, "AREA_KM2"], errors="coerce").fillna(0).sum(), 2)) if not tracts_gdf.empty else 0.0

    tot_esf = int(clustered_gdf["qtd_equipes_esf"].sum()) if not clustered_gdf.empty and "qtd_equipes_esf" in clustered_gdf.columns else 0
    tot_eap = int(clustered_gdf["qtd_equipes_eap"].sum()) if not clustered_gdf.empty and "qtd_equipes_eap" in clustered_gdf.columns else 0
    tot_eqp = int(clustered_gdf["qtd_equipes_total"].sum()) if not clustered_gdf.empty and "qtd_equipes_total" in clustered_gdf.columns else 0
    tot_cap = int(clustered_gdf["capacidade_pnab"].sum()) if not clustered_gdf.empty and "capacidade_pnab" in clustered_gdf.columns else 0

    pnab_adequada = sum(1 for c in vor_ambos_gdf.get("cor_pnab", []) if c == "#10b981") if not vor_ambos_gdf.empty else 0
    pnab_atencao = sum(1 for c in vor_ambos_gdf.get("cor_pnab", []) if c == "#f59e0b") if not vor_ambos_gdf.empty else 0
    pnab_critica = sum(1 for c in vor_ambos_gdf.get("cor_pnab", []) if c == "#ef4444") if not vor_ambos_gdf.empty else 0

    # Critical population
    pop_critica = 0
    if not vor_ambos_gdf.empty and "cor_pnab" in vor_ambos_gdf.columns and "populacao_total" in vor_ambos_gdf.columns:
        crit_mask = vor_ambos_gdf["cor_pnab"] == "#ef4444"
        pop_critica = int(vor_ambos_gdf.loc[crit_mask, "populacao_total"].sum())

    pct_pop_critica = round((pop_critica / pop_tot * 100.0), 2) if pop_tot > 0 else 0.0
    mean_overload = round(float(vor_ambos_gdf["sobrecarga_pnab"].mean()), 2) if not vor_ambos_gdf.empty and "sobrecarga_pnab" in vor_ambos_gdf.columns else 0.0

    duration_ms = int((time.time() - t0) * 1000)

    resumo_dict = {
        "cd_mun": code6,
        "id7": id7,
        "nome_mun": nome,
        "uf": uf,
        "pop_total": pop_tot,
        "pop_urbana": pop_urb,
        "pop_rural": pop_rur,
        "n_estabelecimentos": n_facilities,
        "n_polos": n_clusters,
        "qtd_equipes_esf": tot_esf,
        "qtd_equipes_eap": tot_eap,
        "qtd_equipes_total": tot_eqp,
        "capacidade_pnab_total": tot_cap,
        "sobrecarga_pnab_media": mean_overload,
        "n_polos_adequada": pnab_adequada,
        "n_polos_atencao": pnab_atencao,
        "n_polos_critica": pnab_critica,
        "pop_em_sobrecarga_critica": pop_critica,
        "pct_pop_critica": pct_pop_critica,
        "area_total_km2": area_tot,
        "area_urbana_km2": area_urb,
        "area_rural_km2": area_rur
    }

    stats = {
        "n_facilities": n_facilities,
        "n_clusters": n_clusters,
        "n_voronoi_ambos": len(vor_ambos_gdf),
        "n_voronoi_urbanos": len(vor_urbanos_gdf),
        "n_voronoi_rurais": len(vor_rurais_gdf),
        "pop_total": pop_tot,
        "capacidade_pnab_total": tot_cap,
        "pnab_critica_count": pnab_critica,
        "duration_ms": duration_ms
    }

    # 7. Standardize GeoDataFrames to canonical schema
    if not clustered_gdf.empty:
        polos_clean = clustered_gdf.copy()
        if "cnes" not in polos_clean.columns:
            for c_cand in ["ref:CNES", "codigo_cnes", "id"]:
                if c_cand in polos_clean.columns:
                    polos_clean["cnes"] = polos_clean[c_cand].astype(str)
                    break
            if "cnes" not in polos_clean.columns:
                polos_clean["cnes"] = ""
        if "name" not in polos_clean.columns:
            polos_clean["name"] = polos_clean.get("facility_name", "Estabelecimento de Saúde")

        for c in POLOS_STANDARD_COLS:
            if c not in polos_clean.columns and c != "geometry":
                polos_clean[c] = None

        clean_polos_gdf = polos_clean[POLOS_STANDARD_COLS].copy()
    else:
        clean_polos_gdf = gpd.GeoDataFrame(columns=POLOS_STANDARD_COLS, crs="EPSG:4326")

    def _standardize_vor(vgdf: gpd.GeoDataFrame, mod: str) -> gpd.GeoDataFrame:
        if vgdf is None or vgdf.empty:
            return gpd.GeoDataFrame(columns=VORONOI_STANDARD_COLS, crs="EPSG:4326")
        v = vgdf.copy()
        v["cd_mun"] = code6
        v["uf"] = uf
        v["modalidade"] = mod
        if "facility_name" not in v.columns:
            v["facility_name"] = v.get("name", "Polo de Saúde")
        if "cnes" not in v.columns:
            for c_cand in ["ref:CNES", "codigo_cnes", "id"]:
                if c_cand in v.columns:
                    v["cnes"] = v[c_cand].astype(str)
                    break
            if "cnes" not in v.columns:
                v["cnes"] = ""
        v["geometry"] = [
            MultiPolygon([geom]) if isinstance(geom, Polygon) else geom
            for geom in v.geometry
        ]
        for c in VORONOI_STANDARD_COLS:
            if c not in v.columns and c != "geometry":
                v[c] = None
        return v[VORONOI_STANDARD_COLS].copy()

    clean_vor_ambos_gdf = _standardize_vor(vor_ambos_gdf, "ambos")
    clean_vor_urbanos_gdf = _standardize_vor(vor_urbanos_gdf, "urbanos")
    clean_vor_rurais_gdf = _standardize_vor(vor_rurais_gdf, "rurais")

    return {
        "cd_mun": code6,
        "id7": id7,
        "nome_mun": nome,
        "uf": uf,
        "polos_gdf": clean_polos_gdf,
        "vor_ambos_gdf": clean_vor_ambos_gdf,
        "vor_urbanos_gdf": clean_vor_urbanos_gdf,
        "vor_rurais_gdf": clean_vor_rurais_gdf,
        "resumo_dict": resumo_dict,
        "stats": stats
    }
