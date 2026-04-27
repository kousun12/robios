# Repository Guidelines

## Project Structure & Module Organization

`robios.xcodeproj` is the Xcode project for the native iOS app. App source lives under `robios/`, organized by responsibility:

- `robios/Models/`: SwiftData models and Codable sync DTOs shared by the client/server contract.
- `robios/Services/`: app services such as settings, local storage, sync orchestration, server API calls, blob upload, and keychain access.
- `robios/Views/`: SwiftUI tabs and screens.
- `robios/Utilities/`: hashing, JSON canonicalization, and sequence helpers.
- `robios/Assets.xcassets/`: app icon, accent color, and other assets.
- `server/`: Bun + Hono + SQLite sync server that implements the real HTTP API for local development and Zo deployment.
- `server/src/index.ts`: HTTP routes, bearer-token auth, SQLite initialization, ingest validation, and blob storage.
- `server/schema.sql`: current SQLite schema snapshot; keep it aligned with server startup schema changes until migrations are added.
- `server/scripts/smoke-test.ts`: server contract smoke test for status, registration, ingest idempotency, and blob upload.
- `tools/mock-server/`: Python standard-library mock sync server for lightweight local contract testing.
- `SERVER_IMPLEMENTATION_PLAN.md`: current server deployment plan, hardening gaps, and Zo rollout checklist.

The project uses Xcode file-system-synchronized groups, so new Swift files placed under `robios/` are picked up by the app target.

## Client/Server Contract

The iOS app and `server/` are coupled and should evolve together. Client-side request/response shapes live in `robios/Models/SyncModels.swift`, with HTTP behavior in `robios/Services/ServerAPI.swift` and `robios/Services/FileBlobUploader.swift`. Server-side behavior lives in `server/src/index.ts`, `server/schema.sql`, and `server/scripts/smoke-test.ts`.

Current authenticated API surface:

- `GET /v1/status`
- `POST /v1/devices/register`
- `POST /v1/ingest`
- `HEAD /v1/files/blobs/:sha256`
- `PUT /v1/files/blobs/:sha256`

All endpoints use `Authorization: Bearer <access key>`. The app stores the access key in Keychain via `AppSettings`; local development defaults to `dev-secret`. Keep request and response field names compatible with Swift `Codable` defaults unless you explicitly add matching `CodingKeys` or decoder/encoder changes on both sides.

`LocalStore` writes pending `DataPoint` records with canonical JSON payload bytes and a SHA-256 payload hash. `/v1/ingest` must verify `sha256(payload.utf8) == payloadHashSHA256`, treat `pointId` as the idempotency key, and return per-point statuses `accepted`, `duplicate`, or `rejected` so `SyncEngine` can update local sync state. File bytes must go through the blob API, not inside the generic JSON ingest payload.

Be careful with timestamps. The Swift client currently uses `JSONEncoder.iso8601` and `JSONDecoder.iso8601`; if the server emits a different RFC 3339 shape, update and verify the Swift decoder and the server smoke/tests together.

## Build, Test, and Development Commands

Build the iOS app:

```sh
xcodebuild -project robios.xcodeproj -scheme robios -destination 'generic/platform=iOS' build
```

Install server dependencies:

```sh
cd server
bun install
```

Start the Bun/Hono server locally:

```sh
cd server
ROBIOS_TOKEN=dev-secret ROBIOS_DATA_DIR=./data bun run dev
```

Run the server smoke test:

```sh
cd server
ROBIOS_BASE_URL=http://127.0.0.1:8080 ROBIOS_TOKEN=dev-secret bun run smoke
```

Start the mock server locally:

```sh
python3 tools/mock-server/robios_mock_server.py --host 127.0.0.1 --port 8080 --token dev-secret
```

Check mock server status:

```sh
curl -H 'Authorization: Bearer dev-secret' http://127.0.0.1:8080/v1/status
```

Use `--host 0.0.0.0` when testing from a physical iPhone on the LAN.

## Coding Style & Naming Conventions

Use Swift 6, SwiftUI, SwiftData, and public Apple frameworks only. Keep app state and service objects `@MainActor` unless there is a specific reason to isolate work elsewhere. Use four-space indentation, `UpperCamelCase` for types, and `lowerCamelCase` for methods and properties. Prefer existing service boundaries: collectors write through `LocalStore`; sync goes through `SyncEngine`, `ServerAPI`, and `FileBlobUploader`.

For the server, use TypeScript on Bun with Hono and Bun's built-in SQLite APIs. Keep runtime data outside git (`server/data/`, `robios-data/`, SQLite sidecar files, blobs). Prefer small route handlers and explicit validation of incoming API payloads. Keep `server/README.md`, `server/schema.sql`, and the smoke test in sync when the server contract changes.

## Testing Guidelines

There is no dedicated iOS test target yet. For app changes, verify with `xcodebuild` and a manual sync flow: start either the Bun server or the mock server, configure the Settings tab with the matching base URL and access key, create a test event in the Sync tab, run Sync Now, and confirm the point is marked synced.

For server changes, run the Bun smoke test against a local server:

```sh
cd server
ROBIOS_BASE_URL=http://127.0.0.1:8080 ROBIOS_TOKEN=dev-secret bun run smoke
```

When the API contract changes, verify both sides: update Swift DTOs/services, server route handling/schema as needed, and the smoke test. When tests are added, prefer XCTest for iOS units named after the unit under test, for example `SyncEngineTests.swift`, and add Bun tests for server auth, registration, ingest validation/idempotency, blob behavior, size limits, and migrations.

## Commit & Pull Request Guidelines

Recent history uses short conventional prefixes such as `feat:` and `chore:`. Keep commit subjects concise and imperative, for example `feat: Add HealthKit checkpoint model`.

Pull requests should include a focused summary, verification steps, and screenshots for UI changes. For API changes, call out client/server contract updates and whether both the iOS app build and server smoke test were run. Link related issues or PLAN.md checklist items. Do not commit Xcode build output, DerivedData, `tools/mock-server/.data/`, `server/data/`, SQLite files, SQLite WAL/SHM files, blobs, `robios-data/`, `node_modules/`, or secrets.

## Security & Configuration Tips

Store the shared access key in Keychain via app settings and provide the same value to the server as `ROBIOS_TOKEN`. Keep mock-server tokens, server tokens, SQLite databases, and blob data local or in Zo secrets/storage; never hard-code production secrets. The production server should use an explicit token and durable data directory such as `ROBIOS_DATA_DIR=/home/workspace/robios-data`.

For iPhone sync, prefer HTTPS for any public Zo service URL. Local-network HTTP is acceptable for development when the phone can reach the host and the app networking settings allow it. Add iOS capabilities, entitlements, Info.plist usage descriptions, and ATS exceptions only in the phase that needs them.
