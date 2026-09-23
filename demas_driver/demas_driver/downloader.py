"""
downloader.py - Resilient Data Ingestion & Caching Layer for DEMAS National Pipeline.

Includes:
- Tenacity-decorated retries with exponential backoff and jitter.
- Local caching for IBGE Census GPKGs (by UF), boundaries, and facilities.
- Atomic partial download protection (.part files).
- Enrichment with official CNES primary care health teams.
"""

import os
import gzip
import json
import logging
import urllib.request
import urllib.error
from pathlib import Path
from typing import Dict, Any, List, Optional, Union

import pandas as pd
import geopandas as gpd
from tenacity import retry, stop_after_attempt, wait_random_exponential, retry_if_exception_type

logger = logging.getLogger("demas_driver.downloader")

DEFAULT_CACHE_DIR = Path("cache")
DEFAULT_CACHE_DIR.mkdir(parents=True, exist_ok=True)


# Network retry policy: exponential backoff from 1s to 60s, up to 10 attempts
network_retry = retry(
    reraise=True,
    stop=stop_after_attempt(10),
    wait=wait_random_exponential(multiplier=1, max=60),
    retry=retry_if_exception_type((urllib.error.URLError, TimeoutError, ConnectionError, OSError))
)


@network_retry
def _download_file_with_retry(url: str, dest_path: Path, timeout: int = 60) -> None:
    """Download remote file atomically with exponential backoff retries."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = dest_path.with_suffix(f"{dest_path.suffix}.part.{os.getpid()}")

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "demas_driver/1.0 (Health Geography Research)"}
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        with open(temp_path, "wb") as out_f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                out_f.write(chunk)

    if temp_path.exists():
        temp_path.replace(dest_path)


@network_retry
def _fetch_json_with_retry(url: str, timeout: int = 20) -> Any:
    """Fetch remote JSON payload with automatic gzip decompression and retries."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "demas_driver/1.0", "Accept-Encoding": "gzip"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8"))


def get_all_municipalities_list(cache_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    """
    Retrieve official list of all 5,570+ Brazilian municipalities from IBGE.
    Caches locally to cache/municipios_brasil.json.
    """
    base_cache = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
    cache_file = base_cache / "municipios_brasil.json"

    if cache_file.exists() and cache_file.stat().st_size > 10000:
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)

    logger.info("Fetching nationwide municipality list from IBGE Localidades API...")
    url = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios"
    raw_data = _fetch_json_with_retry(url)

    from .ibge_provider import get_uf_code

    muni_list = []
    for item in raw_data:
        id7 = int(item["id"])
        code6 = id7 // 10
        nome = str(item.get("nome", "")).strip()
        uf = get_uf_code(id7)

        muni_list.append({
            "id": id7,
            "code6": code6,
            "nome": nome,
            "uf": uf
        })

    muni_list.sort(key=lambda x: (x["uf"], x["nome"]))

    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(muni_list, f, ensure_ascii=False, indent=2)

    logger.info(f"Cached {len(muni_list)} Brazilian municipalities in {cache_file}")
    return muni_list


def download_uf_census_gpkg(uf: str, cache_dir: Optional[Path] = None) -> Path:
    """
    Ensure the Censo 2022 Census Tracts GPKG for the given UF is cached locally.
    Downloads once per UF from IBGE FTP.
    """
    uf_upper = uf.upper()
    base_cache = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
    census_dir = base_cache / "census"
    census_dir.mkdir(parents=True, exist_ok=True)

    dest_file = census_dir / f"{uf_upper}_setores_CD2022.gpkg"

    # Valid GPKG should be at least 1MB
    if dest_file.exists() and dest_file.stat().st_size > 1_000_000:
        return dest_file

    url = f"https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios/malha_com_atributos/setores/gpkg/UF/{uf_upper}/{uf_upper}_setores_CD2022.gpkg"
    logger.info(f"[{uf_upper}] Downloading official Censo 2022 GPKG from IBGE FTP...")
    _download_file_with_retry(url, dest_file, timeout=120)
    logger.info(f"[{uf_upper}] Censo 2022 GPKG downloaded successfully ({dest_file.stat().st_size / 1e6:.1f} MB)")
    return dest_file


def fetch_municipality_boundary_resilient(
    id7: int,
    code6: Optional[int] = None,
    cache_dir: Optional[Path] = None
) -> Dict[str, Any]:
    """
    Retrieve municipal boundary GeoJSON, checking local cache, bundled boundaries, and IBGE API.
    """
    if code6 is None:
        code6 = id7 // 10

    base_cache = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
    bound_dir = base_cache / "boundaries"
    bound_dir.mkdir(parents=True, exist_ok=True)
    cache_path = bound_dir / f"{id7}.geojson"

    if cache_path.exists() and cache_path.stat().st_size > 100:
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)

    # Check bundled boundaries in playground/data/boundaries/
    bundled_path = Path("playground/data/boundaries") / f"{code6}.geojson"
    if bundled_path.exists() and bundled_path.stat().st_size > 100:
        with open(bundled_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            with open(cache_path, "w", encoding="utf-8") as out_f:
                json.dump(data, out_f)
            return data

    # Fetch from IBGE API with tenacity
    url = f"https://servicodados.ibge.gov.br/api/v3/malhas/municipios/{id7}?formato=application/vnd.geo+json"
    data = _fetch_json_with_retry(url)

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(data, f)

    return data


def fetch_municipality_facilities_resilient(
    code6: int,
    uf: str,
    cache_dir: Optional[Path] = None,
    capacity_df: Optional[pd.DataFrame] = None
) -> gpd.GeoDataFrame:
    """
    Retrieve public health facilities for municipality with active CNES health teams.
    Checks cache, playground bundled data, or DEMAS API.
    """
    base_cache = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
    fac_dir = base_cache / "facilities"
    fac_dir.mkdir(parents=True, exist_ok=True)
    cache_path = fac_dir / f"{code6}.geojson"

    raw_geojson = None

    if cache_path.exists() and cache_path.stat().st_size > 100:
        try:
            return gpd.read_file(cache_path)
        except Exception:
            pass

    # Check playground bundled data
    bundled_path = Path("playground/data") / f"{code6}.geojson"
    if bundled_path.exists() and bundled_path.stat().st_size > 100:
        try:
            with open(bundled_path, "r", encoding="utf-8") as f:
                raw_geojson = json.load(f)
        except Exception:
            pass

    if raw_geojson is None:
        # Import core retrieval from demas_driver
        from .core import retrieve_facilities
        raw_geojson = retrieve_facilities(code6, output_format="osm", public_only=True)

    features = raw_geojson.get("features", []) if isinstance(raw_geojson, dict) else []
    if not features:
        empty_gdf = gpd.GeoDataFrame(columns=["geometry", "cd_mun", "cnes", "name"], crs="EPSG:4326")
        return empty_gdf

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    gdf["cd_mun"] = code6
    gdf["uf"] = uf.upper()

    # Enrich with teams and capacity
    if capacity_df is not None and not capacity_df.empty:
        cnes_col = None
        for col in ["ref:CNES", "cnes", "codigo_cnes", "id"]:
            if col in gdf.columns:
                cnes_col = col
                break

        if cnes_col:
            gdf["_clean_cnes"] = gdf[cnes_col].astype(str).str.strip().str.zfill(7)
            cap_dict = capacity_df.set_index("cnes").to_dict(orient="index")

            esf_l, eap_l, tot_l, cap_l, nomes_l = [], [], [], [], []
            for c in gdf["_clean_cnes"]:
                info = cap_dict.get(c)
                if info:
                    esf_l.append(info.get("qtd_equipes_esf", 0))
                    eap_l.append(info.get("qtd_equipes_eap", 0))
                    tot_l.append(info.get("qtd_equipes_total", 0))
                    cap_l.append(info.get("capacidade_pnab", 3500))
                    nomes_l.append(info.get("nomes_equipes", ""))
                else:
                    esf_l.append(1)
                    eap_l.append(0)
                    tot_l.append(1)
                    cap_l.append(3500)
                    nomes_l.append("")

            gdf["qtd_equipes_esf"] = esf_l
            gdf["qtd_equipes_eap"] = eap_l
            gdf["qtd_equipes_total"] = tot_l
            gdf["capacidade_pnab"] = cap_l
            gdf["nomes_equipes"] = nomes_l
            gdf = gdf.drop(columns=["_clean_cnes"], errors="ignore")

    # Cache locally
    try:
        gdf.to_file(cache_path, driver="GeoJSON")
    except Exception:
        pass

    return gdf
