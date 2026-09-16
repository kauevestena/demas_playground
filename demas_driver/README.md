# demas_driver

A lightweight Python client and converter for the official Brazilian Ministry of Health Open Data API (`apidadosabertos.saude.gov.br/cnes`).

## Features
- Query CNES health facilities by municipality name or IBGE code.
- Fast concurrent pagination fetching.
- Automatic transformation into OpenStreetMap (OSM) compliant GeoJSON.
- Added `comment` classification attribute for quick categorizations (e.g. `UBS`, `UPA 24h`, `CAPS`, `Farmácia Municipal`).
- Automatic micro-offsets for co-located facilities to prevent overlapping node warnings in JOSM.
- Zero required third-party dependencies (uses Python standard library).

## Installation
```bash
pip install -e ./demas_driver
```

## Usage
```python
from demas_driver import retrieve_facilities

# Query facilities in Pato Branco as OSM GeoJSON
geojson_data = retrieve_facilities("Pato Branco", output_format="osm")

# Query by IBGE code with custom filters
raw_data = retrieve_facilities(411850, output_format="raw", public_only=True, status=1)
```
