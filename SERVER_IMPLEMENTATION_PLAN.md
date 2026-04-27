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

Response shape. All timestamps in the server API must be RFC 3339 UTC strings without fractional seconds, e.g. `2026-04-26T19:30:00Z`, unless the Swift client decoder is explicitly changed to accept fractional seconds.

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
- Service mode: public HTTPS endpoint for phone sync. A private Zo HTTP service is acceptable only for server-local smoke tests or if the iPhone can actually reach that private URL.
- Entrypoint: bind to `0.0.0.0:${PORT}`.
- Secret: `ROBIOS_TOKEN` in Zo Settings > Advanced.
- Data root: `/home/workspace/robios-data/` for production service data; repo-ignored `server/data/` for local development.
- Database: SQLite via Bun's built-in `bun:sqlite`, with a DuckDB export/view layer for analysis later.
- Blob store: content-addressed files under `<data-root>/blobs/sha256-prefix/sha256`.
- Request limits: enforced in Phase 1 before accepting public traffic.

Rationale:

- Bun + Hono keeps the server small, fast, and TypeScript-native while matching Zo's service runtime well.
- SQLite is durable, simple, and sufficient for a single personal iPhone ingest stream.
- Bun's built-in SQLite support avoids extra native dependencies.
- Blob bytes should not be stored inline in the relational database.
- The raw `payload` should be retained exactly for reproducibility, while parsed JSON can be added later for query convenience.
- Bearer auth matches the iOS app and current mock server.
- iPhone sync needs a URL that passes iOS networking rules. The current app permits local-network HTTP, but public non-HTTPS HTTP should not be assumed to work.

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

Schema management:

- Create a `schema_migrations` table before first production deployment.
- Apply migrations in order at startup inside a transaction.
- Keep `schema.sql` as the current full schema snapshot, but do not rely only on `CREATE TABLE IF NOT EXISTS` once real data exists.
- During this spike, either freeze the initial schema before the first Zo sync or add the migration runner before deploying.

Optional later tables:

- `point_errors` for rejected records and validation failures.
- `sync_tokens` if the server later supports server-to-client cursor/checkpoint APIs.
- Stream-specific materialized tables, e.g. `health_samples`, `locations`, `contacts`, derived from raw `points`.

## Ingest behavior

For each point:

1. Require `pointId`, `localSequence`, `stream`, `eventDate`, `receivedAt`, `payload`, and `payloadHashSHA256`.
2. Verify `sha256(payload.utf8) == payloadHashSHA256`.
3. Validate that `payload` is valid JSON. Store even if the parsed object is not stream-specific yet.
4. Insert accepted points with an atomic idempotency operation, for example `INSERT ... ON CONFLICT(point_id) DO NOTHING`.
5. If the insert does not create a row because `point_id` already exists, return `duplicate`.
6. Wrap batch creation, accepted point inserts, duplicate/rejected counting, and the final batch counter update in one database transaction.
7. Record the full batch request in `batches` for audit/debugging.
8. If the transaction fails after validation, return a non-2xx error and do not mark any points synced on the client.
9. Return per-point statuses exactly matching the current Swift DTOs.

Idempotency key should be `pointId`. Do not use payload hash alone because distinct events can have the same payload.

Phase 1 request limits:

- Maximum JSON ingest body size: 5 MiB.
- Maximum points per ingest batch: 1,000.
- Maximum single `payload` string size: 512 KiB.
- Maximum blob upload size: 250 MiB unless a specific collector needs more.
- Reject oversized requests with `413`.
- Reject malformed JSON with `400`.
- Keep these limits configurable with environment variables, but default them conservatively for public service use.

## Blob behavior

- Validate that `:sha256` is exactly 64 lowercase/uppercase hex characters.
- `HEAD` returns only existence, not JSON.
- `PUT` streams body to a temporary file, computes SHA-256, then atomically renames into content-addressed storage.
- If the blob already exists, update `last_seen_at` and return success.
- Never trust `Content-Length`; compute actual byte length.

## Security plan

Phase 1 security:

- Single shared bearer token via `ROBIOS_TOKEN`.
- Production startup must fail if `ROBIOS_TOKEN` is missing. A local development default such as `dev-secret` is acceptable only behind an explicit development mode or local-only environment.
- Constant-time token comparison.
- Reject missing token with `401`.
- Do not log authorization headers or request bodies by default.
- Expose phone sync through HTTPS. Do not rely on a public plain-HTTP endpoint for iPhone sync.
- Keep any private HTTP service as an internal/local smoke-test surface only.
- Enforce Phase 1 request size limits before body parsing when possible.

Phase 2 hardening:

- Optional per-device tokens returned by `/v1/devices/register`.
- Token rotation plan in app settings.
- Rate limiting by source IP/device ID.
- Daily encrypted backup of SQLite DB and blobs.

## Deployment on Zo

Implementation steps:

1. Keep the `server/` Bun + Hono implementation matching the mock API.
2. Keep schema initialization and migration application on server startup.
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
   - setup command: `cd /home/workspace/robios/server && bun install --frozen-lockfile`
   - entrypoint: `bash -lc 'cd /home/workspace/robios/server && bun run start'`
   - env vars: `ROBIOS_DATA_DIR=/home/workspace/robios-data`
   - secret env var: `ROBIOS_TOKEN` from Zo Settings > Advanced
   - visibility: public HTTPS for iPhone sync, or private only for local/server-side smoke tests

7. Confirm the externally reachable service URL from the iPhone:

   - Use an HTTPS URL for public Zo sync.
   - Use local-network HTTP only when the phone and server are on the same LAN and the app's local-network ATS allowance applies.
   - Do not use public plain HTTP unless the app gains an explicit, reviewed ATS exception.

8. Configure the iOS app Settings tab with the service base URL and the same access key.
9. Run `Sync Now` and confirm records arrive in SQLite.

Keep `server/README.md` in sync with these deployment steps. The README should not recommend installing dependencies in the service entrypoint, should call out the production `ROBIOS_TOKEN` requirement, and should describe the HTTPS or local-network HTTP reachability requirement for iPhone sync.

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
- `/v1/status` timestamps decode in the current Swift client format.
- Device registration upserts by `deviceId`.
- Valid ingest accepts points.
- Re-sending the same point returns `duplicate`.
- Bad payload hash returns `rejected`.
- Mixed accepted/duplicate/rejected batches return correct counts.
- Ingest uses atomic idempotency for duplicate points.
- Oversized ingest body, oversized batch, oversized payload, and oversized blob upload are rejected.
- Malformed JSON returns `400`.
- Blob `HEAD` missing/existing behavior.
- Blob `PUT` rejects hash mismatch.
- Blob `PUT` is idempotent.
- Migration runner applies the initial schema and refuses unknown migration states.

Manual iPhone flow:

1. Start the Zo server.
2. Confirm the phone can reach the service URL over HTTPS, or over local-network HTTP on the same LAN.
3. Enter the shared access key.
4. Use existing test event creation in Sync tab if available.
5. Tap Sync Now.
6. Query SQLite for the latest points.

## Open decisions

- Whether Zo's managed public endpoint provides HTTPS directly or needs a tunnel/domain in front of the User Service.
- Whether to keep local development runtime data inside repo-ignored `server/data/` or use an external local path. Production data should live outside the repo at `/home/workspace/robios-data/`.
- Whether to implement DuckDB export immediately or after first successful phone sync.
- Whether the app should switch from a shared token to a registered per-device token after `/v1/devices/register`.
- Timestamp policy: server-generated API timestamps are no-fraction RFC 3339 UTC strings. Revisit only if the Swift decoder is changed to accept a broader timestamp format.

## Current implementation status

The Bun/Hono server now covers the local production-readiness items from this plan:

- `ROBIOS_TOKEN` is required by default. `ROBIOS_ALLOW_DEV_TOKEN=1` enables the local-only `dev-secret` fallback.
- Schema migrations are tracked in `schema_migrations` and applied at startup.
- Server-generated timestamps use RFC 3339 UTC without fractional seconds.
- Phase 1 ingest, batch, payload, and blob upload limits are enforced with configurable environment variables.
- Blob uploads stream to a temporary file while hashing and enforcing the size limit.
- Ingest uses `ON CONFLICT(point_id) DO NOTHING` inside a transaction that also creates and updates the batch row.
- Automated Bun tests cover auth, status, registration, ingest, limits, blobs, and migration state.
- `server/README.md` matches the local and Zo deployment commands.

Remaining work requires the deployment target and phone:

- Confirm public HTTPS or LAN HTTP reachability from the iPhone.
- Register the Zo User Service.
- Configure the iOS app against the Zo service URL.
- Perform the first end-to-end sync.

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
- [x] Require explicit `ROBIOS_TOKEN` for production startup.
- [x] Add schema migration tracking before first production sync.
- [x] Enforce API timestamp format compatible with the Swift client.
- [x] Enforce Phase 1 request size limits.
- [x] Stream blob uploads to temporary files while hashing and enforcing size limits.
- [x] Make ingest duplicate handling atomic.
- [x] Add automated server tests for auth, status, registration, ingest, blobs, limits, and migrations.
- [x] Update `server/README.md` to match the production deployment plan.
- [ ] Confirm public HTTPS or LAN HTTP reachability from the iPhone.
- [ ] Register the Zo User Service.
- [ ] Configure the iOS app against the Zo service URL.
- [ ] Perform first end-to-end sync.
