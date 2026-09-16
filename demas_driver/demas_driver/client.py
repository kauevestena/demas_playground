"""
client.py - API client for CNES / DEMAS Dados Abertos.
"""

import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = "https://apidadosabertos.saude.gov.br/cnes/estabelecimentos"


def fetch_cnes_page(municipality_code: int, offset: int, limit: int = 20, **kwargs) -> list:
    """Fetch a single page of establishments from CNES API."""
    params = {
        "codigo_municipio": municipality_code,
        "offset": offset,
        "limit": limit,
    }
    # Pass additional query parameters from kwargs
    for k, v in kwargs.items():
        if v is not None and k not in ("public_only", "max_workers", "output_file", "use_cache"):
            params[k] = v

    url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "demas_driver/1.0", "Accept": "application/json"},
    )

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("estabelecimentos", [])
        except Exception:
            time.sleep(0.4 * (attempt + 1))

    return []


def fetch_all_establishments(
    municipality_code: int,
    status: int = 1,
    max_workers: int = 12,
    **kwargs,
) -> list:
    """
    Fetches all active establishments for the given municipality code using concurrent requests.
    """
    # 1. Determine first page to check responsiveness
    first_page = fetch_cnes_page(municipality_code, offset=0, limit=20, status=status, **kwargs)
    if not first_page:
        return []

    # If first page has fewer than 20 items, we already have all records
    if len(first_page) < 20:
        return first_page

    # 2. Binary search to accurately find total number of records
    high = 100
    while True:
        if fetch_cnes_page(municipality_code, offset=high, limit=1, status=status, **kwargs):
            high *= 2
        else:
            break

    low = high // 2
    while low < high:
        mid = (low + high) // 2
        if fetch_cnes_page(municipality_code, offset=mid, limit=1, status=status, **kwargs):
            low = mid + 1
        else:
            high = mid

    total_records = low

    all_dict = {}
    for item in first_page:
        all_dict[item["codigo_cnes"]] = item

    # Concurrently fetch in chunks of 20
    offsets = list(range(20, total_records, 20))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(fetch_cnes_page, municipality_code, off, 20, status=status, **kwargs): off
            for off in offsets
        }
        for f in as_completed(futures):
            items = f.result()
            for it in items:
                all_dict[it["codigo_cnes"]] = it

    return list(all_dict.values())
