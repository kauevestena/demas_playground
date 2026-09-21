"""
parquet_engine.py - Fast query engine over decoupled Census Parquet datasets.
Uses PyArrow / Pandas to perform joins between geometry and attribute tables.
"""

import os
import json
from pathlib import Path
from typing import List, Optional, Dict, Any, Union

# Attempt to import geospatial packages
try:
    import pandas as pd
    import pyarrow.parquet as pq
    import pyarrow.compute as pc
    HAS_PYARROW = True
except ImportError:
    HAS_PYARROW = False

try:
    import geopandas as gpd
    from shapely.geometry import shape
    HAS_GEOPANDAS = True
except ImportError:
    HAS_GEOPANDAS = False


def find_candidate_parquet_dirs(custom_dir: Optional[Union[str, Path]] = None) -> List[Path]:
    """Find all candidate Parquet dataset locations (custom, bundled playground, or home cache)."""
    candidates = []
    if custom_dir:
        p = Path(custom_dir)
        if p.is_dir():
            candidates.append(p)

    # 1. Check relative playground directory
    curr = Path(__file__).resolve()
    for parent in [curr.parent, curr.parent.parent, curr.parent.parent.parent]:
        candidate = parent / "playground" / "data" / "parquet"
        if candidate.is_dir() and (candidate / "geom").is_dir() and candidate not in candidates:
            candidates.append(candidate)

    # 2. Check user home cache
    home_cache = Path.home() / ".cache" / "demas" / "parquet"
    if home_cache.is_dir() and (home_cache / "geom").is_dir() and home_cache not in candidates:
        candidates.append(home_cache)

    return candidates


def query_parquet_tracts(
    code6: int,
    uf: str,
    id7: int,
    themes: List[str] = None,
    parquet_dir: Optional[Union[str, Path]] = None,
    as_gdf: bool = True
) -> Optional[Any]:
    """
    Query census tracts from decoupled Parquet files.
    """
    if not HAS_PYARROW:
        return None

    if themes is None:
        themes = ["basico", "renda", "saneamento"]

    candidate_dirs = find_candidate_parquet_dirs(parquet_dir)
    if not candidate_dirs:
        return None

    uf_upper = uf.upper()
    df_result = None
    matched_dir = None

    for base_dir in candidate_dirs:
        geom_file = base_dir / "geom" / f"{uf_upper}.parquet"
        if not geom_file.is_file():
            continue

        try:
            # 1. Read Geometry Parquet filtered by cd_mun
            geom_table = pq.read_table(
                geom_file,
                filters=[("cd_mun", "==", id7)]
            )
            if geom_table.num_rows > 0:
                df_result = geom_table.to_pandas()
                matched_dir = base_dir
                break
        except Exception:
            continue

    if df_result is None or matched_dir is None:
        return None

    # 2. Join requested attribute tables
    attr_dir = matched_dir / "attributes"
    # Fallback to check other candidate dirs if attr_dir is empty or missing
    attr_dirs = [attr_dir] + [d / "attributes" for d in candidate_dirs if d != matched_dir]

    # A. Censo Básico
    basico_file = attr_dir / "censo_basico.parquet"
    if basico_file.is_file():
        df_basico = pd.read_parquet(basico_file)
        # Drop redundant columns if any
        cols_to_drop = [c for c in ["cd_mun", "uf"] if c in df_basico.columns]
        if cols_to_drop:
            df_basico = df_basico.drop(columns=cols_to_drop)
        df_result = pd.merge(df_result, df_basico, on="cd_setor", how="left")

    # B. Censo Renda
    if "renda" in themes:
        renda_file = attr_dir / "censo_renda.parquet"
        if renda_file.is_file():
            df_renda = pd.read_parquet(renda_file)
            df_result = pd.merge(df_result, df_renda, on="cd_setor", how="left")

    # C. Censo Saneamento
    if "saneamento" in themes:
        san_file = attr_dir / "censo_saneamento.parquet"
        if san_file.is_file():
            df_san = pd.read_parquet(san_file)
            df_result = pd.merge(df_result, df_san, on="cd_setor", how="left")

    # Convert geom_json strings to Shapely shapes or GeoJSON features
    if HAS_GEOPANDAS and as_gdf:
        df_result["geometry"] = df_result["geom_json"].apply(lambda s: shape(json.loads(s)))
        df_clean = df_result.drop(columns=["geom_json"])
        gdf = gpd.GeoDataFrame(df_clean, geometry="geometry", crs="EPSG:4326")
        return gdf

    # Otherwise return standard GeoJSON dictionary
    features = []
    for _, row in df_result.iterrows():
        props = row.to_dict()
        geom_str = props.pop("geom_json", "{}")
        try:
            geom = json.loads(geom_str)
        except Exception:
            geom = None

        features.append({
            "type": "Feature",
            "id": str(props.get("cd_setor")),
            "properties": props,
            "geometry": geom
        })

    return {
        "type": "FeatureCollection",
        "metadata": {
            "municipality_code": code6,
            "uf": uf_upper,
            "id7": id7,
            "census_year": 2022,
            "total_tracts": len(features),
            "engine": "Python Parquet Engine",
            "themes": themes
        },
        "features": features
    }
