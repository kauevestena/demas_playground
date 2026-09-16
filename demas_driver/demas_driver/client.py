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
    # 1. Determine first page to check responsiveness and estimate total records
    first_page = fetch_cnes_page(municipality_code, offset=0, limit=20, status=status, **kwargs)
    if not first_page:
        return []

    # Fast probe to detect upper offset limit
    probe_offsets = [20, 100, 300, 600, 1000, 1500, 2000]
    max_active_offset = 0

    for off in probe_offsets:
        res = fetch_cnes_page(municipality_code, offset=off, limit=1, status=status, **kwargs)
        if res:
            max_active_offset = off
        else:
            break

    # Estimate upper bound
    scan_limit = max_active_offset + 300

    all_dict = {}
    for item in first_page:
        all_dict[item["codigo_cnes"]] = item

    # Concurrently fetch in chunks of 20
    offsets = list(range(20, scan_limit, 20))
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
