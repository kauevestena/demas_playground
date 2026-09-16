"""
demas_driver - Python driver for DEMAS / CNES Open Data API.
"""

from .core import retrieve_facilities
from .resolver import resolve_municipality_code

__version__ = "0.1.0"
__all__ = ["retrieve_facilities", "resolve_municipality_code"]
