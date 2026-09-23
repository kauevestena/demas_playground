#!/usr/bin/env python3
"""
generate_dashboard_data.py - Data extraction and aggregation pipeline for DEMAS National Dashboard.

Generates:
- docs/data/br_ufs.geojson (Simplified 27 state polygons with embedded summary attributes)
- docs/data/dashboard_data.json (Aggregated KPIs, distributions, boxplot quantiles, histogram bins)
"""

import json
import urllib.request
from pathlib import Path
import numpy as np
import pandas as pd
import geopandas as gpd
from shapely.geometry import shape

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "docs" / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

UF_METADATA = {
    'AC': {'nome': 'Acre', 'regiao': 'Norte', 'ibge': 12},
    'AL': {'nome': 'Alagoas', 'regiao': 'Nordeste', 'ibge': 27},
    'AP': {'nome': 'Amapá', 'regiao': 'Norte', 'ibge': 16},
    'AM': {'nome': 'Amazonas', 'regiao': 'Norte', 'ibge': 13},
    'BA': {'nome': 'Bahia', 'regiao': 'Nordeste', 'ibge': 29},
    'CE': {'nome': 'Ceará', 'regiao': 'Nordeste', 'ibge': 23},
    'DF': {'nome': 'Distrito Federal', 'regiao': 'Centro-Oeste', 'ibge': 53},
    'ES': {'nome': 'Espírito Santo', 'regiao': 'Sudeste', 'ibge': 32},
    'GO': {'nome': 'Goiás', 'regiao': 'Centro-Oeste', 'ibge': 52},
    'MA': {'nome': 'Maranhão', 'regiao': 'Nordeste', 'ibge': 21},
    'MT': {'nome': 'Mato Grosso', 'regiao': 'Centro-Oeste', 'ibge': 51},
    'MS': {'nome': 'Mato Grosso do Sul', 'regiao': 'Centro-Oeste', 'ibge': 50},
    'MG': {'nome': 'Minas Gerais', 'regiao': 'Sudeste', 'ibge': 31},
    'PA': {'nome': 'Pará', 'regiao': 'Norte', 'ibge': 15},
    'PB': {'nome': 'Paraíba', 'regiao': 'Nordeste', 'ibge': 25},
    'PR': {'nome': 'Paraná', 'regiao': 'Sul', 'ibge': 41},
    'PE': {'nome': 'Pernambuco', 'regiao': 'Nordeste', 'ibge': 26},
    'PI': {'nome': 'Piauí', 'regiao': 'Nordeste', 'ibge': 22},
    'RJ': {'nome': 'Rio de Janeiro', 'regiao': 'Sudeste', 'ibge': 33},
    'RN': {'nome': 'Rio Grande do Norte', 'regiao': 'Nordeste', 'ibge': 24},
    'RS': {'nome': 'Rio Grande do Sul', 'regiao': 'Sul', 'ibge': 43},
    'RO': {'nome': 'Rondônia', 'regiao': 'Norte', 'ibge': 11},
    'RR': {'nome': 'Roraima', 'regiao': 'Norte', 'ibge': 14},
    'SC': {'nome': 'Santa Catarina', 'regiao': 'Sul', 'ibge': 42},
    'SP': {'nome': 'São Paulo', 'regiao': 'Sudeste', 'ibge': 35},
    'SE': {'nome': 'Sergipe', 'regiao': 'Nordeste', 'ibge': 28},
    'TO': {'nome': 'Tocantins', 'regiao': 'Norte', 'ibge': 17}
}


def compute_boxplot_stats(values):
    """Compute Tukey's boxplot statistics: [min, q1, median, q3, max] and outliers."""
    clean = sorted([float(v) for v in values if pd.notna(v) and np.isfinite(v)])
    if not clean:
        return [0, 0, 0, 0, 0], []
    
    q1 = float(np.percentile(clean, 25))
    median = float(np.percentile(clean, 50))
    q3 = float(np.percentile(clean, 75))
    iqr = q3 - q1
    lower_bound = max(clean[0], q1 - 1.5 * iqr)
    upper_bound = min(clean[-1], q3 + 1.5 * iqr)
    
    # Non-outlier min/max
    whisker_low = min([v for v in clean if v >= lower_bound] or [clean[0]])
    whisker_high = max([v for v in clean if v <= upper_bound] or [clean[-1]])
    
    outliers = [v for v in clean if v < lower_bound or v > upper_bound]
    return [round(whisker_low, 3), round(q1, 3), round(median, 3), round(q3, 3), round(whisker_high, 3)], outliers


def main():
    print("=" * 80)
    print("DEMAS DASHBOARD DATA BUILDER")
    print("=" * 80)

    # 1. Load Parquet
    parquet_path = REPO_ROOT / "output" / "geoparquet" / "municipios_resumo_brasil.parquet"
    if not parquet_path.exists():
        raise FileNotFoundError(f"Parquet summary not found: {parquet_path}")

    print(f"Loading {parquet_path}...")
    df = pd.read_parquet(parquet_path)
    print(f"Loaded {len(df):,} municipalities.")

    # Ensure auxiliary fields
    df["regiao"] = df["uf"].map(lambda u: UF_METADATA.get(u, {}).get("regiao", "Outros"))
    df["nome_uf"] = df["uf"].map(lambda u: UF_METADATA.get(u, {}).get("nome", u))
    df["hab_por_esf"] = np.where(df["qtd_equipes_esf"] > 0, df["pop_total"] / df["qtd_equipes_esf"], 0.0)

    # 2. National KPIs
    total_pop = int(df["pop_total"].sum())
    total_pop_urb = int(df["pop_urbana"].sum())
    total_pop_rur = int(df["pop_rural"].sum())
    total_fac = int(df["n_estabelecimentos"].sum())
    total_polos = int(df["n_polos"].sum())
    total_esf = int(df["qtd_equipes_esf"].sum())
    total_eap = int(df["qtd_equipes_eap"].sum())
    total_eqp = int(df["qtd_equipes_total"].sum())
    total_cap = int(df["capacidade_pnab_total"].sum())
    total_crit = int(df["pop_em_sobrecarga_critica"].sum())
    total_polos_adeq = int(df["n_polos_adequada"].sum())
    total_polos_aten = int(df["n_polos_atencao"].sum())
    total_polos_crit = int(df["n_polos_critica"].sum())

    national_kpis = {
        "n_municipios": len(df),
        "pop_total": total_pop,
        "pop_urbana": total_pop_urb,
        "pop_rural": total_pop_rur,
        "pct_pop_urbana": round((total_pop_urb / total_pop * 100), 2) if total_pop else 0,
        "pct_pop_rural": round((total_pop_rur / total_pop * 100), 2) if total_pop else 0,
        "n_estabelecimentos": total_fac,
        "n_polos": total_polos,
        "qtd_equipes_esf": total_esf,
        "qtd_equipes_eap": total_eap,
        "qtd_equipes_total": total_eqp,
        "capacidade_pnab_total": total_cap,
        "cobertura_pnab_pct": round((total_cap / total_pop * 100), 2) if total_pop else 0,
        "pop_em_sobrecarga_critica": total_crit,
        "pct_pop_critica": round((total_crit / total_pop * 100), 2) if total_pop else 0,
        "n_polos_adequada": total_polos_adeq,
        "n_polos_atencao": total_polos_aten,
        "n_polos_critica": total_polos_crit,
        "pct_polos_critica": round((total_polos_crit / total_polos * 100), 2) if total_polos else 0,
        "hab_por_esf": round(total_pop / total_esf) if total_esf else 0,
        "sobrecarga_pnab_media": round(float(df["sobrecarga_pnab_media"].mean()), 2)
    }

    # 3. Aggregate by UF
    ufs_list = []
    uf_dict = {}

    for uf, group in df.groupby("uf"):
        meta = UF_METADATA.get(uf, {"nome": uf, "regiao": "Brasil", "ibge": 0})
        pop_u = int(group["pop_total"].sum())
        pop_urb = int(group["pop_urbana"].sum())
        pop_rur = int(group["pop_rural"].sum())
        fac_u = int(group["n_estabelecimentos"].sum())
        polos_u = int(group["n_polos"].sum())
        esf_u = int(group["qtd_equipes_esf"].sum())
        eap_u = int(group["qtd_equipes_eap"].sum())
        eqp_u = int(group["qtd_equipes_total"].sum())
        cap_u = int(group["capacidade_pnab_total"].sum())
        crit_pop = int(group["pop_em_sobrecarga_critica"].sum())
        polos_ad = int(group["n_polos_adequada"].sum())
        polos_at = int(group["n_polos_atencao"].sum())
        polos_cr = int(group["n_polos_critica"].sum())
        area_u = round(float(group["area_total_km2"].sum()), 2)

        # Boxplots stats for UF
        box_sobrecarga, out_sobrecarga = compute_boxplot_stats(group["sobrecarga_pnab_media"])
        box_pct_crit, out_pct_crit = compute_boxplot_stats(group["pct_pop_critica"])
        box_hab_esf, out_hab_esf = compute_boxplot_stats(group[group["hab_por_esf"] > 0]["hab_por_esf"])

        uf_obj = {
            "uf": uf,
            "nome_uf": meta["nome"],
            "regiao": meta["regiao"],
            "ibge": meta["ibge"],
            "n_municipios": len(group),
            "pop_total": pop_u,
            "pop_urbana": pop_urb,
            "pop_rural": pop_rur,
            "pct_urbana": round((pop_urb / pop_u * 100), 1) if pop_u else 0,
            "n_estabelecimentos": fac_u,
            "n_polos": polos_u,
            "qtd_equipes_esf": esf_u,
            "qtd_equipes_eap": eap_u,
            "qtd_equipes_total": eqp_u,
            "capacidade_pnab_total": cap_u,
            "cobertura_pnab_pct": round((cap_u / pop_u * 100), 1) if pop_u else 0,
            "pop_em_sobrecarga_critica": crit_pop,
            "pct_pop_critica": round((crit_pop / pop_u * 100), 2) if pop_u else 0,
            "n_polos_adequada": polos_ad,
            "n_polos_atencao": polos_at,
            "n_polos_critica": polos_cr,
            "pct_polos_critica": round((polos_cr / polos_u * 100), 1) if polos_u else 0,
            "hab_por_esf": round(pop_u / esf_u) if esf_u else 0,
            "esf_por_10k": round((esf_u / pop_u * 10000), 2) if pop_u else 0,
            "sobrecarga_pnab_media": round(float(group["sobrecarga_pnab_media"].mean()), 2),
            "sobrecarga_pnab_mediana": round(float(group["sobrecarga_pnab_media"].median()), 2),
            "area_total_km2": area_u,
            "densidade_demografica": round(pop_u / area_u, 1) if area_u else 0,
            "boxplot_sobrecarga": box_sobrecarga,
            "boxplot_pct_critica": box_pct_crit,
            "boxplot_hab_esf": box_hab_esf
        }
        ufs_list.append(uf_obj)
        uf_dict[uf] = uf_obj

    ufs_list.sort(key=lambda x: x["nome_uf"])

    # 4. Regional Aggregations
    regioes_list = []
    for reg, rgroup in df.groupby("regiao"):
        pop_r = int(rgroup["pop_total"].sum())
        esf_r = int(rgroup["qtd_equipes_esf"].sum())
        eap_r = int(rgroup["qtd_equipes_eap"].sum())
        cap_r = int(rgroup["capacidade_pnab_total"].sum())
        crit_r = int(rgroup["pop_em_sobrecarga_critica"].sum())
        polos_r = int(rgroup["n_polos"].sum())
        box_sob, _ = compute_boxplot_stats(rgroup["sobrecarga_pnab_media"])
        box_crit, _ = compute_boxplot_stats(rgroup["pct_pop_critica"])

        regioes_list.append({
            "regiao": reg,
            "n_municipios": len(rgroup),
            "pop_total": pop_r,
            "qtd_equipes_esf": esf_r,
            "qtd_equipes_eap": eap_r,
            "qtd_equipes_total": int(rgroup["qtd_equipes_total"].sum()),
            "capacidade_pnab_total": cap_r,
            "cobertura_pnab_pct": round((cap_r / pop_r * 100), 1) if pop_r else 0,
            "pop_em_sobrecarga_critica": crit_r,
            "pct_pop_critica": round((crit_r / pop_r * 100), 2) if pop_r else 0,
            "n_polos": polos_r,
            "n_polos_adequada": int(rgroup["n_polos_adequada"].sum()),
            "n_polos_atencao": int(rgroup["n_polos_atencao"].sum()),
            "n_polos_critica": int(rgroup["n_polos_critica"].sum()),
            "hab_por_esf": round(pop_r / esf_r) if esf_r else 0,
            "sobrecarga_pnab_media": round(float(rgroup["sobrecarga_pnab_media"].mean()), 2),
            "boxplot_sobrecarga": box_sob,
            "boxplot_pct_critica": box_crit
        })

    # 5. Histogram Bins (Distribution across all 5,571 municipalities)
    # Histogram 1: Sobrecarga PNAB
    sob_vals = df["sobrecarga_pnab_media"].clip(0, 3.0).values
    hist_counts_sob, bin_edges_sob = np.histogram(sob_vals, bins=[0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0])
    hist_sob = [
        {"faixa": f"{bin_edges_sob[i]:.2f} - {bin_edges_sob[i+1]:.2f}", "count": int(hist_counts_sob[i]), "pct": round(hist_counts_sob[i] / len(df) * 100, 1)}
        for i in range(len(hist_counts_sob))
    ]

    # Histogram 2: Habitantes por Equipe ESF
    esf_clean = df[df["hab_por_esf"] > 0]["hab_por_esf"].clip(0, 8000).values
    hist_counts_esf, bin_edges_esf = np.histogram(esf_clean, bins=[0, 1500, 2500, 3500, 4500, 6000, 8000])
    hist_esf = [
        {"faixa": f"{int(bin_edges_esf[i])} - {int(bin_edges_esf[i+1])}", "count": int(hist_counts_esf[i]), "pct": round(hist_counts_esf[i] / len(esf_clean) * 100, 1)}
        for i in range(len(hist_counts_esf))
    ]

    # 6. Compact Municipal Points for Instant Client-side Filtering
    mun_compact = []
    for _, row in df.iterrows():
        mun_compact.append([
            int(row["cd_mun"]),
            str(row["nome_mun"]),
            str(row["uf"]),
            str(row["regiao"]),
            int(row["pop_total"]),
            int(row["qtd_equipes_esf"]),
            round(float(row["sobrecarga_pnab_media"]), 2),
            round(float(row["pct_pop_critica"]), 1),
            int(row["n_polos"])
        ])

    dashboard_bundle = {
        "metadata": {
            "title": "DEMAS — Panorama Estatístico da Atenção Primária no Brasil",
            "source": "Censo 2022 (IBGE) + CNES/DataSUS + OpenStreetMap",
            "total_mun": len(df),
            "generated_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
        },
        "kpis_nacionais": national_kpis,
        "ufs": ufs_list,
        "regioes": regioes_list,
        "histograma_sobrecarga": hist_sob,
        "histograma_hab_esf": hist_esf,
        "municipios_compact": mun_compact
    }

    out_json = DATA_DIR / "dashboard_data.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(dashboard_bundle, f, ensure_ascii=False)
    print(f"Generated {out_json} ({out_json.stat().st_size / 1024:.1f} KB)")

    # 7. Fetch, Simplify, and Augment State GeoJSON
    print("\nProcessing Brazilian State Polygons (br_ufs.geojson)...")
    raw_uf_url = "https://raw.githubusercontent.com/fititnt/gis-dataset-brasil/master/uf/geojson/uf.json"
    req = urllib.request.Request(raw_uf_url, headers={"User-Agent": "demas_dashboard/1.0"})
    with urllib.request.urlopen(req) as resp:
        raw_bytes = resp.read()
        raw_geojson = json.loads(raw_bytes.decode("latin1"))

    # Convert to GeoDataFrame, simplify and attach UF statistics
    features = []
    for feat in raw_geojson["features"]:
        geom = shape(feat["geometry"])
        # Simplify geometry with 0.008 deg tolerance (~800m) for lightning-fast web rendering
        simplified_geom = geom.simplify(0.008, preserve_topology=True)
        sigla = feat["properties"].get("UF_05", "").upper()
        
        # Attach aggregated UF statistics directly to feature properties
        stats = uf_dict.get(sigla, {})
        props = {
            "id": sigla,
            "sigla": sigla,
            "name": stats.get("nome_uf", feat["properties"].get("NOME_UF", sigla)),
            "regiao": stats.get("regiao", ""),
            "pop_total": stats.get("pop_total", 0),
            "qtd_equipes_esf": stats.get("qtd_equipes_esf", 0),
            "capacidade_pnab": stats.get("capacidade_pnab_total", 0),
            "cobertura_pnab_pct": stats.get("cobertura_pnab_pct", 0),
            "sobrecarga_media": stats.get("sobrecarga_pnab_media", 0),
            "pop_critica": stats.get("pop_em_sobrecarga_critica", 0),
            "pct_pop_critica": stats.get("pct_pop_critica", 0),
            "n_polos_critica": stats.get("n_polos_critica", 0),
            "hab_por_esf": stats.get("hab_por_esf", 0),
            "densidade": stats.get("densidade_demografica", 0)
        }
        
        from shapely.geometry import mapping
        features.append({
            "type": "Feature",
            "id": sigla,
            "properties": props,
            "geometry": mapping(simplified_geom)
        })

    uf_geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    out_geojson = DATA_DIR / "br_ufs.geojson"
    with open(out_geojson, "w", encoding="utf-8") as f:
        json.dump(uf_geojson, f, ensure_ascii=False)
    print(f"Generated {out_geojson} ({out_geojson.stat().st_size / 1024:.1f} KB)")
    print("\nData preparation complete!")


if __name__ == "__main__":
    main()
