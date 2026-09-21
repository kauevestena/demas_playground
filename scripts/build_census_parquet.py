import os
import json
import glob
import geopandas as gpd
import pandas as pd
from shapely.geometry import shape

def main():
    print("Starting build of decoupled Census Parquet dataset...")
    base_dir = "playground/data"
    manifest_path = os.path.join(base_dir, "manifest.json")
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    code6_to_id7 = {k: v.get('id7') for k, v in manifest.items()}
    code6_to_uf = {k: v.get('uf') for k, v in manifest.items()}

    geom_dir = os.path.join(base_dir, "parquet", "geom")
    attr_dir = os.path.join(base_dir, "parquet", "attributes")
    os.makedirs(geom_dir, exist_ok=True)
    os.makedirs(attr_dir, exist_ok=True)

    # Dictionaries to collect data by UF
    uf_geoms = {} # uf -> list of GeoDataFrames
    all_basico = []
    all_renda = []
    all_saneamento = []

    geojson_files = sorted(glob.glob(os.path.join(base_dir, "census_tracts", "*.geojson")))
    print(f"Found {len(geojson_files)} census tract GeoJSON files to convert.")

    for gpath in geojson_files:
        code6 = os.path.basename(gpath).replace(".geojson", "")
        uf = code6_to_uf.get(code6, "BR")
        id7 = code6_to_id7.get(code6)

        print(f"Reading {code6} ({uf})...")
        gdf = gpd.read_file(gpath)
        if len(gdf) == 0:
            continue

        # Add cd_mun and ensure cd_setor is string
        gdf['cd_setor'] = gdf['cd_setor'].astype(str)
        gdf['cd_mun'] = int(id7) if id7 else int(code6) * 10
        gdf['uf'] = uf

        # 1. Prepare Geometry DataFrame with serialized GeoJSON geometry
        geom_subset = pd.DataFrame()
        geom_subset['cd_setor'] = gdf['cd_setor']
        geom_subset['cd_mun'] = gdf['cd_mun']
        geom_subset['geom_json'] = [json.dumps(f['geometry']) for f in gdf.__geo_interface__['features']]
        if uf not in uf_geoms:
            uf_geoms[uf] = []
        uf_geoms[uf].append(geom_subset)

        # 2. Prepare Censo Básico Attributes
        basico_cols = ['cd_setor', 'cd_mun', 'uf', 'nm_bairro', 'situacao', 'cd_tipo', 
                       'populacao', 'domicilios', 'moradores_por_domicilio', 'area_km2', 'densidade_demografica']
        available_basico = [c for c in basico_cols if c in gdf.columns]
        df_basico = pd.DataFrame(gdf[available_basico]).copy()
        all_basico.append(df_basico)

        # 3. Prepare Censo Renda Attributes
        renda_cols = ['cd_setor', 'renda_per_capita']
        available_renda = [c for c in renda_cols if c in gdf.columns]
        df_renda = pd.DataFrame(gdf[available_renda]).copy()
        all_renda.append(df_renda)

        # 4. Exemplary Censo Saneamento / Infraestrutura (Simulated from urban/rural & density)
        # Demonstrating plug-and-play capability of future IBGE census tables
        df_san = pd.DataFrame()
        df_san['cd_setor'] = gdf['cd_setor']
        # Estimated metrics based on urban/rural setting & household density
        is_urbana = gdf['situacao'].astype(str).str.contains('Urbana', case=False, na=False)
        morad = gdf['moradores_por_domicilio'].fillna(2.8)
        df_san['pct_agua_encanada'] = (is_urbana.apply(lambda u: 98.2 if u else 82.0) - (morad - 2.5) * 3.0).clip(50.0, 99.8).round(1)
        df_san['pct_esgoto_coletado'] = (is_urbana.apply(lambda u: 94.5 if u else 45.0) - (morad - 2.5) * 6.0).clip(20.0, 99.5).round(1)
        df_san['pct_coleta_lixo'] = (is_urbana.apply(lambda u: 99.1 if u else 75.0) - (morad - 2.5) * 2.0).clip(60.0, 100.0).round(1)
        all_saneamento.append(df_san)

    # Write UF Geometry Parquet files
    print("\n--- Writing UF Geometry Parquets ---")
    for uf, dfs in uf_geoms.items():
        combined_df = pd.concat(dfs, ignore_index=True)
        out_geom = os.path.join(geom_dir, f"{uf}.parquet")
        combined_df.to_parquet(out_geom, compression='zstd')
        sz_kb = round(os.path.getsize(out_geom) / 1024, 1)
        print(f"Saved {out_geom} ({len(combined_df)} tracts, {sz_kb} KB)")

    # Write Thematic Attribute Parquet files
    print("\n--- Writing Thematic Attribute Parquets ---")
    
    # 1. Censo Básico
    combined_basico = pd.concat(all_basico, ignore_index=True).drop_duplicates(subset=['cd_setor']).reset_index(drop=True)
    out_basico = os.path.join(attr_dir, "censo_basico.parquet")
    combined_basico.to_parquet(out_basico, compression='zstd')
    print(f"Saved {out_basico} ({len(combined_basico)} rows, {round(os.path.getsize(out_basico)/1024, 1)} KB)")

    # 2. Censo Renda
    combined_renda = pd.concat(all_renda, ignore_index=True).drop_duplicates(subset=['cd_setor']).reset_index(drop=True)
    out_renda = os.path.join(attr_dir, "censo_renda.parquet")
    combined_renda.to_parquet(out_renda, compression='zstd')
    print(f"Saved {out_renda} ({len(combined_renda)} rows, {round(os.path.getsize(out_renda)/1024, 1)} KB)")

    # 3. Censo Saneamento
    combined_san = pd.concat(all_saneamento, ignore_index=True).drop_duplicates(subset=['cd_setor']).reset_index(drop=True)
    out_san = os.path.join(attr_dir, "censo_saneamento.parquet")
    combined_san.to_parquet(out_san, compression='zstd')
    print(f"Saved {out_san} ({len(combined_san)} rows, {round(os.path.getsize(out_san)/1024, 1)} KB)")

    print("\nParquet conversion complete!")

if __name__ == '__main__':
    main()
