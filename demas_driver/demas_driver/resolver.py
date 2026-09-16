"""
resolver.py - Resolve municipality name or input to a 6-digit IBGE code.
"""

import gzip
import json
import re
import unicodedata
import urllib.request

# Common municipal IBGE codes cache
KNOWN_MUNICIPALITIES = {
    "pato branco": 411850,
    "pato branco, pr": 411850,
    "curitiba": 410690,
    "curitiba, pr": 410690,
    "francisco beltrao": 410840,
    "francisco beltrão": 410840,
    "coronel vivida": 410640,
}

_IBGE_CACHE = None


def normalize_text(text: str) -> str:
    """Normalize text by lowercasing and removing accents."""
    text = unicodedata.normalize("NFKD", text.strip().lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def resolve_municipality_code(municipality) -> int:
    """
    Resolves a municipality input (name string, 7-digit or 6-digit IBGE code)
    to the 6-digit IBGE code required by the CNES API.
    """
    global _IBGE_CACHE

    if isinstance(municipality, int):
        # 7-digit code (e.g. 4118501) -> 6-digit (411850)
        return municipality // 10 if municipality > 999999 else municipality

    municipality_str = str(municipality).strip()
    if municipality_str.isdigit():
        code = int(municipality_str)
        return code // 10 if code > 999999 else code

    norm_name = normalize_text(municipality_str)
    if norm_name in KNOWN_MUNICIPALITIES:
        return KNOWN_MUNICIPALITIES[norm_name]

    # Attempt online resolution via official IBGE API
    try:
        if _IBGE_CACHE is None:
            url = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios"
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "demas_driver/1.0", "Accept-Encoding": "gzip, deflate"},
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                raw = r.read()
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                _IBGE_CACHE = json.loads(raw.decode("utf-8"))

        parts = [p.strip() for p in municipality_str.split(",")]
        target_name = normalize_text(parts[0])
        target_uf = normalize_text(parts[1]) if len(parts) > 1 else None

        for m in _IBGE_CACHE:
            m_name = normalize_text(m.get("nome", ""))
            m_uf = normalize_text(m.get("microrregiao", {}).get("mesorregiao", {}).get("UF", {}).get("sigla", ""))
            if m_name == target_name:
                if target_uf is None or target_uf == m_uf:
                    code = m.get("id") // 10
                    KNOWN_MUNICIPALITIES[norm_name] = code
                    return code
    except Exception:
        pass

    raise ValueError(f"Could not resolve municipality: '{municipality}'. Please provide a valid 6 or 7 digit IBGE code.")
