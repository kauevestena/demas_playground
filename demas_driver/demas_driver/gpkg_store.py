"""
gpkg_store.py - Transactional GeoPackage & GeoParquet Storage Engine for DEMAS Pipeline.

Features:
- Atomic Single-Writer transactions for GeoPackage layers.
- Automatic spatial table registration and CRS management.
- Batch cleanup of prior partial states before saving new results.
- Post-processing crystallization to partitioned GeoParquet.
"""

import json
import sqlite3
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional

import geopandas as gpd
import pandas as pd
import pyogrio
from shapely.geometry import Point, Polygon, MultiPolygon

from .checkpoints import (
    get_db_connection,
    init_checkpoints_table,
    cleanup_partial_municipality,
    mark_checkpoint_completed
)

logger = logging.getLogger("demas_driver.gpkg_store")


class GeoPackageStore:
    def __init__(self, gpkg_path: Path):
        self.gpkg_path = Path(gpkg_path)
        self.gpkg_path.parent.mkdir(parents=True, exist_ok=True)
        self._layer_fields_cache: Dict[str, List[str]] = {}
        self._ensure_gpkg_initialized()

    def _get_layer_fields(self, layer_name: str) -> Optional[List[str]]:
        if layer_name in self._layer_fields_cache:
            return self._layer_fields_cache[layer_name]
        try:
            info = pyogrio.read_info(self.gpkg_path, layer=layer_name)
            fields = list(info["fields"])
            self._layer_fields_cache[layer_name] = fields
            return fields
        except Exception:
            return None

    def _ensure_gpkg_initialized(self) -> None:
        """Ensure valid OGC GeoPackage file exists before adding SQLite tables."""
        if not self.gpkg_path.exists() or self.gpkg_path.stat().st_size == 0:
            from shapely.geometry import Point
            dummy = gpd.GeoDataFrame({"id": [0]}, geometry=[Point(0, 0)], crs="EPSG:4326")
            pyogrio.write_dataframe(dummy, self.gpkg_path, layer="_init", driver="GPKG")
            conn = get_db_connection(self.gpkg_path)
            with conn:
                conn.execute("DROP TABLE IF EXISTS _init;")
                conn.execute("DELETE FROM gpkg_contents WHERE table_name = '_init';")
                conn.execute("DELETE FROM gpkg_geometry_columns WHERE table_name = '_init';")
            conn.close()

        conn = get_db_connection(self.gpkg_path)
        with conn:
            init_checkpoints_table(conn)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS municipios_resumo (
                    cd_mun INTEGER PRIMARY KEY,
                    id7 INTEGER NOT NULL,
                    nome_mun TEXT NOT NULL,
                    uf TEXT NOT NULL,
                    pop_total INTEGER DEFAULT 0,
                    pop_urbana INTEGER DEFAULT 0,
                    pop_rural INTEGER DEFAULT 0,
                    n_estabelecimentos INTEGER DEFAULT 0,
                    n_polos INTEGER DEFAULT 0,
                    qtd_equipes_esf INTEGER DEFAULT 0,
                    qtd_equipes_eap INTEGER DEFAULT 0,
                    qtd_equipes_total INTEGER DEFAULT 0,
                    capacidade_pnab_total INTEGER DEFAULT 0,
                    sobrecarga_pnab_media REAL DEFAULT 0.0,
                    n_polos_adequada INTEGER DEFAULT 0,
                    n_polos_atencao INTEGER DEFAULT 0,
                    n_polos_critica INTEGER DEFAULT 0,
                    pop_em_sobrecarga_critica INTEGER DEFAULT 0,
                    pct_pop_critica REAL DEFAULT 0.0,
                    area_total_km2 REAL DEFAULT 0.0,
                    area_urbana_km2 REAL DEFAULT 0.0,
                    area_rural_km2 REAL DEFAULT 0.0,
                    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_resumo_uf ON municipios_resumo(uf);")
        conn.close()

    def save_municipality_bundle(self, bundle: Dict[str, Any]) -> None:
        """
        Atomically save a processed municipality bundle into the GeoPackage:
        1. Purge any previous records for this municipality.
        2. Append spatial layers (polos, voronoi_ambos, voronoi_urbanos, voronoi_rurais).
        3. Insert summary metrics into municipios_resumo.
        4. Mark checkpoint completed.
        """
        cd_mun = bundle["cd_mun"]

        # Step 1: Purge previous records in SQLite and close connection before pyogrio
        if self.gpkg_path.exists() and self.gpkg_path.stat().st_size > 0:
            conn = get_db_connection(self.gpkg_path)
            cleanup_partial_municipality(conn, cd_mun)
            conn.commit()
            conn.close()

        # Step 2: Append spatial layers via pyogrio
        layers_to_write = [
            ("polos_saude", bundle.get("polos_gdf")),
            ("voronoi_ambos", bundle.get("vor_ambos_gdf")),
            ("voronoi_urbanos", bundle.get("vor_urbanos_gdf")),
            ("voronoi_rurais", bundle.get("vor_rurais_gdf")),
        ]

        file_exists = self.gpkg_path.exists() and self.gpkg_path.stat().st_size > 0
        existing_layers = set()
        if file_exists:
            try:
                existing_layers = set(pyogrio.list_layers(self.gpkg_path)[:, 0])
            except Exception:
                pass

        for layer_name, gdf in layers_to_write:
            if gdf is not None and not gdf.empty:
                # Ensure CRS is EPSG:4326
                if gdf.crs is None:
                    gdf = gdf.set_crs("EPSG:4326")
                elif str(gdf.crs).upper() not in ("EPSG:4326", "OGC:CRS84"):
                    gdf = gdf.to_crs("EPSG:4326")

                clean_gdf = gdf.copy()

                # Cast Polygon to MultiPolygon for voronoi layers to guarantee homogeneous geometry types
                if "voronoi" in layer_name:
                    clean_gdf["geometry"] = [
                        MultiPolygon([geom]) if isinstance(geom, Polygon) else geom
                        for geom in clean_gdf.geometry
                    ]

                # If layer already exists, align clean_gdf strictly to the established layer fields
                if file_exists and layer_name in existing_layers:
                    existing_fields = self._get_layer_fields(layer_name)
                    if existing_fields:
                        for f in existing_fields:
                            if f not in clean_gdf.columns:
                                clean_gdf[f] = None
                        cols_to_keep = [c for c in existing_fields if c in clean_gdf.columns] + ["geometry"]
                        clean_gdf = clean_gdf[cols_to_keep]

                # Sanitize column types for GPKG / OGC compliance
                for col in clean_gdf.columns:
                    if col != "geometry" and clean_gdf[col].dtype == "object":
                        clean_gdf[col] = clean_gdf[col].apply(
                            lambda x: json.dumps(x, ensure_ascii=False) if isinstance(x, (dict, list)) else (
                                str(x) if x is not None and pd.notna(x) else None
                            )
                        )

                if not file_exists:
                    pyogrio.write_dataframe(clean_gdf, self.gpkg_path, layer=layer_name, driver="GPKG")
                    file_exists = True
                    existing_layers.add(layer_name)
                    self._layer_fields_cache[layer_name] = [c for c in clean_gdf.columns if c != "geometry"]
                elif layer_name in existing_layers:
                    pyogrio.write_dataframe(clean_gdf, self.gpkg_path, layer=layer_name, append=True)
                else:
                    pyogrio.write_dataframe(clean_gdf, self.gpkg_path, layer=layer_name, append=True)
                    existing_layers.add(layer_name)
                    self._layer_fields_cache[layer_name] = [c for c in clean_gdf.columns if c != "geometry"]

        # Step 3: Insert summary record & checkpoint
        conn = get_db_connection(self.gpkg_path)
        init_checkpoints_table(conn)
        resumo = bundle.get("resumo_dict", {})
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS municipios_resumo (
                    cd_mun INTEGER PRIMARY KEY,
                    id7 INTEGER NOT NULL,
                    nome_mun TEXT NOT NULL,
                    uf TEXT NOT NULL,
                    pop_total INTEGER DEFAULT 0,
                    pop_urbana INTEGER DEFAULT 0,
                    pop_rural INTEGER DEFAULT 0,
                    n_estabelecimentos INTEGER DEFAULT 0,
                    n_polos INTEGER DEFAULT 0,
                    qtd_equipes_esf INTEGER DEFAULT 0,
                    qtd_equipes_eap INTEGER DEFAULT 0,
                    qtd_equipes_total INTEGER DEFAULT 0,
                    capacidade_pnab_total INTEGER DEFAULT 0,
                    sobrecarga_pnab_media REAL DEFAULT 0.0,
                    n_polos_adequada INTEGER DEFAULT 0,
                    n_polos_atencao INTEGER DEFAULT 0,
                    n_polos_critica INTEGER DEFAULT 0,
                    pop_em_sobrecarga_critica INTEGER DEFAULT 0,
                    pct_pop_critica REAL DEFAULT 0.0,
                    area_total_km2 REAL DEFAULT 0.0,
                    area_urbana_km2 REAL DEFAULT 0.0,
                    area_rural_km2 REAL DEFAULT 0.0,
                    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
                );
            """)
            conn.execute("""
                INSERT OR REPLACE INTO municipios_resumo (
                    cd_mun, id7, nome_mun, uf,
                    pop_total, pop_urbana, pop_rural,
                    n_estabelecimentos, n_polos,
                    qtd_equipes_esf, qtd_equipes_eap, qtd_equipes_total,
                    capacidade_pnab_total, sobrecarga_pnab_media,
                    n_polos_adequada, n_polos_atencao, n_polos_critica,
                    pop_em_sobrecarga_critica, pct_pop_critica,
                    area_total_km2, area_urbana_km2, area_rural_km2
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                cd_mun,
                bundle["id7"],
                bundle["nome_mun"],
                bundle["uf"],
                resumo.get("pop_total", 0),
                resumo.get("pop_urbana", 0),
                resumo.get("pop_rural", 0),
                resumo.get("n_estabelecimentos", 0),
                resumo.get("n_polos", 0),
                resumo.get("qtd_equipes_esf", 0),
                resumo.get("qtd_equipes_eap", 0),
                resumo.get("qtd_equipes_total", 0),
                resumo.get("capacidade_pnab_total", 0),
                resumo.get("sobrecarga_pnab_media", 0.0),
                resumo.get("n_polos_adequada", 0),
                resumo.get("n_polos_atencao", 0),
                resumo.get("n_polos_critica", 0),
                resumo.get("pop_em_sobrecarga_critica", 0),
                resumo.get("pct_pop_critica", 0.0),
                resumo.get("area_total_km2", 0.0),
                resumo.get("area_urbana_km2", 0.0),
                resumo.get("area_rural_km2", 0.0)
            ))
            conn.execute("""
                INSERT OR IGNORE INTO demas_checkpoints (cd_mun, id7, nome_mun, uf, status)
                VALUES (?, ?, ?, ?, 'processing')
            """, (cd_mun, bundle["id7"], bundle["nome_mun"], bundle["uf"]))

        stats = bundle.get("stats", {})
        mark_checkpoint_completed(conn, cd_mun, stats)
        conn.close()

    def crystallize_to_geoparquet(self, output_dir: Path) -> Dict[str, int]:
        """
        Export all GeoPackage layers into optimized partitioned GeoParquet.
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        spatial_layers = ["polos_saude", "voronoi_ambos", "voronoi_urbanos", "voronoi_rurais"]
        counts = {}

        for layer in spatial_layers:
            try:
                gdf = gpd.read_file(self.gpkg_path, layer=layer)
                if gdf.empty:
                    continue

                layer_dir = output_dir / layer
                layer_dir.mkdir(parents=True, exist_ok=True)

                # Partition by UF
                if "uf" in gdf.columns:
                    for uf, group in gdf.groupby("uf"):
                        uf_path = layer_dir / f"{uf.upper()}.parquet"
                        group.to_parquet(uf_path, compression="zstd", index=False)
                else:
                    gdf.to_parquet(layer_dir / f"{layer}.parquet", compression="zstd", index=False)

                counts[layer] = len(gdf)
            except Exception as e:
                logger.warning(f"Could not crystallize layer {layer}: {e}")

        # Export summary table as standard Parquet
        try:
            conn = get_db_connection(self.gpkg_path)
            resumo_df = pd.read_sql("SELECT * FROM municipios_resumo ORDER BY uf, cd_mun", conn)
            conn.close()

            resumo_path = output_dir / "municipios_resumo_brasil.parquet"
            resumo_df.to_parquet(resumo_path, compression="zstd", index=False)
            counts["municipios_resumo"] = len(resumo_df)
        except Exception as e:
            logger.warning(f"Could not crystallize municipios_resumo: {e}")

        return counts
