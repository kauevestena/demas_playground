# DEMAS Playground

A monorepo with webmaps and the python library 'demas_driver'.

## Monorepo Structure

```text
demas_playground/
├── demas_driver/           # Python library to query DEMAS/CNES API and export to OSM/GeoJSON
│   ├── demas_driver/       # Package source code
│   │   ├── __init__.py     # Exposes `retrieve_facilities`
│   │   ├── client.py       # API client & pagination handling
│   │   ├── osm.py          # OpenStreetMap tag mappings & categorization
│   │   └── resolver.py     # Municipality to IBGE code resolver
│   ├── pyproject.toml      # Package definition & metadata
│   └── README.md
├── playground_prototype/   # Interactive web playground using MapLibre GL JS
│   ├── index.html          # Interactive map interface with hover highlights & category filters
│   └── data/               # GeoJSON datasets with OSM tags & comment classifications
├── LICENSE                 # MIT License
└── README.md
```

## Quickstart

### Python Library (`demas_driver`)
```python
from demas_driver import retrieve_facilities

# Query facilities in Pato Branco (by IBGE code or municipality name)
geojson = retrieve_facilities(municipality="Pato Branco", output_format="osm")

# Or fetch raw CNES records
records = retrieve_facilities(municipality=411850, output_format="raw", public_only=True)
```

### Web Playground
Open `playground_prototype/index.html` in your browser or run a simple local web server:
```bash
python3 -m http.server 8000 --directory playground_prototype
```

## License
MIT License
