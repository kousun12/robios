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

## Local development

```sh
cd server
bun install
ROBIOS_TOKEN=dev-secret ROBIOS_DATA_DIR=./data bun run dev
```

Smoke test:

```sh
cd server
ROBIOS_BASE_URL=http://127.0.0.1:8080 ROBIOS_TOKEN=dev-secret bun run smoke
```

## Configuration

- `PORT`: HTTP port, default `8080`.
- `ROBIOS_TOKEN`: shared bearer token, default `dev-secret` for local development.
- `ROBIOS_DATA_DIR`: directory for SQLite and blobs, default `server/data`.
- `ROBIOS_DB_PATH`: optional explicit SQLite path.
- `ROBIOS_BLOBS_DIR`: optional explicit blob directory.

## Zo service command

Use a managed Zo User Service with `mode=http`.

Entrypoint:

```sh
bash -lc 'cd /home/workspace/robios/server && bun install --frozen-lockfile && bun run start'
```

Environment variables:

```sh
ROBIOS_DATA_DIR=/home/workspace/robios-data
ROBIOS_TOKEN=<set as a Zo secret>
```

Prefer a private HTTP service if available. Otherwise use a public service with the bearer token.
