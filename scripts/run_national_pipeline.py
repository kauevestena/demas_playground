#!/usr/bin/env python3
"""
run_national_pipeline.py - High-Performance, Resilient National DEMAS Pipeline.

Orchestrates full-country primary healthcare access & PNAB coverage analysis across
all 5,570 Brazilian municipalities.

Key Architectural Guarantees:
- Producer-Consumer Multi-Processing with Dedicated Single-Writer (no SQLite lock contention).
- Atomic Per-Municipality Checkpoints in GeoPackage with deep integrity validation.
- Clean resume capability: purges interrupted/corrupted runs and resumes from verified state.
- Tenacity-decorated exponential backoff retries for all network endpoints.
- Realtime tqdm progress tracking with live health capacity metrics.
- Post-processing crystallization to partitioned GeoParquet.
"""

import os
import sys
import time
import signal
import argparse
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional
import multiprocessing as mp

# Add demas_driver to python path
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "demas_driver"))

import pandas as pd
from tqdm import tqdm

from demas_driver.checkpoints import (
    get_db_connection,
    register_municipalities,
    get_pending_municipalities,
    audit_and_cleanup_database,
    mark_checkpoint_failed
)
from demas_driver.gpkg_store import GeoPackageStore
from demas_driver.downloader import (
    get_all_municipalities_list,
    download_uf_census_gpkg
)
from demas_driver.pipeline_worker import process_single_municipality

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler("demas_national_pipeline.log", encoding="utf-8"),
        logging.StreamHandler(sys.stderr)
    ]
)
# Suppress noisy external library logs
logging.getLogger("pyogrio").setLevel(logging.WARNING)
logging.getLogger("fiona").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)

logger = logging.getLogger("demas.pipeline")


# =========================================================================
# WORKER PROCESS
# =========================================================================

def worker_process_loop(
    worker_id: int,
    task_queue: mp.Queue,
    result_queue: mp.Queue,
    cache_dir: Path,
    capacity_parquet_path: Optional[Path] = None
):
    """
    Worker process loop: consumes municipalities from task_queue,
    runs spatial clustering, Voronoi clipping, and PNAB analysis,
    and sends finished bundles to result_queue.
    """
    capacity_df = None
    if capacity_parquet_path and capacity_parquet_path.exists():
        try:
            capacity_df = pd.read_parquet(capacity_parquet_path)
        except Exception as e:
            logger.warning(f"[Worker-{worker_id}] Could not load capacity parquet: {e}")

    while True:
        try:
            task = task_queue.get(timeout=2.0)
        except Exception:
            continue

        if task is None:
            # Poison pill -> terminate worker
            break

        cd_mun = int(task.get("code6", task.get("cd_mun", 0)))
        nome = task.get("nome_mun", task.get("nome", "Mun"))
        uf = task.get("uf", "")

        try:
            bundle = process_single_municipality(task, cache_dir, capacity_df=capacity_df)
            result_queue.put({"status": "ok", "bundle": bundle})
        except Exception as err:
            logger.error(f"[Worker-{worker_id}] Failed {nome} ({cd_mun}-{uf}): {err}", exc_info=True)
            result_queue.put({
                "status": "error",
                "cd_mun": cd_mun,
                "nome_mun": nome,
                "uf": uf,
                "error": str(err)
            })


# =========================================================================
# WRITER PROCESS (SINGLE-WRITER TO GEOPACKAGE)
# =========================================================================

def writer_process_loop(
    result_queue: mp.Queue,
    progress_queue: mp.Queue,
    gpkg_path: Path
):
    """
    Single dedicated Writer process: consumes completed bundles from result_queue,
    executes atomic ACID transaction into GeoPackage, and notifies progress_queue.
    """
    store = GeoPackageStore(gpkg_path)

    while True:
        item = result_queue.get()
        if item is None:
            # Poison pill -> shutdown writer
            break

        status = item.get("status")

        if status == "ok":
            bundle = item["bundle"]
            cd_mun = bundle["cd_mun"]
            try:
                store.save_municipality_bundle(bundle)
                progress_queue.put({
                    "status": "completed",
                    "cd_mun": cd_mun,
                    "nome_mun": bundle["nome_mun"],
                    "uf": bundle["uf"],
                    "stats": bundle["stats"],
                    "resumo": bundle["resumo_dict"]
                })
            except Exception as e:
                logger.error(f"[Writer] Error saving bundle for {cd_mun}: {e}", exc_info=True)
                conn = get_db_connection(gpkg_path)
                mark_checkpoint_failed(conn, cd_mun, str(e))
                conn.close()
                progress_queue.put({"status": "failed", "cd_mun": cd_mun, "error": str(e)})

        elif status == "error":
            cd_mun = item["cd_mun"]
            conn = get_db_connection(gpkg_path)
            mark_checkpoint_failed(conn, cd_mun, item.get("error", "Unknown worker error"))
            conn.close()
            progress_queue.put({"status": "failed", "cd_mun": cd_mun, "error": item.get("error")})


# =========================================================================
# MAIN PIPELINE ORCHESTRATOR
# =========================================================================

def run_pipeline(
    workers: int = 8,
    uf_filter: Optional[List[str]] = None,
    gpkg_path: Path = Path("cache/demas_brasil_analysis.gpkg"),
    cache_dir: Path = Path("cache"),
    output_dir: Path = Path("output/geoparquet"),
    force_reprocess: bool = False,
    preload_census: bool = False,
    crystallize_at_end: bool = True
):
    print("=" * 80)
    print("DEMAS PLATFORM - NATIONAL APS & PNAB SPATIAL ANALYSIS PIPELINE")
    print("=" * 80)
    print(f"Workers:           {workers}")
    print(f"Target UF(s):      {','.join(uf_filter) if uf_filter else 'ALL (Brazil - 5,570 municipalities)'}")
    print(f"GeoPackage Target: {gpkg_path}")
    print(f"Cache Directory:   {cache_dir}")
    print(f"GeoParquet Output: {output_dir}")
    print("=" * 80)

    cache_dir.mkdir(parents=True, exist_ok=True)
    gpkg_path.parent.mkdir(parents=True, exist_ok=True)

    # Ensure GeoPackage file and OGC schema are properly initialized
    store = GeoPackageStore(gpkg_path)

    # 1. Fetch/Load official municipality catalog from IBGE
    all_munis = get_all_municipalities_list(cache_dir)
    print(f"\n[IBGE Catalog] Total municipalities registered: {len(all_munis):,}")

    # 2. Startup Audit & Checkpoint Registration
    print("\n[Checkpoints] Auditing existing GeoPackage database...")
    audit_res = audit_and_cleanup_database(gpkg_path)
    print(f"  Existing records in DB: {audit_res['total']:,}")
    print(f"  Verified completed:     {audit_res['completed']:,}")
    print(f"  Cleaned up / Reset:     {audit_res['cleaned']:,}")

    # Register all catalog municipalities
    newly_added = register_municipalities(gpkg_path, all_munis, force_reset=False)
    if newly_added > 0:
        print(f"  Registered {newly_added} new municipalities in checkpoint registry.")

    # 3. Query Pending Municipalities
    pending = get_pending_municipalities(
        gpkg_path,
        uf_filter=uf_filter,
        force_reprocess=force_reprocess
    )

    if not pending:
        print("\n🎉 ALL target municipalities have already been successfully processed and verified!")
        if crystallize_at_end:
            print("\n[Crystallization] Exporting GeoPackage to GeoParquet...")
            store = GeoPackageStore(gpkg_path)
            res = store.crystallize_to_geoparquet(output_dir)
            print("Crystallization complete:", res)
        return

    print(f"\n[Execution Plan] Pending municipalities to process: {len(pending):,}")

    # 4. Optional Preloading of Census GPKGs
    if preload_census:
        ufs_in_plan = sorted(list(set(m["uf"] for m in pending)))
        print(f"\n[Preloading] Downloading Censo 2022 GPKGs for {len(ufs_in_plan)} UFs...")
        for u in ufs_in_plan:
            download_uf_census_gpkg(u, cache_dir)
        print("Preloading completed successfully.")

    # 5. CNES Capacity Table
    cap_path = REPO_ROOT / "playground" / "data" / "cnes_estabelecimentos_capacidade.parquet"
    if not cap_path.exists():
        cap_path = cache_dir / "teams" / "cnes_estabelecimentos_capacidade.parquet"

    # 6. Setup Multiprocessing Queues
    ctx = mp.get_context("spawn")
    task_queue = ctx.Queue(maxsize=workers * 4)
    result_queue = ctx.Queue(maxsize=workers * 4)
    progress_queue = ctx.Queue()

    # Launch Single-Writer Process
    writer_p = ctx.Process(
        target=writer_process_loop,
        args=(result_queue, progress_queue, gpkg_path),
        name="DEMAS-Writer"
    )
    writer_p.start()

    # Launch Worker Processes
    worker_procs = []
    for wid in range(workers):
        wp = ctx.Process(
            target=worker_process_loop,
            args=(wid, task_queue, result_queue, cache_dir, cap_path),
            name=f"DEMAS-Worker-{wid}"
        )
        wp.start()
        worker_procs.append(wp)

    # Signal Handling for Graceful Shutdown
    shutdown_requested = False

    def handle_sigint(signum, frame):
        nonlocal shutdown_requested
        if not shutdown_requested:
            print("\n⚠️ Graceful shutdown requested (Ctrl+C). Finishing in-flight municipalities...")
            shutdown_requested = True

    signal.signal(signal.SIGINT, handle_sigint)

    # 7. Feed Tasks and Monitor Progress with TQDM
    total_to_do = len(pending)
    pbar = tqdm(
        total=total_to_do,
        desc="Brasil APS Pipeline",
        unit="mun",
        dynamic_ncols=True,
        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}] {postfix}"
    )

    pending_iter = iter(pending)
    in_flight = 0
    completed_count = 0
    failed_count = 0
    cum_pop = 0
    cum_esf = 0
    cum_critica = 0

    try:
        # Prime the task queue
        for _ in range(workers * 2):
            try:
                task = next(pending_iter)
                task_queue.put(task)
                in_flight += 1
            except StopIteration:
                break

        while in_flight > 0:
            if shutdown_requested:
                break

            # Check progress updates from writer
            try:
                prog = progress_queue.get(timeout=0.1)
                st = prog.get("status")
                if st == "completed":
                    completed_count += 1
                    resumo = prog.get("resumo", {})
                    cum_pop += resumo.get("pop_total", 0)
                    cum_esf += resumo.get("qtd_equipes_esf", 0)
                    cum_critica += resumo.get("n_polos_critica", 0)

                    pbar.set_postfix({
                        "Mun": f"{prog['nome_mun']} ({prog['uf']})",
                        "ESF": f"{cum_esf:,}",
                        "Crítica": f"{cum_critica:,}",
                        "Pop": f"{cum_pop / 1e6:.1f}M"
                    })
                else:
                    failed_count += 1

                pbar.update(1)
                in_flight -= 1

                # Feed next task
                try:
                    next_task = next(pending_iter)
                    task_queue.put(next_task)
                    in_flight += 1
                except StopIteration:
                    pass

            except Exception:
                # Timeout waiting for progress -> loop and check again
                pass

    finally:
        pbar.close()

        print("\n[Shutdown] Stopping worker processes...")
        for _ in range(workers):
            task_queue.put(None)

        for wp in worker_procs:
            wp.join(timeout=5.0)
            if wp.is_alive():
                wp.terminate()

        print("[Shutdown] Stopping database writer process...")
        result_queue.put(None)
        writer_p.join(timeout=10.0)
        if writer_p.is_alive():
            writer_p.terminate()

    print("\n" + "=" * 80)
    print("PIPELINE SESSION SUMMARY")
    print("=" * 80)
    print(f"Municipalities processed this run: {completed_count:,}")
    print(f"Failed municipalities:            {failed_count:,}")
    print(f"Cumulative population covered:    {cum_pop:,}")
    print(f"Cumulative ESF teams:             {cum_esf:,}")
    print(f"Cumulative Critical Voronoi poles:{cum_critica:,}")
    print("=" * 80)

    # 8. Crystallization to GeoParquet
    if crystallize_at_end and completed_count > 0 and not shutdown_requested:
        print("\n[Crystallization] Exporting GeoPackage layers to partitioned GeoParquet...")
        store = GeoPackageStore(gpkg_path)
        c_stats = store.crystallize_to_geoparquet(output_dir)
        print("Crystallization complete!")
        for lyr, cnt in c_stats.items():
            print(f"  - {lyr}: {cnt:,} features")


# =========================================================================
# CLI ENTRY POINT
# =========================================================================

def parse_args():
    parser = argparse.ArgumentParser(
        description="Run National DEMAS APS & PNAB Spatial Analysis Pipeline"
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Number of concurrent worker processes (default: 8)"
    )
    parser.add_argument(
        "--uf",
        type=str,
        default=None,
        help="Comma-separated UF filter (e.g. PR,SC,RS) or 'ALL' for entire country"
    )
    parser.add_argument(
        "--gpkg",
        type=str,
        default="cache/demas_brasil_analysis.gpkg",
        help="Target GeoPackage database path"
    )
    parser.add_argument(
        "--cache-dir",
        type=str,
        default="cache",
        help="Local cache directory for census, boundaries, and facilities"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="output/geoparquet",
        help="Destination directory for crystallized GeoParquet files"
    )
    parser.add_argument(
        "--preload-census",
        action="store_true",
        help="Pre-download state Census GPKGs before launching workers"
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Audit database integrity, print status summary, and exit"
    )
    parser.add_argument(
        "--crystallize",
        action="store_true",
        help="Export GeoPackage layers to partitioned GeoParquet and exit"
    )
    parser.add_argument(
        "--force-reprocess",
        action="store_true",
        help="Reprocess all target municipalities ignoring completed status"
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    gpkg_p = Path(args.gpkg)
    cache_p = Path(args.cache_dir)
    output_p = Path(args.output_dir)

    uf_filter = None
    if args.uf and args.uf.upper() != "ALL":
        uf_filter = [u.strip().upper() for u in args.uf.split(",") if u.strip()]

    if args.verify_only:
        print(f"Auditing database integrity for: {gpkg_p}")
        audit = audit_and_cleanup_database(gpkg_p)
        print("Audit Results:", audit)
        sys.exit(0)

    if args.crystallize:
        print(f"Crystallizing {gpkg_p} to {output_p}...")
        store = GeoPackageStore(gpkg_p)
        res = store.crystallize_to_geoparquet(output_p)
        print("Export complete:", res)
        sys.exit(0)

    run_pipeline(
        workers=args.workers,
        uf_filter=uf_filter,
        gpkg_path=gpkg_p,
        cache_dir=cache_p,
        output_dir=output_p,
        force_reprocess=args.force_reprocess,
        preload_census=args.preload_census,
        crystallize_at_end=True
    )
