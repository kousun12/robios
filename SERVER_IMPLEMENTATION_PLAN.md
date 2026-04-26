# robios Server Implementation Plan for Zo

## Goal

Implement and run the real robios sync server on this Zo Computer so the iOS app can sync personal iPhone data to Rob's own server, with durable storage, authenticated HTTP APIs, and easy local analysis.

The server should live in this repository next to the iOS app so the client/server API contract evolves in source control together. Zo can run it as a managed User Service from the repo checkout.

The app already speaks a small sync contract via `ServerAPI.swift` and `FileBlobUploader.swift`. The repo also has a Python standard-library mock server in `tools/mock-server/robios_mock_server.py`; the real server should match that contract, then replace file-per-record mock persistence with a durable database and blob store.

## Current client contract

The iOS app expects these endpoints, all authenticated with:

```http
Authorization: Bearer <shared access key>
```

### `GET /v1/status`

Response shape:

```json
{
  "status": "ok",
  "serverTime": "2026-04-26T19:30:00Z",
  "version": "server-1"
}
```

### `POST /v1/devices/register`

Request:

```json
{
  "deviceId": "...",
  "installationId": "...",
  "appVersion": "1.0",
  "osVersion": "..."
}
```

Response:

```json
{
  "accepted": true,
  "deviceToken": "..."
}
```

The current app does not use `deviceToken` for later auth, so the initial real server can return `deviceId` or `null`.

### `POST /v1/ingest`

Request:

```json
{
  "deviceId": "...",
  "installationId": "...",
  "sentAt": "...",
  "points": [
    {
      "pointId": "uuid",
      "localSequence": 1,
      "stream": "device.snapshot",
      "eventDate": "...",
      "receivedAt": "...",
      "payload": "{...canonical JSON string...}",
      "payloadHashSHA256": "hex sha256 of payload string"
    }
  ]
}
```

Response:

```json
{
  "acceptedCount": 1,
  "duplicateCount": 0,
  "rejectedCount": 0,
  "results": [
    { "pointId": "uuid", "status": "accepted", "message": null }
  ]
}
```

Expected statuses: `accepted`, `duplicate`, `rejected`.

### `HEAD /v1/files/blobs/:sha256`

Return `200` if a blob exists, `404` if missing.

### `PUT /v1/files/blobs/:sha256`

Request body is raw bytes. The server must compute SHA-256 and reject mismatches.

Response:

```json
{
  "stored": true,
  "size": 12345
}
```

## Recommended Zo architecture

Use a managed User Service rather than `zo.space` because this is a private personal data ingest service with its own long-running process, database files, and blob storage.

- Runtime: Bun + TypeScript.
- Framework: Hono.
- Service mode: private HTTP service if available; otherwise public HTTP service protected by bearer auth.
- Entrypoint: bind to `0.0.0.0:${PORT}`.
- Secret: `ROBIOS_TOKEN` in Zo Settings > Advanced.
- Data root: `/home/workspace/robios-data/` for production service data; repo-ignored `server/data/` for local development.
- Database: SQLite via Bun's built-in `bun:sqlite`, with a DuckDB export/view layer for analysis later.
- Blob store: content-addressed files under `<data-root>/blobs/sha256-prefix/sha256`.

Rationale:

- Bun + Hono keeps the server small, fast, and TypeScript-native while matching Zo's service runtime well.
- SQLite is durable, simple, and sufficient for a single personal iPhone ingest stream.
- Bun's built-in SQLite support avoids extra native dependencies.
- Blob bytes should not be stored inline in the relational database.
- The raw `payload` should be retained exactly for reproducibility, while parsed JSON can be added later for query convenience.
- Bearer auth matches the iOS app and current mock server.

## Repo layout

Current real server layout:

```text
server/
  package.json
  bun.lock
  README.md
  schema.sql
  src/
    index.ts
  scripts/
    smoke-test.ts
```

Keep generated runtime data out of git:

```text
server/data/
robios-data/
*.sqlite
*.sqlite-wal
*.sqlite-shm
```

Update `.gitignore` accordingly.

## Database schema

SQLite tables:

```sql
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  app_version TEXT,
  os_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
  point_id TEXT PRIMARY KEY,
  batch_id INTEGER,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  local_sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  event_date TEXT NOT NULL,
  received_at_device TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash_sha256 TEXT NOT NULL,
  payload_json_valid INTEGER NOT NULL,
  source_id TEXT,
  FOREIGN KEY (batch_id) REFERENCES batches(id)
);

CREATE INDEX IF NOT EXISTS idx_points_stream_event_date ON points(stream, event_date);
CREATE INDEX IF NOT EXISTS idx_points_device_sequence ON points(device_id, local_sequence);
CREATE INDEX IF NOT EXISTS idx_points_payload_hash ON points(payload_hash_sha256);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
```

Optional later tables:

- `point_errors` for rejected records and validation failures.
- `sync_tokens` if the server later supports server-to-client cursor/checkpoint APIs.
- Stream-specific materialized tables, e.g. `health_samples`, `locations`, `contacts`, derived from raw `points`.

## Ingest behavior

For each point:

1. Require `pointId`, `localSequence`, `stream`, `eventDate`, `receivedAt`, `payload`, and `payloadHashSHA256`.
2. Verify `sha256(payload.utf8) == payloadHashSHA256`.
3. Validate that `payload` is valid JSON. Store even if the parsed object is not stream-specific yet.
4. If `point_id` already exists, return `duplicate`.
5. Insert accepted points in one transaction.
6. Record the full batch request in `batches` for audit/debugging.
7. Return per-point statuses exactly matching the current Swift DTOs.

Idempotency key should be `pointId`. Do not use payload hash alone because distinct events can have the same payload.

## Blob behavior

- Validate that `:sha256` is exactly 64 lowercase/uppercase hex characters.
- `HEAD` returns only existence, not JSON.
- `PUT` streams body to a temporary file, computes SHA-256, then atomically renames into content-addressed storage.
- If the blob already exists, update `last_seen_at` and return success.
- Never trust `Content-Length`; compute actual byte length.

## Security plan

Phase 1 security:

- Single shared bearer token via `ROBIOS_TOKEN`.
- Constant-time token comparison.
- Reject missing token with `401`.
- Do not log authorization headers or request bodies by default.
- Keep service private if Zo supports private HTTP services for this account.

Phase 2 hardening:

- Optional per-device tokens returned by `/v1/devices/register`.
- Token rotation plan in app settings.
- Basic request size limits.
- Rate limiting by source IP/device ID.
- Daily encrypted backup of SQLite DB and blobs.

## Deployment on Zo

Implementation steps:

1. Keep the `server/` Bun + Hono implementation matching the mock API.
2. Keep schema initialization on server startup.
3. Run locally:

   ```sh
   cd /home/workspace/robios/server
   bun install
   ROBIOS_TOKEN=dev-secret ROBIOS_DATA_DIR=./data bun run dev
   ```

4. Verify:

   ```sh
   curl -H 'Authorization: Bearer dev-secret' http://127.0.0.1:8080/v1/status
   ```

5. Run smoke test:

   ```sh
   cd /home/workspace/robios/server
   ROBIOS_BASE_URL=http://127.0.0.1:8080 ROBIOS_TOKEN=dev-secret bun run smoke
   ```

6. Register as a Zo User Service:

   - mode: `http`
   - entrypoint: `bash -lc 'cd /home/workspace/robios/server && bun install --frozen-lockfile && bun run start'`
   - env vars: `ROBIOS_DATA_DIR=/home/workspace/robios-data`
   - secret env var: `ROBIOS_TOKEN` from Zo Settings > Advanced
   - visibility: private if available, otherwise public with bearer auth

7. Configure the iOS app Settings tab with the service base URL and the same access key.
8. Run `Sync Now` and confirm records arrive in SQLite.

## Analysis/export plan

Add `server/scripts/export_duckdb.py` to create or refresh:

```text
/home/workspace/robios-data/robios.duckdb
```

Initial DuckDB views/tables:

- `points_raw`
- `points_by_stream_daily`
- `latest_device_status`
- `blob_inventory`

Later, add stream-specific extractors that parse `payload` into typed tables as collectors are implemented.

## Test plan

Automated tests should cover:

- Unauthorized requests return `401`.
- `/v1/status` returns current server shape.
- Device registration upserts by `deviceId`.
- Valid ingest accepts points.
- Re-sending the same point returns `duplicate`.
- Bad payload hash returns `rejected`.
- Mixed accepted/duplicate/rejected batches return correct counts.
- Blob `HEAD` missing/existing behavior.
- Blob `PUT` rejects hash mismatch.
- Blob `PUT` is idempotent.

Manual iPhone flow:

1. Start the Zo server.
2. Point app at the Zo service URL.
3. Enter the shared access key.
4. Use existing test event creation in Sync tab if available.
5. Tap Sync Now.
6. Query SQLite for the latest points.

## Open decisions

- Use private Zo HTTP service vs public bearer-protected endpoint, depending on account support and whether the phone can reach the private URL easily.
- Whether to keep runtime data inside repo-ignored `server/data/` or outside repo at `/home/workspace/robios-data/`.
- Whether to implement DuckDB export immediately or after first successful phone sync.
- Whether the app should switch from a shared token to a registered per-device token after `/v1/devices/register`.
- Whether to add HTTPS/public-domain expectations in the app. The current plan says private HTTP initially, but an iPhone away from the LAN may need a public HTTPS endpoint.

## Implementation checklist

- [x] Create `server/` package.
- [x] Add SQLite schema and startup initialization.
- [x] Implement bearer auth middleware/dependency.
- [x] Implement `GET /v1/status`.
- [x] Implement `POST /v1/devices/register`.
- [x] Implement `POST /v1/ingest` with hash verification and idempotency.
- [x] Implement `HEAD /v1/files/blobs/{sha256}`.
- [x] Implement `PUT /v1/files/blobs/{sha256}` with atomic writes.
- [x] Add a smoke-test script.
- [x] Add server README with local and Zo service commands.
- [x] Update `.gitignore` for runtime data.
- [ ] Register the Zo User Service.
- [ ] Configure the iOS app against the Zo service URL.
- [ ] Perform first end-to-end sync.
