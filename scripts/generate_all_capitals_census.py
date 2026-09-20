import os
import json
import time
import geopandas as gpd
import pyogrio
import pandas as pd

# GDAL optimization for remote HTTP VSI
os.environ['CPL_VSIL_CURL_CHUNK_SIZE'] = '1048576'
os.environ['VSI_CACHE'] = 'TRUE'
os.environ['VSI_CACHE_SIZE'] = '67108864'
os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'

UF_BASE_INCOME = {
    'DF': 3800.0, 'RJ': 2800.0, 'MG': 2600.0, 'RS': 2700.0, 'ES': 2600.0,
    'MS': 2400.0, 'MT': 2400.0, 'GO': 2300.0, 'PR': 2700.0, 'SC': 2800.0,
    'SP': 3200.0, 'AM': 1900.0, 'PA': 1700.0, 'RO': 1800.0, 'AC': 1600.0,
    'AP': 1600.0, 'RR': 1700.0, 'TO': 1900.0, 'BA': 1900.0, 'PE': 1900.0,
    'CE': 1800.0, 'RN': 1800.0, 'PB': 1800.0, 'AL': 1600.0, 'SE': 1700.0,
    'PI': 1600.0, 'MA': 1500.0
}

def round_coords(coords, ndigits=5):
    if not coords:
        return coords
    if isinstance(coords[0], (int, float)):
        return [round(float(coords[0]), ndigits), round(float(coords[1]), ndigits)]
    return [round_coords(c, ndigits) for c in coords]

def process_city(code6, city_info):
    output_path = f"playground/data/census_tracts/{code6}.geojson"
    if os.path.exists(output_path):
        print(f"[{code6}] {city_info['name']} already exists. Skipping.")
        return True

    boundary_path = f"playground/data/boundaries/{code6}.geojson"
    if not os.path.exists(boundary_path):
        print(f"[{code6}] Boundary file not found at {boundary_path}!")
        return False

    uf = city_info['uf']
    id7 = str(city_info.get('id7', ''))
    if not id7:
        print(f"[{code6}] No id7 found!")
        return False

    print(f"\n--- Processing {city_info['name']} ({uf}) - Code: {code6}, ID7: {id7} ---")
    t0 = time.time()

    # 1. Get bbox from boundary
    boundary_gdf = gpd.read_file(boundary_path)
    minx, miny, maxx, maxy = boundary_gdf.total_bounds
    # Add a small buffer (0.005 deg ~ 500m) to ensure boundary edge sectors are included
    bbox = (minx - 0.005, miny - 0.005, maxx + 0.005, maxy + 0.005)

    # 2. Query IBGE GPKG via /vsicurl/
    gpkg_url = f"/vsicurl/https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios/malha_com_atributos/setores/gpkg/UF/{uf}/{uf}_setores_CD2022.gpkg"
    cols = ['CD_SETOR', 'NM_BAIRRO', 'NM_DIST', 'SITUACAO', 'CD_TIPO', 'AREA_KM2', 'v0001', 'v0005', 'v0007', 'CD_MUN']

    try:
        df = pyogrio.read_dataframe(
            gpkg_url,
            bbox=bbox,
            columns=cols,
            where=f"CD_MUN = '{id7}'"
        )
    except Exception as e:
        print(f"Error reading from {gpkg_url}: {e}")
        return False

    read_time = round(time.time() - t0, 1)
    print(f"Read {len(df)} census tracts in {read_time}s")

    if len(df) == 0:
        print(f"Warning: 0 features found for {code6} with CD_MUN = '{id7}'")
        return False

    # 3. Transform features
    base_income = UF_BASE_INCOME.get(uf, 2000.0)
    features = []

    for idx, row in df.iterrows():
        bairro_val = str(row['NM_BAIRRO']).strip() if pd.notna(row.get('NM_BAIRRO')) else (
            str(row['NM_DIST']).strip() if pd.notna(row.get('NM_DIST')) else 'Não informado'
        )
        pop = int(row['v0001']) if pd.notna(row.get('v0001')) else 0
        dom = int(row['v0007']) if pd.notna(row.get('v0007')) else 0
        morad = float(row['v0005']) if pd.notna(row.get('v0005')) else 2.6
        area = float(row['AREA_KM2']) if pd.notna(row.get('AREA_KM2')) else 0.0
        densidade = round(pop / area, 1) if area > 0 else 0.0

        factor = 1.0 - (morad - 2.6) * 0.45
        factor = max(0.4, min(3.0, factor))
        renda = round(base_income * factor, 2)

        props = {
            'cd_setor': str(row['CD_SETOR']),
            'nm_bairro': bairro_val,
            'situacao': str(row.get('SITUACAO', 'Urbana')),
            'cd_tipo': int(row['CD_TIPO']) if pd.notna(row.get('CD_TIPO')) else 0,
            'populacao': pop,
            'domicilios': dom,
            'moradores_por_domicilio': round(morad, 2),
            'area_km2': round(area, 4),
            'densidade_demografica': densidade,
            'renda_per_capita': renda
        }

        geom = row['geometry'].__geo_interface__
        geom['coordinates'] = round_coords(geom['coordinates'], 5)

        features.append({
            'type': 'Feature',
            'id': props['cd_setor'],
            'properties': props,
            'geometry': geom
        })

    total_pop = sum(f['properties']['populacao'] for f in features)
    fc = {
        'type': 'FeatureCollection',
        'metadata': {
            'municipality': city_info['name'],
            'uf': uf,
            'ibge_code': int(code6),
            'census_year': 2022,
            'total_tracts': len(features),
            'total_population': total_pop
        },
        'features': features
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False)

    size_kb = round(os.path.getsize(output_path) / 1024, 1)
    total_time = round(time.time() - t0, 1)
    print(f"Generated {output_path} ({len(features)} tracts, {total_pop:,} hab, {size_kb} KB in {total_time}s)")
    return True

def main():
    manifest_path = "playground/data/manifest.json"
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    success_count = 0
    total_cities = len(manifest)

    for code6, info in manifest.items():
        if process_city(code6, info):
            info['census_tracts'] = f"data/census_tracts/{code6}.geojson"
            success_count += 1

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\nAll done! Updated manifest with {success_count}/{total_cities} cities.")

if __name__ == '__main__':
    main()
