"""
core.py - Main entry point and orchestration for demas_driver.
"""

import json
import os
from .client import fetch_all_establishments
from .osm import convert_to_osm_geojson
from .resolver import resolve_municipality_code


def retrieve_facilities(
    municipality,
    output_format: str = "osm",
    public_only: bool = True,
    status: int = 1,
    **kwargs,
):
    """
    Retrieve healthcare facilities for a municipality from the official DEMAS/CNES API.

    Parameters:
    -----------
    municipality : str or int
        Municipality name (e.g. "Pato Branco", "Pato Branco, PR") or 6/7-digit IBGE code (e.g. 411850).
    output_format : str, default 'osm'
        Format of returned data:
        - 'osm' or 'geojson': GeoJSON FeatureCollection with standard OpenStreetMap tags,
          clean Portuguese titles, coordinates, and an added 'comment' classification column.
        - 'raw': Raw list of establishment records directly as returned by the CNES API.
    public_only : bool, default True
        If True, only returns public administration facilities (Natureza Jurídica 1xxx).
        If False, returns all matching facilities (including private clinics and consultórios).
    status : int, default 1
        Filter by establishment status (1 = active, 0 = inactive).
    **kwargs :
        - output_file : str, optional
            Path to write the resulting GeoJSON or JSON to disk.
        - use_cache : str or bool, optional
            Path to a cached JSON file of raw establishments, or True to check standard cache path.
        - max_workers : int, default 12
            Number of concurrent threads for fetching pages.
        - Any additional CNES API query parameter (e.g. codigo_tipo_unidade=2).

    Returns:
    --------
    dict or list : GeoJSON FeatureCollection dictionary or raw list of records.
    """
    code = resolve_municipality_code(municipality)

    output_file = kwargs.pop("output_file", None)
    use_cache = kwargs.pop("use_cache", None)
    apply_offsets = kwargs.pop("apply_micro_offsets", True)

    records = None
    cache_path = None

    if use_cache:
        if isinstance(use_cache, str):
            cache_path = use_cache
        else:
            cache_path = f"cnes_{code}_active.json"

        if os.path.exists(cache_path):
            with open(cache_path, "r", encoding="utf-8") as f:
                records = json.load(f)

    if records is None:
        records = fetch_all_establishments(code, status=status, **kwargs)

    # Filter public administration if requested
    if public_only:
        records = [
            r
            for r in records
            if str(r.get("descricao_natureza_juridica_estabelecimento") or "").startswith("1")
        ]

    # Convert to requested format
    fmt = (output_format or "osm").lower()
    if fmt in ("osm", "geojson"):
        result = convert_to_osm_geojson(records, apply_micro_offsets=apply_offsets)
    elif fmt == "raw":
        result = records
    else:
        raise ValueError(f"Unsupported output_format '{output_format}'. Supported formats: 'osm', 'geojson', 'raw'.")

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    return result
