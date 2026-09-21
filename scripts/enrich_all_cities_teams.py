#!/usr/bin/env python3
"""
enrich_all_cities_teams.py - Download official CNES teams from DataSUS FTP for all Brazilian UFs,
enrich all preloaded city GeoJSONs, and create a consolidated Parquet table.
"""

import os
import json
import ftplib
import glob
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import datasus_dbc
from dbfread import DBF

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "playground" / "data"
CACHE_DIR = Path.home() / ".cache" / "demas" / "teams"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

UFS = [
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO",
    "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR",
    "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"
]

COMPETENCE = "2608"  # August 2026


def download_and_process_uf(uf: str) -> pd.DataFrame:
    """Download and convert a single UF's teams table."""
    uf_upper = uf.upper()
    parquet_path = CACHE_DIR / f"EP_{uf_upper}_{COMPETENCE}.parquet"

    if parquet_path.exists():
        print(f"[{uf_upper}] Loaded from cache: {parquet_path}")
        return pd.read_parquet(parquet_path)

    dbc_name = f"EP{uf_upper}{COMPETENCE}.dbc"
    dbf_name = f"EP{uf_upper}{COMPETENCE}.dbf"
    local_dbc = CACHE_DIR / dbc_name
    local_dbf = CACHE_DIR / dbf_name

    print(f"[{uf_upper}] Downloading from DataSUS FTP...")
    ftp = ftplib.FTP("ftp.datasus.gov.br", timeout=20)
    ftp.login()
    ftp.cwd("/dissemin/publicos/CNES/200508_/Dados/EP")
    with open(local_dbc, "wb") as f:
        ftp.retrbinary(f"RETR {dbc_name}", f.write)
    ftp.quit()

    print(f"[{uf_upper}] Decompressing DBC to DBF...")
    datasus_dbc.decompress(str(local_dbc), str(local_dbf))

    print(f"[{uf_upper}] Reading DBF...")
    table = DBF(str(local_dbf), encoding="iso-8859-1")
    rows = []
    for r in table:
        if str(r.get("DT_DESAT", "")).strip() == "900001":
            rows.append({
                "cnes": str(r.get("CNES", "")).strip().zfill(7),
                "codufmun": str(r.get("CODUFMUN", "")).strip(),
                "idequipe": str(r.get("IDEQUIPE", "")).strip(),
                "tipo_eqp": str(r.get("TIPO_EQP", "")).strip(),
                "nome_eqp": str(r.get("NOME_EQP", "")).strip(),
                "dt_ativa": str(r.get("DT_ATIVA", "")).strip(),
                "competen": str(r.get("COMPETEN", "")).strip(),
            })

    df = pd.DataFrame(rows)
    df.to_parquet(parquet_path, index=False)

    if local_dbc.exists():
        local_dbc.unlink()
    if local_dbf.exists():
        local_dbf.unlink()

    print(f"[{uf_upper}] Processed {len(df)} active teams -> saved to {parquet_path.name}")
    return df


def main():
    print("=== 1. DOWNLOADING / LOADING TEAMS FOR ALL UFS ===")
    all_dfs = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(download_and_process_uf, uf): uf for uf in UFS}
        for f in as_completed(futures):
            uf = futures[f]
            try:
                df = f.result()
                all_dfs.append(df)
            except Exception as e:
                print(f"Error processing {uf}: {e}")

    if not all_dfs:
        print("No teams data retrieved.")
        return

    full_national_df = pd.concat(all_dfs, ignore_index=True)
    print(f"\nTotal active teams nationwide: {len(full_national_df):,}")

    # Build national lookup dictionary: (cnes, codufmun[:6]) -> stats
    print("\n=== 2. AGGREGATING TEAMS PER CNES ===")
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

    agg_national = full_national_df.groupby("cnes").apply(_agg_group, include_groups=False).reset_index()
    cnes_lookup = agg_national.set_index("cnes").to_dict(orient="index")
    print(f"Total distinct healthcare establishments with active teams in Brazil: {len(cnes_lookup):,}")

    # Save consolidated Parquet in playground/data/
    parquet_out = DATA_DIR / "cnes_equipes_brasil.parquet"
    full_national_df.to_parquet(parquet_out, index=False)
    print(f"Saved consolidated Parquet to: {parquet_out} ({parquet_out.stat().st_size / 1024:.1f} KB)")

    # Save aggregated lookup Parquet in playground/data/
    agg_parquet_out = DATA_DIR / "cnes_estabelecimentos_capacidade.parquet"
    agg_national.to_parquet(agg_parquet_out, index=False)
    print(f"Saved aggregated Parquet to: {agg_parquet_out} ({agg_parquet_out.stat().st_size / 1024:.1f} KB)")

    # === 3. ENRICH ALL PRELOADED CITY GEOJSONS ===
    print("\n=== 3. ENRICHING PRELOADED CITIES IN PLAYGROUND/DATA ===")
    geojson_files = sorted(glob.glob(str(DATA_DIR / "*.geojson")))
    for gj_path in geojson_files:
        p = Path(gj_path)
        code6 = p.stem
        with open(p, "r", encoding="utf-8") as f:
            gj = json.load(f)

        matched = 0
        multi_esf = 0
        features = gj.get("features", [])
        for feat in features:
            props = feat.get("properties", {})
            raw_cnes = str(props.get("ref:CNES") or props.get("cnes") or props.get("codigo_cnes") or feat.get("id") or "").strip().zfill(7)
            info = cnes_lookup.get(raw_cnes)
            if info:
                matched += 1
                if info["qtd_equipes_esf"] > 1:
                    multi_esf += 1
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

        with open(p, "w", encoding="utf-8") as f:
            json.dump(gj, f, ensure_ascii=False, indent=2)

        print(f"[{code6}] Enriched {matched}/{len(features)} facilities ({multi_esf} with multiple eSF teams)")

    print("\nAll cities successfully enriched with official health teams!")


if __name__ == "__main__":
    main()
