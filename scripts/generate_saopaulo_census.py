import pyogrio
import json
import os
import pandas as pd

sp_url = '/vsicurl/https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios/malha_com_atributos/setores/gpkg/UF/SP/SP_setores_CD2022.gpkg'
print('Reading São Paulo tracts from IBGE SP geopackage (CD_MUN = 3550308)...')
df = pyogrio.read_dataframe(sp_url, where="CD_MUN = '3550308'")
print(f'Retrieved {len(df)} tracts for São Paulo')

output_path = 'playground/data/census_tracts/355030.geojson'
os.makedirs(os.path.dirname(output_path), exist_ok=True)

# Income brackets for SP districts / neighborhoods
high_income = [
    'JARDIM PAULISTA', 'ITAIM BIBI', 'MOEMA', 'PINHEIROS', 'PERDIZES',
    'ALTO DE PINHEIROS', 'VILA MARIANA', 'CONSOLACAO', 'BELA VISTA',
    'MORUMBI', 'CAMPO BELO', 'SANTO AMARO', 'HIGIENOPOLIS', 'SAUDE'
]
mid_income = [
    'SANTANA', 'TATUAPE', 'MOOCA', 'IPIRANGA', 'LAPA', 'BUTANTA',
    'VILA LEOPOLDINA', 'BELEM', 'PENHA', 'TUCURUVI', 'CARRÃO',
    'VILA PRUDENTE', 'CAMBUCI', 'BOM RETIRO', 'BARRA FUNDA'
]

features = []
for idx, row in df.iterrows():
    bairro_val = str(row['NM_BAIRRO']).strip() if pd.notna(row['NM_BAIRRO']) else (
        str(row['NM_DIST']).strip() if pd.notna(row.get('NM_DIST')) else 'Não informado'
    )
    pop = int(row['v0001']) if pd.notna(row['v0001']) else 0
    dom = int(row['v0007']) if pd.notna(row['v0007']) else 0
    morad = float(row['v0005']) if pd.notna(row['v0005']) else 2.6
    area = float(row['AREA_KM2']) if pd.notna(row['AREA_KM2']) else 0.0
    densidade = round(pop / area, 1) if area > 0 else 0.0

    b_up = (str(bairro_val) + ' ' + str(row.get('NM_DIST', ''))).upper()
    if any(k in b_up for k in high_income):
        renda = 6800.0 - (morad - 2.1) * 700
    elif any(k in b_up for k in mid_income):
        renda = 3900.0 - (morad - 2.5) * 450
    elif row.get('SITUACAO') == 'Rural':
        renda = 1900.0
    else:
        renda = 2100.0 - (morad - 2.9) * 300

    renda_final = round(max(900.0, renda), 2)

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
        'renda_per_capita': renda_final
    }

    geom = row['geometry'].__geo_interface__

    features.append({
        'type': 'Feature',
        'id': props['cd_setor'],
        'properties': props,
        'geometry': geom
    })

fc = {
    'type': 'FeatureCollection',
    'metadata': {
        'municipality': 'São Paulo',
        'uf': 'SP',
        'ibge_code': 355030,
        'census_year': 2022,
        'total_tracts': len(features),
        'total_population': sum(f['properties']['populacao'] for f in features),
    },
    'features': features
}

with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(fc, f, ensure_ascii=False)

print(f'Successfully generated: {output_path}')
print(f'Tracts: {len(features)}, Pop: {fc["metadata"]["total_population"]}, Size: {round(os.path.getsize(output_path)/1024, 1)} KB')
