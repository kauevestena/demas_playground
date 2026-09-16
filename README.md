# DEMAS Playground

A monorepo with webmaps and the python library 'demas_driver'.

## Monorepo Structure

```text
demas_playground/
├── demas_driver/           # Python library to query DEMAS/CNES API and export to OSM/GeoJSON
│   ├── demas_driver/       # Package source code
│   │   ├── __init__.py     # Exposes `retrieve_facilities`
│   │   ├── client.py       # API client, binary search total detection & pagination
│   │   ├── osm.py          # OpenStreetMap tag mappings & categorization
│   │   └── resolver.py     # Municipality to IBGE code resolver
│   ├── pyproject.toml      # Package definition & metadata
│   └── README.md
├── playground/             # Multi-city interactive webmap with IBGE UF & Municipality picker
│   ├── index.html          # Dynamic interface with State/City selectors & proxy controls
│   ├── js/                 # JavaScript driver (demas_driver.js) & application logic
│   └── data/               # Pre-cached GeoJSON for all 27 State Capitals + Pato Branco
├── playground_prototype/   # Initial static prototype using MapLibre GL JS (Pato Branco)
│   ├── index.html          # Interactive map interface with hover highlights & category filters
│   └── data/               # Pato Branco GeoJSON dataset
├── cloudflare_worker/      # Free Cloudflare Worker CORS proxy for live CNES API querying
│   ├── worker.js           # Transparent reverse proxy with edge caching
│   ├── wrangler.toml       # Worker configuration
│   └── README.md           # 2-minute deployment guide
├── scripts/                # Utility scripts (e.g. cache_capitals.py)
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

### Web Playgrounds
Try the interactive applications online or run them locally:
- **Main Portal**: [https://kauevestena.github.io/demas_playground/](https://kauevestena.github.io/demas_playground/)
- **Multi-City Playground (Capitals & Live API)**: [https://kauevestena.github.io/demas_playground/playground/](https://kauevestena.github.io/demas_playground/playground/)
- **Initial Prototype (Pato Branco)**: [https://kauevestena.github.io/demas_playground/playground_prototype/](https://kauevestena.github.io/demas_playground/playground_prototype/)

To run locally with a simple web server:
```bash
python3 -m http.server 8000
```
Then visit:
- Main portal: [http://localhost:8000/](http://localhost:8000/)
- Multi-City playground: [http://localhost:8000/playground/](http://localhost:8000/playground/)
- Prototype: [http://localhost:8000/playground_prototype/](http://localhost:8000/playground_prototype/)

## License
MIT License
