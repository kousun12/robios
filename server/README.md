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

## Personal server deployment

Install dependencies from the `server/` directory:

```sh
cd /home/workspace/robios/server
bun install --frozen-lockfile
```

Create a durable data directory outside the repo:

```sh
mkdir -p /home/workspace/robios-data
```

Run the service with an explicit secret token:

```sh
cd /home/workspace/robios/server
ROBIOS_TOKEN='<long-random-secret>' \
ROBIOS_DATA_DIR=/home/workspace/robios-data \
PORT=8080 \
bun run start
```

Use a service manager for long-running production use. The command it runs should be equivalent to:

```sh
bash -lc 'cd /home/workspace/robios/server && bun run start'
```

with these environment variables:

```sh
ROBIOS_DATA_DIR=/home/workspace/robios-data
ROBIOS_TOKEN=<long-random-secret>
PORT=8080
```

Expose the service through HTTPS for iPhone sync, for example with a reverse proxy or managed public HTTPS endpoint in front of the Bun process. Local-network HTTP is acceptable only when the phone and server are on the same LAN. Do not rely on public plain HTTP for iPhone sync unless the app gains an explicit ATS exception.

Verify the deployed status endpoint:

```sh
curl -i -H 'Authorization: Bearer <long-random-secret>' https://your-server.example/v1/status
```

Run the contract smoke test against the deployed URL:

```sh
cd /home/workspace/robios/server
ROBIOS_BASE_URL=https://your-server.example \
ROBIOS_TOKEN='<long-random-secret>' \
bun run smoke
```

Configure the iOS app Settings tab with:

- server base URL: `https://your-server.example`
- access key: the same value as `ROBIOS_TOKEN`

After tapping Sync Now in the app, inspect the SQLite database:

```sh
sqlite3 /home/workspace/robios-data/robios.sqlite
```

Useful first checks:

```sql
SELECT COUNT(*) FROM points;
SELECT stream, COUNT(*) FROM points GROUP BY stream ORDER BY stream;
SELECT device_id, installation_id, last_seen_at FROM devices;
```

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
