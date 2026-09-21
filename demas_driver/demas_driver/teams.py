"""
teams.py - CNES Health Teams (Equipes de Saúde da Família, eAP, etc.) Retrieval & Processing.

Retrieves official microdata from DataSUS FTP (ftp.datasus.gov.br/dissemin/publicos/CNES/200508_/Dados/EP/)
with local Parquet caching and automatic facility enrichment for PNAB capacity calculation.
"""

import os
import ftplib
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional, Union

import pandas as pd

try:
    import datasus_dbc
    HAS_DATASUS_DBC = True
except ImportError:
    HAS_DATASUS_DBC = False

try:
    from dbfread import DBF
    HAS_DBFREAD = True
except ImportError:
    HAS_DBFREAD = False

try:
    import geopandas as gpd
    HAS_GEOPANDAS = True
except ImportError:
    HAS_GEOPANDAS = False

from .resolver import resolve_municipality_code
from .ibge_provider import get_uf_code

logger = logging.getLogger("demas_driver.teams")

DEFAULT_CACHE_DIR = Path.home() / ".cache" / "demas" / "teams"


def get_latest_ftp_competence(ftp: ftplib.FTP, uf: str) -> str:
    """Find the most recent available competence for the given UF on DataSUS FTP."""
    uf_upper = uf.upper()
    prefix = f"EP{uf_upper}"
    files = []
    try:
        ftp.retrlines(f"NLST {prefix}*.dbc", files.append)
    except Exception:
        # Fallback to general listing if NLST with pattern fails
        all_files = []
        ftp.retrlines("NLST", all_files.append)
        files = [f for f in all_files if f.startswith(prefix) and f.endswith(".dbc")]

    if not files:
        # Default fallback competence if listing empty
        return "2608"

    # Files are formatted like EPPR2608.dbc -> extract YYMM (last 4 chars before .dbc)
    competences = []
    for f in files:
        basename = os.path.basename(f)
        if basename.startswith(prefix) and basename.endswith(".dbc"):
            comp = basename[len(prefix):-4]
            if len(comp) == 4 and comp.isdigit():
                competences.append(comp)

    if competences:
        return sorted(competences)[-1]
    return "2608"


def fetch_cnes_teams_ftp(
    uf: str,
    competence: Optional[str] = None,
    cache_dir: Optional[Union[str, Path]] = None
) -> pd.DataFrame:
    """
    Download and decompress the official CNES Teams database (EP{UF}{YYMM}.dbc) from DataSUS FTP.
    """
    if not HAS_DATASUS_DBC or not HAS_DBFREAD:
        raise ImportError(
            "Fetching CNES teams from DataSUS requires 'datasus-dbc' and 'dbfread'. "
            "Install them via: pip install datasus-dbc dbfread"
        )

    target_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    uf_upper = uf.upper()

    # Connect to DataSUS FTP
    ftp = ftplib.FTP("ftp.datasus.gov.br", timeout=15)
    ftp.login()
    ftp.cwd("/dissemin/publicos/CNES/200508_/Dados/EP")

    if competence is None:
        competence = get_latest_ftp_competence(ftp, uf_upper)

    dbc_filename = f"EP{uf_upper}{competence}.dbc"
    dbf_filename = f"EP{uf_upper}{competence}.dbf"
    parquet_filename = f"EP_{uf_upper}_{competence}.parquet"

    parquet_path = target_dir / parquet_filename
    if parquet_path.exists():
        ftp.quit()
        return pd.read_parquet(parquet_path)

    local_dbc_path = target_dir / dbc_filename
    local_dbf_path = target_dir / dbf_filename

    # Download .dbc file
    with open(local_dbc_path, "wb") as f:
        ftp.retrbinary(f"RETR {dbc_filename}", f.write)
    ftp.quit()

    # Decompress .dbc to .dbf
    datasus_dbc.decompress(str(local_dbc_path), str(local_dbf_path))

    # Read .dbf
    table = DBF(str(local_dbf_path), encoding="iso-8859-1")
    rows = []
    for r in table:
        # DT_DESAT == '900001' indicates active team in DataSUS
        if str(r.get("DT_DESAT", "")).strip() == "900001":
            rows.append({
                "cnes": str(r.get("CNES", "")).strip().zfill(7),
                "codufmun": str(r.get("CODUFMUN", "")).strip(),
                "idequipe": str(r.get("IDEQUIPE", "")).strip(),
                "tipo_eqp": str(r.get("TIPO_EQP", "")).strip(),
                "nome_eqp": str(r.get("NOME_EQP", "")).strip(),
                "id_area": str(r.get("ID_AREA", "")).strip(),
                "nome_area": str(r.get("NOMEAREA", "")).strip(),
                "dt_ativa": str(r.get("DT_ATIVA", "")).strip(),
                "competen": str(r.get("COMPETEN", "")).strip(),
            })

    df = pd.DataFrame(rows)

    # Save to Parquet cache for future instant queries
    try:
        df.to_parquet(parquet_path, index=False)
        # Cleanup temporary files
        if local_dbc_path.exists():
            local_dbc_path.unlink()
        if local_dbf_path.exists():
            local_dbf_path.unlink()
    except Exception as e:
        logger.warning(f"Could not cache teams to parquet: {e}")

    return df


def get_cnes_teams(
    uf: str,
    municipality_code: Optional[Union[int, str]] = None,
    competence: Optional[str] = None,
    cache_dir: Optional[Union[str, Path]] = None,
    use_cache: bool = True
) -> pd.DataFrame:
    """
    Retrieve active CNES health teams for a state (UF) or specific municipality.
    """
    target_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
    uf_upper = uf.upper()

    df = None
    if use_cache and target_dir.exists():
        # Check if any parquet matches EP_{UF}_*.parquet
        pattern = f"EP_{uf_upper}_*.parquet" if competence is None else f"EP_{uf_upper}_{competence}.parquet"
        cached_files = sorted(list(target_dir.glob(pattern)))
        if cached_files:
            latest_cache = cached_files[-1]
            try:
                df = pd.read_parquet(latest_cache)
            except Exception:
                df = None

    if df is None:
        df = fetch_cnes_teams_ftp(uf_upper, competence, cache_dir)

    if municipality_code is not None:
        code_str = str(municipality_code).strip()
        code6 = code_str[:6]
        df = df[df["codufmun"] == code6].copy()

    return df


def aggregate_teams_by_cnes(df_teams: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregates active health teams by CNES establishment code.

    Metrics computed:
    - qtd_equipes_esf: Count of Equipes de Saúde da Família (tipo 70)
    - qtd_equipes_eap: Count of Equipes de Atenção Primária (tipo 76)
    - qtd_equipes_esb: Count of Equipes de Saúde Bucal (tipo 71)
    - qtd_equipes_emulti: Count of Equipes Multiprofissionais / NASF (tipo 72)
    - qtd_equipes_total: Total active teams in establishment
    - capacidade_pnab: Nominal population capacity per PNAB guidelines:
      (qtd_esf * 3500) + (qtd_eap * 2000), minimum 3500 if facility exists.
    - nomes_equipes: Semicolon-separated list of team names.
    """
    if df_teams.empty:
        return pd.DataFrame(columns=[
            "cnes", "qtd_equipes_esf", "qtd_equipes_eap", "qtd_equipes_esb",
            "qtd_equipes_emulti", "qtd_equipes_total", "capacidade_pnab", "nomes_equipes"
        ])

    def _agg_group(g):
        esf = int((g["tipo_eqp"] == "70").sum())
        eap = int((g["tipo_eqp"] == "76").sum())
        esb = int((g["tipo_eqp"] == "71").sum())
        emulti = int((g["tipo_eqp"] == "72").sum())
        total = len(g)
        cap = int(max(1, esf) * 3500 + eap * 2000)
        names = "; ".join([n for n in g["nome_eqp"].tolist() if n])
        return pd.Series({
            "qtd_equipes_esf": esf,
            "qtd_equipes_eap": eap,
            "qtd_equipes_esb": esb,
            "qtd_equipes_emulti": emulti,
            "qtd_equipes_total": total,
            "capacidade_pnab": cap,
            "nomes_equipes": names
        })

    agg_df = df_teams.groupby("cnes").apply(_agg_group, include_groups=False).reset_index()
    return agg_df


def enrich_facilities_with_teams(
    facilities: Any,
    uf: str,
    municipality_code: Optional[Union[int, str]] = None,
    cache_dir: Optional[Union[str, Path]] = None
) -> Any:
    """
    Enriches health facilities (GeoDataFrame, GeoJSON FeatureCollection, or records)
    with official active team counts and dynamic PNAB capacity.
    """
    df_teams = get_cnes_teams(uf, municipality_code, cache_dir=cache_dir)
    agg_df = aggregate_teams_by_cnes(df_teams)
    teams_dict = agg_df.set_index("cnes").to_dict(orient="index")

    # If GeoPandas GeoDataFrame
    if HAS_GEOPANDAS and isinstance(facilities, gpd.GeoDataFrame):
        gdf = facilities.copy()
        cnes_col = None
        for col in ["ref:CNES", "cnes", "codigo_cnes", "id"]:
            if col in gdf.columns:
                cnes_col = col
                break

        if cnes_col:
            esf_list, eap_list, tot_list, cap_list, names_list = [], [], [], [], []
            for _, row in gdf.iterrows():
                cnes_val = str(row.get(cnes_col, "")).strip().zfill(7)
                info = teams_dict.get(cnes_val)
                if info:
                    esf_list.append(info["qtd_equipes_esf"])
                    eap_list.append(info["qtd_equipes_eap"])
                    tot_list.append(info["qtd_equipes_total"])
                    cap_list.append(info["capacidade_pnab"])
                    names_list.append(info["nomes_equipes"])
                else:
                    # Default: 1 team equivalent if primary care / clinic, else 0
                    is_ubs = "ubs" in str(row.get("comment", "")).lower() or "clinic" in str(row.get("amenity", "")).lower()
                    esf_list.append(1 if is_ubs else 0)
                    eap_list.append(0)
                    tot_list.append(1 if is_ubs else 0)
                    cap_list.append(3500 if is_ubs else 3500)
                    names_list.append("")

            gdf["qtd_equipes_esf"] = esf_list
            gdf["qtd_equipes_eap"] = eap_list
            gdf["qtd_equipes_total"] = tot_list
            gdf["capacidade_pnab"] = cap_list
            gdf["nomes_equipes"] = names_list
        return gdf

    # If GeoJSON FeatureCollection dict
    if isinstance(facilities, dict) and facilities.get("type") == "FeatureCollection":
        fc = facilities
        for feat in fc.get("features", []):
            props = feat.get("properties", {})
            raw_cnes = str(props.get("ref:CNES") or props.get("cnes") or props.get("codigo_cnes") or feat.get("id") or "").strip().zfill(7)
            info = teams_dict.get(raw_cnes)
            if info:
                props["qtd_equipes_esf"] = info["qtd_equipes_esf"]
                props["qtd_equipes_eap"] = info["qtd_equipes_eap"]
                props["qtd_equipes_total"] = info["qtd_equipes_total"]
                props["capacidade_pnab"] = info["capacidade_pnab"]
                props["nomes_equipes"] = info["nomes_equipes"]
            else:
                is_ubs = "ubs" in str(props.get("comment", "")).lower() or "clinic" in str(props.get("amenity", "")).lower()
                props["qtd_equipes_esf"] = 1 if is_ubs else 0
                props["qtd_equipes_eap"] = 0
                props["qtd_equipes_total"] = 1 if is_ubs else 0
                props["capacidade_pnab"] = 3500 if is_ubs else 3500
                props["nomes_equipes"] = ""
        return fc

    # If list of establishment dicts
    if isinstance(facilities, list):
        for item in facilities:
            if isinstance(item, dict):
                raw_cnes = str(item.get("codigo_cnes") or item.get("cnes") or item.get("ref:CNES") or "").strip().zfill(7)
                info = teams_dict.get(raw_cnes)
                if info:
                    item["qtd_equipes_esf"] = info["qtd_equipes_esf"]
                    item["qtd_equipes_eap"] = info["qtd_equipes_eap"]
                    item["qtd_equipes_total"] = info["qtd_equipes_total"]
                    item["capacidade_pnab"] = info["capacidade_pnab"]
                    item["nomes_equipes"] = info["nomes_equipes"]
                else:
                    item["qtd_equipes_esf"] = 0
                    item["qtd_equipes_eap"] = 0
                    item["qtd_equipes_total"] = 0
                    item["capacidade_pnab"] = 3500
                    item["nomes_equipes"] = ""
        return facilities

    return facilities
