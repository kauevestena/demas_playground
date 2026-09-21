"""
test_python_census_api.py - Verification script for demas_driver Census & Spatial Analysis.
"""

import time
import json
from demas_driver import (
    retrieve_facilities,
    resolve_municipality_code,
    get_census_tracts,
    get_municipality_boundary,
    compute_voronoi,
    compute_hexbins,
    analyze_coverage,
    cluster_nearby_points,
    classify_1d
)

def test_census_retrieval():
    print("\n--- 1. Testing Census Tract Retrieval (Parquet Fast-Path) ---")
    
    # Curitiba
    t0 = time.time()
    cwb_tracts = get_census_tracts("Curitiba, PR", as_gdf=True)
    t_cwb = (time.time() - t0) * 1000
    print(f"Curitiba: {len(cwb_tracts)} tracts in {t_cwb:.1f}ms")
    assert len(cwb_tracts) > 3000, "Expected > 3000 tracts for Curitiba"
    assert "populacao" in cwb_tracts.columns, "Expected 'populacao' in columns"
    assert "pct_agua_encanada" in cwb_tracts.columns, "Expected 'pct_agua_encanada' in columns"
    assert "renda_per_capita" in cwb_tracts.columns, "Expected 'renda_per_capita' in columns"

    # Pato Branco
    t0 = time.time()
    pb_tracts = get_census_tracts(411850, as_gdf=True)
    t_pb = (time.time() - t0) * 1000
    print(f"Pato Branco: {len(pb_tracts)} tracts in {t_pb:.1f}ms")
    assert len(pb_tracts) > 100, "Expected > 100 tracts for Pato Branco"

    # GeoJSON output format
    t0 = time.time()
    pb_json = get_census_tracts(411850, as_gdf=False)
    assert pb_json["type"] == "FeatureCollection"
    print(f"GeoJSON output verified ({len(pb_json['features'])} features)")


def test_spatial_analysis_pato_branco():
    print("\n--- 2. Testing End-to-End Analysis for Pato Branco (PR) ---")
    
    # 1. Facilities
    facilities = retrieve_facilities(411850, public_only=True)
    print(f"Retrieved {len(facilities['features'])} public healthcare facilities.")
    assert len(facilities['features']) > 5, "Expected public facilities in Pato Branco"

    # 2. Point clustering
    clustered = cluster_nearby_points(facilities, max_distance_meters=30)
    print(f"Clustering with 30m threshold: {len(facilities['features'])} -> {len(clustered['features'])} facilities")

    # 3. Boundary
    boundary = get_municipality_boundary(411850)
    print(f"Boundary retrieved with {len(boundary)} feature(s)")

    # 4. Census tracts
    tracts = get_census_tracts(411850)

    # 5. Voronoi with Census Enrichment & Population Metric
    t0 = time.time()
    vor_gdf = compute_voronoi(
        facilities=facilities,
        boundary=boundary,
        census_tracts=tracts,
        metric="population",
        cluster_distance_m=20.0,
        classification_method="jenks",
        n_classes=5,
        as_gdf=True
    )
    t_vor = (time.time() - t0) * 1000
    print(f"Voronoi generated: {len(vor_gdf)} cells in {t_vor:.1f}ms")
    assert "populacao_total" in vor_gdf.columns
    assert "sobrecarga_pnab" in vor_gdf.columns
    assert "cor_pnab" in vor_gdf.columns
    assert "color" in vor_gdf.columns

    total_alloc_pop = vor_gdf["populacao_total"].sum()
    print(f"Total allocated population across Voronoi cells: {total_alloc_pop:,} hab.")
    assert total_alloc_pop > 70000, f"Expected > 70k population for Pato Branco, got {total_alloc_pop}"

    # Check PNAB overload categories
    pnab_dist = vor_gdf["classificacao_pnab"].value_counts().to_dict()
    print("PNAB Overload Distribution:", pnab_dist)

    # 6. Hexbins with Census Enrichment & Sanitation Metric
    t0 = time.time()
    hex_gdf = compute_hexbins(
        facilities=facilities,
        boundary=boundary,
        radius_km=1.5,
        census_tracts=tracts,
        metric="saneamento_esgoto",
        classification_method="quantiles",
        n_classes=5,
        as_gdf=True
    )
    t_hex = (time.time() - t0) * 1000
    print(f"Hexbins generated: {len(hex_gdf)} hexagons (1.5km radius) in {t_hex:.1f}ms")
    assert "pct_esgoto_coletado" in hex_gdf.columns
    assert "point_count" in hex_gdf.columns


def test_analyze_coverage_convenience():
    print("\n--- 3. Testing analyze_coverage() One-Liner API ---")
    t0 = time.time()
    # High-level one-liner
    result = analyze_coverage(
        "Pato Branco, PR",
        mode="voronoi",
        metric="population",
        as_gdf=True
    )
    t_total = (time.time() - t0) * 1000
    print(f"analyze_coverage() completed in {t_total:.1f}ms with {len(result)} enriched cells!")
    assert len(result) > 5


def test_1d_classification():
    print("\n--- 4. Testing 1D Statistical Classification ---")
    data = [1200, 1850, 2400, 3100, 4800, 5200, 7800, 9500, 14200]
    
    jenks = classify_1d(data, method="jenks", k=3, unit="hab.")
    print("Jenks breaks:", jenks["breaks"])
    print("Jenks labels:", jenks["labels"])
    assert len(jenks["breaks"]) == 4
    assert len(jenks["colors"]) == 3

    quant = classify_1d(data, method="quantiles", k=4, unit="R$")
    print("Quantile breaks:", quant["breaks"])
    print("Quantile labels:", quant["labels"])
    assert len(quant["breaks"]) == 5


if __name__ == "__main__":
    test_census_retrieval()
    test_spatial_analysis_pato_branco()
    test_analyze_coverage_convenience()
    test_1d_classification()
    print("\n>>> ALL TESTS PASSED SUCCESSFULLY! <<<")
