# robios server

Bun + Hono sync server for the robios iOS app.

## API

All endpoints require:

```http
Authorization: Bearer <ROBIOS_TOKEN>
```

Implemented endpoints:

- `GET /v1/status`
- `POST /v1/devices/register`
- `POST /v1/ingest`
- `HEAD /v1/files/blobs/:sha256`
- `PUT /v1/files/blobs/:sha256`

Server-generated timestamps are RFC 3339 UTC strings without fractional seconds, for example `2026-04-26T19:30:00Z`.

## Local development

```sh
cd server
bun install
ROBIOS_TOKEN=dev-secret ROBIOS_DATA_DIR=./data bun run dev
```

The server fails closed when `ROBIOS_TOKEN` is missing. For local-only experiments, `ROBIOS_ALLOW_DEV_TOKEN=1` enables the `dev-secret` fallback.

Run automated tests:

```sh
cd server
bun test
```

Run the smoke test against a running server:

```sh
cd server
ROBIOS_BASE_URL=http://127.0.0.1:8080 ROBIOS_TOKEN=dev-secret bun run smoke
```

Refresh local DuckDB analysis tables from SQLite:

```sh
cd server
python3 -m pip install duckdb
ROBIOS_DATA_DIR=./data bun run export:duckdb
```

## Configuration

- `PORT`: HTTP port, default `8080`.
- `ROBIOS_TOKEN`: required shared bearer token.
- `ROBIOS_ALLOW_DEV_TOKEN`: set to `1` only for local development fallback token behavior.
- `ROBIOS_DATA_DIR`: directory for SQLite and blobs, default `server/data`.
- `ROBIOS_DB_PATH`: optional explicit SQLite path.
- `ROBIOS_BLOBS_DIR`: optional explicit blob directory.
- `ROBIOS_MAX_INGEST_BYTES`: max JSON ingest request size, default `5242880`.
- `ROBIOS_MAX_POINTS_PER_BATCH`: max points per ingest batch, default `1000`.
- `ROBIOS_MAX_PAYLOAD_BYTES`: max single point payload string size, default `524288`.
- `ROBIOS_MAX_BLOB_BYTES`: max raw blob upload size, default `262144000`.

## Storage

SQLite is initialized at startup and migrations are tracked in `schema_migrations`. Blobs are stored as content-addressed files under:

```text
<ROBIOS_BLOBS_DIR>/<first-two-sha256-characters>/<sha256>
```

Generated runtime data should stay out of git. Local development data belongs in `server/data/`; production service data should live outside the repo, for example `/home/workspace/robios-data`.

## Analysis export

`scripts/export_duckdb.py` creates or refreshes a DuckDB database from the server SQLite database. By default it reads:

```text
<ROBIOS_DATA_DIR>/robios.sqlite
```

and writes:

```text
<ROBIOS_DATA_DIR>/robios.duckdb
```

Override paths with `ROBIOS_DB_PATH`, `ROBIOS_DUCKDB_PATH`, or the script flags `--sqlite` and `--duckdb`. The export recreates these tables on each run:

- `points_raw`
- `points_by_stream_daily`
- `latest_device_status`
- `blob_inventory`

## Zo service

Use a managed Zo User Service with `mode=http`.

Setup command:

```sh
cd /home/workspace/robios/server && bun install --frozen-lockfile
```

Entrypoint:

```sh
bash -lc 'cd /home/workspace/robios/server && bun run start'
```

Environment variables:

```sh
ROBIOS_DATA_DIR=/home/workspace/robios-data
ROBIOS_TOKEN=<set as a Zo secret>
```

Use a public HTTPS service URL for iPhone sync, or local-network HTTP only when the phone can reach the server on the same LAN. Do not rely on public plain HTTP for iPhone sync unless the app gains an explicit ATS exception.
