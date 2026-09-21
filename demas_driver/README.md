# demas_driver

A lightweight and extensible Python library to query the official Brazilian Ministry of Health Open Data API (`apidadosabertos.saude.gov.br/cnes`), retrieve decoupled IBGE Censo 2022 census tracts, and perform advanced geospatial-demographic analysis (Voronoi catchment areas, Hexagonal binning, areal interpolation, and PNAB overload evaluation).

---

## Features

### 1. Healthcare Facilities Retrieval (CNES / DEMAS)
- Query CNES health facilities by municipality name (e.g. `"Curitiba"`, `"São Paulo, SP"`) or IBGE code (`411850`).
- Fast concurrent pagination fetching.
- Automatic transformation into OpenStreetMap (OSM) compliant GeoJSON.
- Automatic categorization tag (`comment`: `UBS`, `UPA 24h`, `CAPS`, `Hospital`, `Farmácia Municipal`, etc.).
- Micro-offsets for co-located facilities to prevent overlapping node warnings.

### 2. Tiered Censo 2022 Tract Retrieval
- **Tier 1 (Fast Parquet)**: Sub-50ms queries over decoupled Parquet datasets (`geom/{UF}.parquet` + thematic attribute tables: `censo_basico`, `censo_renda`, `censo_saneamento`).
- **Tier 2 (On-Demand IBGE Direct)**: Dynamic remote query over IBGE FTP via `/vsicurl/` with spatial bounding box filter for any of Brazil's 5,570 municipalities, with automatic local Parquet caching (`~/.cache/demas/parquet/`).

### 3. Spatial & Demographic Analysis
- **Point Clustering**: Proximate facility aggregation (e.g. 10m to 100m) using KDTree and connected components.
- **Voronoi / Thiessen Diagrams**: Generator-matched Voronoi cells strictly clipped to official municipal boundaries.
- **Hexagonal Bins (Hexbins)**: Regular hexagonal binning at configurable radii (500m, 1km, 5km, etc.).
- **Areal Weighting Interpolation**: Exact geometric polygon intersection allocating tract populations, households, population-weighted income, and sanitation indicators (water, sewage).
- **PNAB Overload Index**: Evaluates facility population load against the official Family Health Team (*Saúde da Família*) standard threshold (3,500 hab/team), classifying cells into *Adequada*, *Atenção*, or *Crítica*.
- **1D Statistical Classification**: Jenks Natural Breaks (Fisher-Ckmeans), Quantiles, Equal Interval, and Standard Deviation.

---

## Installation

### Core (Zero Dependencies)
```bash
pip install -e ./demas_driver
```

### With Geospatial & Analysis Engine
```bash
pip install -e "./demas_driver[geo]"
```

---

## Quickstart

### 1. Facilities Retrieval
```python
from demas_driver import retrieve_facilities

# Query public facilities in Pato Branco as OSM GeoJSON
geojson_data = retrieve_facilities("Pato Branco, PR", output_format="osm", public_only=True)
```

### 2. Censo 2022 Census Tracts
```python
from demas_driver import get_census_tracts

# Automatically uses Parquet cache if available, or fetches from IBGE on-demand
tracts_gdf = get_census_tracts("Curitiba, PR", as_gdf=True)
print(f"Loaded {len(tracts_gdf)} census tracts with demographic attributes.")
```

### 3. Voronoi Coverage & PNAB Overload Analysis
```python
from demas_driver import (
    retrieve_facilities,
    get_municipality_boundary,
    get_census_tracts,
    compute_voronoi
)

code = "Pato Branco, PR"
facilities = retrieve_facilities(code, public_only=True)
boundary = get_municipality_boundary(code)
tracts = get_census_tracts(code)

# Compute Voronoi cells enriched with Censo 2022 and PNAB overload
voronoi_gdf = compute_voronoi(
    facilities=facilities,
    boundary=boundary,
    census_tracts=tracts,
    metric="population",
    cluster_distance_m=20.0
)

print(voronoi_gdf[["facility_name", "populacao_total", "sobrecarga_pnab", "classificacao_pnab"]])
```

### 4. Hexagonal Binning (Hexbins)
```python
from demas_driver import compute_hexbins

hexbins_gdf = compute_hexbins(
    facilities=facilities,
    boundary=boundary,
    radius_km=1.5,
    census_tracts=tracts,
    metric="saneamento_esgoto"
)
```

### 5. High-Level One-Liner (`analyze_coverage`)
```python
from demas_driver import analyze_coverage

# Automatically fetches facilities, boundary, and tracts, and performs analysis:
result_gdf = analyze_coverage("São Paulo, SP", mode="voronoi", metric="population")
```
