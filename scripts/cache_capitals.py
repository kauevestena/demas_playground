#!/usr/bin/env python3
"""
scripts/cache_capitals.py - Pre-fetches and caches Brazilian state capitals + Pato Branco
as GeoJSON files in `playground/data/` and builds `manifest.json`.
"""

import json
import os
import sys
import time
from pathlib import Path

# Add demas_driver to python path
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "demas_driver"))

from demas_driver import retrieve_facilities

# 27 Capitals + Pato Branco
TARGET_CITIES = [
    {"code6": 411850, "name": "Pato Branco", "uf": "PR"},
    {"code6": 120040, "name": "Rio Branco", "uf": "AC"},
    {"code6": 270430, "name": "Maceió", "uf": "AL"},
    {"code6": 160030, "name": "Macapá", "uf": "AP"},
    {"code6": 130260, "name": "Manaus", "uf": "AM"},
    {"code6": 292740, "name": "Salvador", "uf": "BA"},
    {"code6": 230440, "name": "Fortaleza", "uf": "CE"},
    {"code6": 530010, "name": "Brasília", "uf": "DF"},
    {"code6": 320530, "name": "Vitória", "uf": "ES"},
    {"code6": 520870, "name": "Goiânia", "uf": "GO"},
    {"code6": 211130, "name": "São Luís", "uf": "MA"},
    {"code6": 510340, "name": "Cuiabá", "uf": "MT"},
    {"code6": 500270, "name": "Campo Grande", "uf": "MS"},
    {"code6": 310620, "name": "Belo Horizonte", "uf": "MG"},
    {"code6": 150140, "name": "Belém", "uf": "PA"},
    {"code6": 250750, "name": "João Pessoa", "uf": "PB"},
    {"code6": 410690, "name": "Curitiba", "uf": "PR"},
    {"code6": 261160, "name": "Recife", "uf": "PE"},
    {"code6": 221100, "name": "Teresina", "uf": "PI"},
    {"code6": 330455, "name": "Rio de Janeiro", "uf": "RJ"},
    {"code6": 240810, "name": "Natal", "uf": "RN"},
    {"code6": 431490, "name": "Porto Alegre", "uf": "RS"},
    {"code6": 110020, "name": "Porto Velho", "uf": "RO"},
    {"code6": 140010, "name": "Boa Vista", "uf": "RR"},
    {"code6": 420540, "name": "Florianópolis", "uf": "SC"},
    {"code6": 355030, "name": "São Paulo", "uf": "SP"},
    {"code6": 280030, "name": "Aracaju", "uf": "SE"},
    {"code6": 172100, "name": "Palmas", "uf": "TO"},
]

OUTPUT_DIR = REPO_ROOT / "playground" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
MANIFEST_FILE = OUTPUT_DIR / "manifest.json"


def update_manifest():
    manifest = {}
    for city in TARGET_CITIES:
        code = str(city["code6"])
        file_path = OUTPUT_DIR / f"{code}.geojson"
        if file_path.exists() and file_path.stat().st_size > 0:
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                features = data.get("features", [])
                
                # Compute centroid/average bbox for map centering
                valid_coords = [
                    f["geometry"]["coordinates"]
                    for f in features
                    if f.get("geometry") and f["geometry"].get("coordinates")
                ]
                if valid_coords:
                    avg_lon = sum(c[0] for c in valid_coords) / len(valid_coords)
                    avg_lat = sum(c[1] for c in valid_coords) / len(valid_coords)
                    center = [round(avg_lon, 6), round(avg_lat, 6)]
                else:
                    center = None

                manifest[code] = {
                    "code": city["code6"],
                    "name": city["name"],
                    "uf": city["uf"],
                    "filename": f"{code}.geojson",
                    "count": len(features),
                    "center": center,
                }
            except Exception as e:
                print(f"Error parsing {file_path}: {e}")

    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"Updated manifest.json with {len(manifest)} cached cities.")


def main():
    print(f"=== Caching {len(TARGET_CITIES)} Target Municipalities ===")
    
    for idx, city in enumerate(TARGET_CITIES, 1):
        code = city["code6"]
        name = city["name"]
        uf = city["uf"]
        file_path = OUTPUT_DIR / f"{code}.geojson"

        needs_fetch = True
        if code == 411850 and file_path.exists() and file_path.stat().st_size > 500:
            needs_fetch = False
        elif file_path.exists() and file_path.stat().st_size > 500:
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    sample_data = json.load(f)
                f0 = sample_data.get("features", [{}])[0]
                coords = f0.get("geometry", {}).get("coordinates", [])
                # If first feature is not the bogus pato branco center, we can keep it
                if coords and not (round(coords[0], 3) == -52.672 and round(coords[1], 3) == -26.230):
                    needs_fetch = False
            except Exception:
                needs_fetch = True

        if not needs_fetch:
            print(f"[{idx}/{len(TARGET_CITIES)}] Skip valid existing: {name} ({uf}) - {code}")
            continue

        print(f"[{idx}/{len(TARGET_CITIES)}] Fetching {name} ({uf}) - {code}...")
        t0 = time.time()
        try:
            geojson = retrieve_facilities(
                municipality=code,
                municipality_name=name,
                uf_sigla=uf,
                output_format="osm",
                max_workers=20,
            )
            count = len(geojson.get("features", []))
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(geojson, f, ensure_ascii=False, indent=2)
            elapsed = round(time.time() - t0, 2)
            print(f"   -> Done: {count} facilities in {elapsed}s")
            update_manifest()
        except Exception as err:
            print(f"   -> Failed for {name}: {err}")

        # Short pause between cities to be gentle with the federal API
        time.sleep(1.0)

    update_manifest()
    print("=== Caching process complete ===")


if __name__ == "__main__":
    main()
