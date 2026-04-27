#!/usr/bin/env python3
"""Refresh DuckDB analysis tables from the robios SQLite database."""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path
from typing import Iterable, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
SERVER_DIR = SCRIPT_DIR.parent
DEFAULT_DATA_DIR = SERVER_DIR / "data"

POINTS_COLUMNS = [
    "point_id",
    "batch_id",
    "device_id",
    "installation_id",
    "local_sequence",
    "stream",
    "event_date",
    "received_at_device",
    "ingested_at",
    "payload",
    "payload_hash_sha256",
    "payload_json_valid",
    "source_id",
]

DEVICES_COLUMNS = [
    "device_id",
    "installation_id",
    "app_version",
    "os_version",
    "first_seen_at",
    "last_seen_at",
    "raw_json",
]

BLOBS_COLUMNS = [
    "sha256",
    "size_bytes",
    "storage_path",
    "created_at",
    "last_seen_at",
]


def main() -> int:
    args = parse_args()

    try:
        import duckdb
    except ImportError:
        print(
            "Missing Python package 'duckdb'. Install it with `python3 -m pip install duckdb`.",
            file=sys.stderr,
        )
        return 2

    data_dir = Path(args.data_dir).expanduser().resolve()
    sqlite_path = Path(args.sqlite or data_dir / "robios.sqlite").expanduser().resolve()
    duckdb_path = Path(args.duckdb or data_dir / "robios.duckdb").expanduser().resolve()

    if not sqlite_path.exists():
        print(f"SQLite database does not exist: {sqlite_path}", file=sys.stderr)
        return 1

    duckdb_path.parent.mkdir(parents=True, exist_ok=True)

    sqlite_conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    sqlite_conn.row_factory = sqlite3.Row
    duckdb_conn = duckdb.connect(str(duckdb_path))

    try:
        refresh_duckdb(sqlite_conn, duckdb_conn)
    finally:
        duckdb_conn.close()
        sqlite_conn.close()

    print(f"refreshed {duckdb_path} from {sqlite_path}")
    print(f"data root: {data_dir}")
    return 0


def parse_args() -> argparse.Namespace:
    data_dir = Path(os.environ.get("ROBIOS_DATA_DIR", DEFAULT_DATA_DIR))

    parser = argparse.ArgumentParser(
        description="Create or refresh robios DuckDB analysis tables from SQLite.",
    )
    parser.add_argument("--data-dir", default=str(data_dir), help="robios data root")
    parser.add_argument(
        "--sqlite",
        default=os.environ.get("ROBIOS_DB_PATH"),
        help="source SQLite database path, default <data-dir>/robios.sqlite",
    )
    parser.add_argument(
        "--duckdb",
        default=os.environ.get("ROBIOS_DUCKDB_PATH"),
        help="target DuckDB database path, default <data-dir>/robios.duckdb",
    )
    return parser.parse_args()


def refresh_duckdb(sqlite_conn: sqlite3.Connection, duckdb_conn) -> None:
    duckdb_conn.execute("BEGIN TRANSACTION")
    try:
        for table in [
            "points_by_stream_daily",
            "latest_device_status",
            "blob_inventory",
            "points_raw",
            "devices_raw",
            "blobs_raw",
        ]:
            duckdb_conn.execute(f"DROP TABLE IF EXISTS {table}")

        create_raw_tables(duckdb_conn)
        insert_rows(
            duckdb_conn,
            "points_raw",
            POINTS_COLUMNS,
            sqlite_rows(sqlite_conn, "points", POINTS_COLUMNS, "ingested_at, point_id"),
        )
        insert_rows(
            duckdb_conn,
            "devices_raw",
            DEVICES_COLUMNS,
            sqlite_rows(sqlite_conn, "devices", DEVICES_COLUMNS, "last_seen_at DESC, device_id"),
        )
        insert_rows(
            duckdb_conn,
            "blobs_raw",
            BLOBS_COLUMNS,
            sqlite_rows(sqlite_conn, "blobs", BLOBS_COLUMNS, "created_at, sha256"),
        )
        create_analysis_tables(duckdb_conn)
        duckdb_conn.execute("COMMIT")
    except Exception:
        duckdb_conn.execute("ROLLBACK")
        raise


def create_raw_tables(duckdb_conn) -> None:
    duckdb_conn.execute(
        """
        CREATE TABLE points_raw (
          point_id VARCHAR PRIMARY KEY,
          batch_id BIGINT,
          device_id VARCHAR NOT NULL,
          installation_id VARCHAR NOT NULL,
          local_sequence BIGINT NOT NULL,
          stream VARCHAR NOT NULL,
          event_date VARCHAR NOT NULL,
          received_at_device VARCHAR NOT NULL,
          ingested_at VARCHAR NOT NULL,
          payload VARCHAR NOT NULL,
          payload_hash_sha256 VARCHAR NOT NULL,
          payload_json_valid BOOLEAN NOT NULL,
          source_id VARCHAR
        )
        """,
    )
    duckdb_conn.execute(
        """
        CREATE TABLE devices_raw (
          device_id VARCHAR PRIMARY KEY,
          installation_id VARCHAR NOT NULL,
          app_version VARCHAR,
          os_version VARCHAR,
          first_seen_at VARCHAR NOT NULL,
          last_seen_at VARCHAR NOT NULL,
          raw_json VARCHAR NOT NULL
        )
        """,
    )
    duckdb_conn.execute(
        """
        CREATE TABLE blobs_raw (
          sha256 VARCHAR PRIMARY KEY,
          size_bytes BIGINT NOT NULL,
          storage_path VARCHAR NOT NULL,
          created_at VARCHAR NOT NULL,
          last_seen_at VARCHAR NOT NULL
        )
        """,
    )


def create_analysis_tables(duckdb_conn) -> None:
    duckdb_conn.execute(
        """
        CREATE TABLE points_by_stream_daily AS
        SELECT
          stream,
          substr(event_date, 1, 10) AS event_day,
          count(*)::BIGINT AS point_count,
          min(event_date) AS first_event_date,
          max(event_date) AS latest_event_date,
          min(ingested_at) AS first_ingested_at,
          max(ingested_at) AS latest_ingested_at
        FROM points_raw
        GROUP BY stream, event_day
        ORDER BY event_day DESC, stream
        """,
    )
    duckdb_conn.execute(
        """
        CREATE TABLE latest_device_status AS
        SELECT
          devices_raw.device_id,
          devices_raw.installation_id,
          devices_raw.app_version,
          devices_raw.os_version,
          devices_raw.first_seen_at,
          devices_raw.last_seen_at,
          coalesce(point_totals.point_count, 0)::BIGINT AS point_count,
          point_totals.latest_event_date,
          point_totals.latest_ingested_at
        FROM devices_raw
        LEFT JOIN (
          SELECT
            device_id,
            count(*)::BIGINT AS point_count,
            max(event_date) AS latest_event_date,
            max(ingested_at) AS latest_ingested_at
          FROM points_raw
          GROUP BY device_id
        ) AS point_totals USING (device_id)
        ORDER BY devices_raw.last_seen_at DESC, devices_raw.device_id
        """,
    )
    duckdb_conn.execute(
        """
        CREATE TABLE blob_inventory AS
        SELECT
          sha256,
          size_bytes,
          storage_path,
          created_at,
          last_seen_at
        FROM blobs_raw
        ORDER BY created_at DESC, sha256
        """,
    )


def sqlite_rows(
    conn: sqlite3.Connection,
    table: str,
    columns: Sequence[str],
    order_by: str,
) -> Iterable[tuple[object, ...]]:
    column_list = ", ".join(columns)
    for row in conn.execute(f"SELECT {column_list} FROM {table} ORDER BY {order_by}"):
        yield tuple(row[column] for column in columns)


def insert_rows(duckdb_conn, table: str, columns: Sequence[str], rows: Iterable[tuple[object, ...]]) -> None:
    placeholders = ", ".join("?" for _ in columns)
    column_list = ", ".join(columns)
    insert_sql = f"INSERT INTO {table} ({column_list}) VALUES ({placeholders})"
    batch: list[tuple[object, ...]] = []
    for row in rows:
        batch.append(row)
        if len(batch) == 1_000:
            duckdb_conn.executemany(insert_sql, batch)
            batch.clear()

    if batch:
        duckdb_conn.executemany(insert_sql, batch)


if __name__ == "__main__":
    raise SystemExit(main())
