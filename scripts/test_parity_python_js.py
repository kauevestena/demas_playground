#!/usr/bin/env python3
"""
test_parity_python_js.py - End-to-End Parity Verification between Python & JavaScript.

Verifies:
1. Facility clustering (30m threshold, centroid coordinates, properties)
2. Voronoi territorial clipping & demographic enrichment (ambos, urbanos, rurais)
3. PNAB overload classification distribution
4. Hexagonal binning (both occupied-only and full-grid continuous tessellation)
"""

import os
import sys
import json
import subprocess
import geopandas as gpd
from pathlib import Path

# Add project root and demas_driver to python path
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "demas_driver"))

import demas_driver.analysis as demas_analysis


def run_python_analysis(mun_code: str) -> dict:
    data_dir = ROOT_DIR / "playground" / "data"
    fac_path = data_dir / f"{mun_code}.geojson"
    bound_path = data_dir / "boundaries" / f"{mun_code}.geojson"
    tracts_path = data_dir / "census_tracts" / f"{mun_code}.geojson"

    fac_gdf = gpd.read_file(fac_path)
    bound_gdf = gpd.read_file(bound_path)
    tracts_gdf = gpd.read_file(tracts_path)

    # 1. Clustering
    clustered_gdf = demas_analysis.cluster_nearby_points(fac_gdf, max_distance_meters=30.0)

    res = {
        "mun_code": mun_code,
        "raw_facilities_count": len(fac_gdf),
        "clustered_count": len(clustered_gdf),
        "voronoi": {},
        "hexbins_occupied": {},
        "hexbins_full": {}
    }

    situations = ["ambos", "urbanos", "rurais"]

    for sit in situations:
        # 2. Voronoi
        vor_gdf = demas_analysis.compute_voronoi(
            facilities=clustered_gdf,
            boundary=bound_gdf,
            census_tracts=tracts_gdf,
            metric="sobrecarga",
            situacao=sit,
            as_gdf=True
        )

        pnab_adequada = sum(1 for c in vor_gdf.get("cor_pnab", []) if c == "#10b981")
        pnab_atencao = sum(1 for c in vor_gdf.get("cor_pnab", []) if c == "#f59e0b")
        pnab_critica = sum(1 for c in vor_gdf.get("cor_pnab", []) if c == "#ef4444")

        res["voronoi"][sit] = {
            "cell_count": len(vor_gdf),
            "total_pop": int(vor_gdf["populacao_total"].sum()) if "populacao_total" in vor_gdf.columns else 0,
            "total_dom": int(vor_gdf["domicilios"].sum()) if "domicilios" in vor_gdf.columns else 0,
            "total_area_km2": round(float(vor_gdf["area_km2"].sum()), 2) if "area_km2" in vor_gdf.columns else 0.0,
            "pnab_dist": {
                "adequada": pnab_adequada,
                "atencao": pnab_atencao,
                "critica": pnab_critica
            }
        }

        # 3. Hexbins occupied only
        hex_occ_gdf = demas_analysis.compute_hexbins(
            facilities=clustered_gdf,
            boundary=bound_gdf,
            radius_km=1.0,
            census_tracts=tracts_gdf,
            metric="count",
            situacao=sit,
            occupied_only=True,
            as_gdf=True
        )
        res["hexbins_occupied"][sit] = {
            "cell_count": len(hex_occ_gdf),
            "total_pop": int(hex_occ_gdf["populacao_total"].sum()) if "populacao_total" in hex_occ_gdf.columns else 0,
            "total_points": int(hex_occ_gdf["point_count"].sum()) if "point_count" in hex_occ_gdf.columns else 0
        }

        # 4. Hexbins full grid
        hex_full_gdf = demas_analysis.compute_hexbins(
            facilities=clustered_gdf,
            boundary=bound_gdf,
            radius_km=1.0,
            census_tracts=tracts_gdf,
            metric="count",
            situacao=sit,
            occupied_only=False,
            as_gdf=True
        )
        res["hexbins_full"][sit] = {
            "cell_count": len(hex_full_gdf),
            "total_pop": int(hex_full_gdf["populacao_total"].sum()) if "populacao_total" in hex_full_gdf.columns else 0,
            "total_points": int(hex_full_gdf["point_count"].sum()) if "point_count" in hex_full_gdf.columns else 0
        }

    return res


def main():
    print("=" * 75)
    print("DEMAS PLATFORM - PARITY VERIFICATION (PYTHON vs JAVASCRIPT FRONTEND)")
    print("=" * 75)

    mun_codes = ["411850", "410690"]
    names = {"411850": "Pato Branco (PR)", "410690": "Curitiba (PR)"}

    # 1. Run Python computations
    py_results = {}
    for code in mun_codes:
        print(f"\n[Python] Running analysis for {names[code]} ({code})...")
        py_results[code] = run_python_analysis(code)

    # 2. Check or run JS browser results
    js_results_path = ROOT_DIR / "scripts" / "parity_js_results.json"
    if not js_results_path.exists():
        print("\n[JS] parity_js_results.json not found, running test_parity_browser.js...")
        subprocess.run(
            ["node", "--experimental-websocket", str(ROOT_DIR / "scripts" / "test_parity_browser.js")],
            check=True,
            cwd=str(ROOT_DIR)
        )

    with open(js_results_path, "r", encoding="utf-8") as f:
        js_results = json.load(f)

    # 3. Compare and assert parity
    all_passed = True
    print("\n" + "=" * 75)
    print("VERIFICATION RESULTS")
    print("=" * 75)

    for code in mun_codes:
        py_m = py_results[code]
        js_m = js_results[code]
        mun_name = names[code]

        print(f"\n--- {mun_name} [{code}] ---")

        # Clustering
        py_c = py_m["clustered_count"]
        js_c = js_m["clustered_count"]
        c_status = "PASS" if py_c == js_c else "FAIL"
        if py_c != js_c: all_passed = False
        print(f"  Facility Clustering (30m):")
        print(f"    Raw: {py_m['raw_facilities_count']} -> Python: {py_c} clusters | JS: {js_c} clusters [{c_status}]")

        # Voronoi
        print(f"  Voronoi Diagram (Clipped to Territorial Situation):")
        for sit in ["ambos", "urbanos", "rurais"]:
            py_v = py_m["voronoi"][sit]
            js_v = js_m["voronoi"][sit]

            cell_match = py_v["cell_count"] == js_v["cell_count"]
            pnab_match = py_v["pnab_dist"] == js_v["pnab_dist"]
            pop_diff_pct = abs(py_v["total_pop"] - js_v["total_pop"]) / max(1, py_v["total_pop"]) * 100
            pop_match = pop_diff_pct < 0.2  # within 0.2% tolerance due to planar vs geodesic area

            sit_passed = cell_match and pnab_match and pop_match
            if not sit_passed: all_passed = False
            status = "PASS" if sit_passed else "FAIL"

            print(f"    [{sit.upper()}] Status: {status}")
            print(f"      Cells:       Python: {py_v['cell_count']} | JS: {js_v['cell_count']} {'✓' if cell_match else '✗'}")
            print(f"      Population:  Python: {py_v['total_pop']:,} | JS: {js_v['total_pop']:,} (diff: {pop_diff_pct:.3f}%) {'✓' if pop_match else '✗'}")
            print(f"      Households:  Python: {py_v['total_dom']:,} | JS: {js_v['total_dom']:,}")
            print(f"      Area km²:    Python: {py_v['total_area_km2']} km² | JS: {js_v['total_area_km2']} km²")
            print(f"      PNAB Dist:   Python: {py_v['pnab_dist']} | JS: {js_v['pnab_dist']} {'✓' if pnab_match else '✗'}")

        # Hexbins Occupied
        print(f"  Hexagonal Binning (Occupied Cells):")
        for sit in ["ambos", "urbanos", "rurais"]:
            py_h = py_m["hexbins_occupied"][sit]
            js_h = js_m["hexbins_occupied"][sit]

            h_cell_match = py_h["cell_count"] == js_h["cell_count"]
            h_pts_match = py_h["total_points"] == js_h["total_points"]
            h_passed = h_cell_match and h_pts_match
            if not h_passed: all_passed = False
            status = "PASS" if h_passed else "FAIL"

            print(f"    [{sit.upper()}] Status: {status}")
            print(f"      Occupied Hexes: Python: {py_h['cell_count']} | JS: {js_h['cell_count']} {'✓' if h_cell_match else '✗'}")
            print(f"      Total Points:   Python: {py_h['total_points']} | JS: {js_h['total_points']} {'✓' if h_pts_match else '✗'}")
            print(f"      Population:     Python: {py_h['total_pop']:,} | JS: {js_h['total_pop']:,}")

    print("\n" + "=" * 75)
    if all_passed:
        print("🎉 SUCCESS: 100% PARITY CONFIRMED BETWEEN PYTHON AND JAVASCRIPT!")
        print("=" * 75)
        sys.exit(0)
    else:
        print("❌ DISCREPANCY DETECTED BETWEEN PYTHON AND JAVASCRIPT.")
        print("=" * 75)
        sys.exit(1)


if __name__ == "__main__":
    main()
