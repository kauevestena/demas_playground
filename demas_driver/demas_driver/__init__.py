"""
demas_driver - Python driver for DEMAS / CNES Open Data API and Spatial-Demographic Analysis.
"""

from .core import retrieve_facilities
from .resolver import resolve_municipality_code
from .census import get_census_tracts, get_municipality_boundary, analyze_coverage
from .analysis import (
    compute_voronoi,
    compute_hexbins,
    enrich_cells_with_census,
    cluster_nearby_points,
    classify_1d
)

__version__ = "0.2.0"
__all__ = [
    "retrieve_facilities",
    "resolve_municipality_code",
    "get_census_tracts",
    "get_municipality_boundary",
    "analyze_coverage",
    "compute_voronoi",
    "compute_hexbins",
    "enrich_cells_with_census",
    "cluster_nearby_points",
    "classify_1d"
]
