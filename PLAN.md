# robios - Personal iPhone Data Collection & Sync

## Overview

A personal-use iOS app that collects available data from your iPhone, stores it locally, and incrementally syncs it to your own server for later analysis.

This app is not for App Store distribution and should not use TestFlight. It is installed only on your own device as an Xcode development build or an ad hoc build signed for registered devices. The app should use public Apple APIs only; personal use does not bypass iOS sandboxing, background execution limits, or entitlement requirements.

Goals:

- Collect HealthKit data reliably.
- Collect location data with a low-power default and an explicit optional continuous GPS mode.
- Collect contacts, selected files, device, motion, app lifecycle, photo metadata, and optional Bluetooth/HomeKit data where iOS exposes it.
- Sync only to a configured personal server.
- Avoid third-party SDKs, analytics, TestFlight, App Store services, APNs, WeatherKit, EventKit, and private APIs.

Implementation decisions:

- Product name: `robios`.
- Bundle ID: `com.zocomputer.robios`.
- Toolchain: latest local public Apple toolchain, currently Xcode 26.1.1 with Apple Swift 6.2.1.
- Swift language mode: Swift 6.
- Minimum target: iOS 26.1 or newer. This is for one current personal iPhone, so do not spend implementation effort on older iOS compatibility.
- Install path: Xcode development build or ad hoc build signed for your own registered iPhone.
- Server transport: HTTP to a private server, not public internet HTTPS for the initial build.
- Authentication: one shared secret access key configured on both the app and server, sent as a bearer token.
- Files: selected file/folder sync includes actual file bytes by default, with metadata and content hashes.
- Continuous GPS: persistent setting with clear on/off status; default off.
- Phase 1 includes a tiny local mock server that implements the sync contract for development.

Non-goals:

- No App Store or TestFlight distribution.
- No silent push notifications.
- No WeatherKit dependency.
- No Calendar or Reminders/EventKit collection.
- No private iOS database scraping, jailbreak-only APIs, MDM-only APIs, or undocumented Screen Time extraction.

---

## Platform Reality

iOS still enforces privacy boundaries even when the app is only for your own phone. Approving every permission helps only where Apple provides a public permission/API.

Important constraints:

- HealthKit is feasible and should be treated as the primary required data source.
- Background execution is opportunistic except for specific modes such as location, HealthKit background delivery, Bluetooth events, and scheduled background tasks.
- Continuous GPS is possible, but battery-heavy and visible to the user. It should be an explicit toggle/session mode.
- Screen Time data is intentionally privacy-preserving. Public APIs support monitoring/reporting with restrictions, not a raw export of all app usage history.
- Some capabilities require entitlements in the signed provisioning profile. An entitlement is a code-signing permission Apple grants through Xcode/App ID/provisioning, not just an `Info.plist` string.

---

## Data Sources

### 1. Health & Fitness (HealthKit) - Required

Data types to request, when available on the device/account:

- **Activity**: steps, distance walked/run, flights climbed, active energy, basal energy, exercise minutes, stand hours, VO2 max
- **Heart**: heart rate, resting heart rate, walking heart rate average, HRV, cardio fitness
- **Sleep**: sleep analysis, including in-bed/asleep stages when available
- **Body**: weight, height, BMI, body fat percentage, lean body mass
- **Nutrition**: dietary energy, protein, carbohydrates, fat, caffeine, water
- **Vitals**: blood pressure, respiratory rate, blood oxygen, body temperature
- **Workouts**: type, start/end, duration, distance, energy burned, route references where available
- **Mindfulness**: mindful minutes
- **Mobility**: walking steadiness, walking speed, step length, double support time, stair speed

Collection strategy:

- Request read access for the supported HealthKit types.
- Use `HKObserverQuery` plus `HKAnchoredObjectQuery` for incremental updates.
- Enable HealthKit background delivery for supported types.
- Store per-type HealthKit anchors locally so collection can resume exactly after app restarts.
- On first launch, run a paginated historical backfill.
- Capture HealthKit sample UUID, source bundle ID, source revision, device info, metadata, unit, start date, end date, and deletion events where supported.
- Treat Apple Watch-dependent metrics as conditionally available.

### 2. Location (Core Location)

Default mode:

- Significant location changes.
- Visit monitoring.
- Opportunistic one-shot location snapshots on app launch/foreground and before sync.

Optional continuous GPS mode:

- Explicit user toggle in Settings.
- Uses Always location authorization, `UIBackgroundModes` = `location`, and `allowsBackgroundLocationUpdates`.
- Configurable desired accuracy and distance filter.
- Clear status indicator in the app showing when continuous GPS is active.

Data fields:

- Latitude, longitude, altitude, speed, course, horizontal/vertical accuracy, floor when available, source timestamp, received timestamp.
- Visit arrival/departure events and approximate place coordinates.

Collection strategy:

- Use low-power services by default.
- Use continuous GPS only when enabled.
- Persist every location event before attempting sync.
- Avoid reverse geocoding on-device unless explicitly added later.

### 3. Motion & Activity (Core Motion)

Data types:

- Pedometer summaries: steps, distance, pace, cadence, floors.
- Motion activity classification: stationary, walking, running, cycling, automotive, unknown, confidence.
- Altimeter: relative altitude and pressure when available.
- Raw accelerometer/gyroscope/magnetometer/device-motion samples only during foreground or explicit short recording sessions.

Collection strategy:

- Use `CMMotionActivityManager`, `CMPedometer`, and `CMAltimeter`.
- Query historical pedometer/activity data where available.
- Do not assume raw high-frequency sensor data can be collected continuously in the background.

### 4. Device State

Data types:

- Battery level, charging state, low power mode.
- Device model, OS version, app version/build.
- Thermal state.
- Available storage estimate.
- Network path status: Wi-Fi/cellular/expensive/constrained via Network framework.
- Current Wi-Fi SSID only if the app has the Access Wi-Fi Information entitlement and location authorization.
- Screen brightness and color scheme while app is active.
- Audio route changes while app is active.

Collection strategy:

- Event-driven where notifications exist.
- Periodic foreground snapshots.
- Background snapshots only when the system grants background task runtime.

### 5. Screen Time & App Usage

Baseline app usage, always feasible:

- robios foreground/background timestamps.
- Session duration.
- App launch count.
- Manual sync actions and permission status changes.

Broader Screen Time, optional and constrained:

- Use Screen Time APIs: `FamilyControls`, `DeviceActivity`, `DeviceActivityReport`, and related extensions.
- Add the Family Controls capability/entitlement where available.
- Request authorization from the owner of the device.
- Let the user select apps, categories, and web domains through `FamilyActivityPicker`.
- Use `DeviceActivityMonitor` for scheduled monitoring and threshold callbacks.
- Use `DeviceActivityReport` for privacy-preserving aggregate reports.

Critical limitation:

- iOS does not provide a normal app with a raw, exportable feed of all app launches, app names, foreground durations, notifications, or browser history.
- Family Controls uses opaque tokens and sandboxed extensions. A report extension can render aggregate usage, but Apple designs this path to prevent unrestricted movement of sensitive Screen Time data outside the extension.
- Therefore, Screen Time should be implemented as a feasibility spike. Expected syncable output is likely limited to robios app sessions plus coarse monitor events/aggregates that public APIs permit. If full raw Screen Time export is required, this project cannot promise it using public APIs.

### 6. Media & Photos Metadata (PhotoKit)

Data types:

- Total photo/video counts.
- Recent asset metadata: creation date, modification date, location, dimensions, media type, duration, favorite/hidden status where exposed.

Collection strategy:

- Request Photo Library read permission.
- Scan metadata only.
- Do not sync image/video bytes.
- Respect limited-library authorization if the user chooses it.

### 7. Contacts

Data types:

- Contacts: names, nicknames, organizations, departments, job titles, phone numbers, email addresses, postal addresses, URLs, birthdays, dates, relationships, social profiles, instant-message addresses, contact type, image availability, thumbnail/image data if explicitly enabled.
- Groups and group membership.
- Containers/accounts where iOS exposes them.
- Add/update/delete/drop-everything change events.

Collection strategy:

- Request Contacts permission with `NSContactsUsageDescription`.
- Initial full snapshot using `CNContactFetchRequest`.
- Incremental updates using `CNChangeHistoryFetchRequest` and a persisted Contacts history token.
- Store contact identifiers as device-local source IDs; do not assume they are globally stable across devices.
- Fetch contact notes only if the Contacts Notes entitlement is available and explicitly enabled. Without `com.apple.developer.contacts.notes`, `CNContact.note` is not readable on modern iOS.

Streams:

- `contacts.contact`
- `contacts.group`
- `contacts.container`
- `contacts.change`

### 8. Files & Documents

Scope:

- User-selected files and folders only. iOS does not provide normal apps with global filesystem access.
- Good for documents, exports, PDFs, plain text, Markdown, CSVs, JSON, notes exported from other apps, and project folders the user explicitly grants.

Data types:

- File/folder bookmarks.
- Metadata: path/display name, content type, size, creation/modification dates, file provider domain when available.
- Content hashes for dedupe.
- File bytes for selected files and selected folder contents.
- Directory listings and change snapshots for selected folders.

Collection strategy:

- Use `UIDocumentPickerViewController` / document browser flows to let the user select files or directories.
- Persist security-scoped bookmarks for selected URLs.
- Use coordinated reads where needed for iCloud Drive and third-party file providers.
- Store file metadata in `DataPoint`.
- Upload file bytes through the file blob API, not inside the generic JSON ingest payload.
- Background scanning of third-party file providers may be unreliable; foreground refresh and BGProcessingTask should be treated as best effort.

Streams:

- `files.bookmark`
- `files.metadata`
- `files.directory_snapshot`
- `files.blob`

### 9. Bluetooth & Nearby Devices (Optional)

Data types:

- BLE scan observations where iOS exposes them.
- Connected/discovered peripheral identifiers, names when available, RSSI, advertised service UUIDs.
- iBeacon ranging only for configured beacon identities.

Collection strategy:

- Use Core Bluetooth.
- Add `bluetooth-central` background mode only if we actually implement background BLE behavior.
- Expect iOS background BLE scans to be throttled and service-filtered.

### 10. HomeKit Control (Optional)

Purpose:

- Control HomeKit-compatible accessories and scenes from the app, for example Hue lights that are added to Apple Home.
- Capture lightweight state snapshots and command logs for personal automation history.

Data types:

- Home/room/zone/accessory/service/characteristic metadata where HomeKit exposes it.
- Readable characteristic values, for example light power state, brightness, color temperature, thermostat state, sensor state.
- Commands issued by robios, including target accessory/scene, requested value, result, and error.

Collection and control strategy:

- Add HomeKit capability and `NSHomeKitUsageDescription`.
- Request Home access on-device.
- Use `HMHomeManager` to enumerate homes/accessories/scenes.
- Use readable/writable `HMCharacteristic` values to read and control accessory state.
- Use HomeKit scenes/actions where possible for robust automation.

Important limitations:

- HomeKit is a control surface, not a general-purpose export API for a personal server.
- Remote control while away from home depends on Apple Home infrastructure and a configured home hub, such as HomePod or Apple TV.
- Server-initiated immediate commands are hard if the iPhone app is asleep and we are not using APNs. The server can queue desired commands, and the iPhone app can apply them when it wakes/runs.
- If the goal is reliable server-side home automation, prefer controlling Hue through the Hue Bridge API, Matter, or Home Assistant on the personal server. robios can still log state and expose manual HomeKit controls.

Streams:

- `homekit.accessory_snapshot`
- `homekit.characteristic_value`
- `homekit.command`
- `homekit.scene_trigger`

### 11. Keyboard/Text Metrics (Deferred)

Possible only through a custom keyboard extension and only for text typed through that keyboard. This is privacy-sensitive and not part of the initial build.

---

## Entitlements, Capabilities, and Permissions

Add capabilities only in the phase that needs them. Since this is a single-phone personal build, use the latest Xcode signing/capability UI and current public SDK behavior, but do not add optional or approval-heavy entitlements before their collectors are implemented.

Capabilities/entitlements to use:

| Capability / Entitlement | Why | Notes |
|---|---|---|
| HealthKit | Required health data collection | Enable HealthKit capability; use background delivery APIs where supported |
| Background Modes: Location updates | Optional continuous GPS | Required before setting `allowsBackgroundLocationUpdates` |
| Background Modes: Background fetch | Opportunistic refresh/sync | System scheduled, not guaranteed |
| Background Modes: Background processing | Larger sync/backfill tasks | System scheduled, may be interrupted |
| Background Modes: Bluetooth central | Optional BLE scanning/events | Add only if Bluetooth collector is implemented |
| Family Controls | Optional Screen Time APIs | Development entitlement may be available; ad hoc distribution may require Apple approval |
| Access Wi-Fi Information | Wi-Fi SSID | Requires entitlement plus location authorization |
| Local Network | Sync to local LAN server | Required for local network privacy prompt |
| HomeKit | Optional home accessory control | Add only if HomeKit module is implemented |
| Contacts Notes | Optional contact notes | Requires Apple-granted entitlement; skip if unavailable |
| Keychain access | Store server token | Use default app keychain access group |

Info.plist usage descriptions:

| Permission | Info.plist Key |
|---|---|
| HealthKit read access | `NSHealthShareUsageDescription` |
| Location when in use | `NSLocationWhenInUseUsageDescription` |
| Location always | `NSLocationAlwaysAndWhenInUseUsageDescription` |
| Motion & Fitness | `NSMotionUsageDescription` |
| Bluetooth | `NSBluetoothAlwaysUsageDescription` |
| Photo Library | `NSPhotoLibraryUsageDescription` |
| Contacts | `NSContactsUsageDescription` |
| HomeKit | `NSHomeKitUsageDescription` |
| Local Network | `NSLocalNetworkUsageDescription` |

Explicitly not included:

- WeatherKit entitlement.
- Push Notifications / APNs.
- Calendar and Reminders permissions.

---

## Architecture

```
SwiftUI Views
  Dashboard / Data Browser / Sync / Settings

DataOrchestrator
  Starts collectors, records status, schedules sync

Collectors
  Health / Location / Motion / Device / ScreenTime / Photos / Contacts / Files / Bluetooth / HomeKit

LocalStore
  Append-only DataPoint records
  Collector checkpoints
  Sync checkpoints

SyncEngine
  Incremental batching
  Idempotent upload
  Retry/backoff
  Local pruning policy

BackgroundTaskManager
  BGAppRefreshTask
  BGProcessingTask
  Background location hooks
  HealthKit background delivery hooks
```

### Key Design Decisions

- Swift 6 language mode + SwiftUI, using Apple Swift 6.2.1 or newer.
- Target iOS 26.1 or newer; no older-device compatibility shims.
- SwiftData for initial local persistence; revisit SQLite if write volume becomes the bottleneck.
- Public Apple frameworks only.
- Offline-first: all collection writes local records before sync.
- Append-only event log with typed categories and versioned JSON payloads.
- Idempotent sync protocol so retries and duplicate uploads are safe.
- Per-collector checkpoints are separate from sync checkpoints.
- Token stored in Keychain; server URL stored in app settings.

### Local Data Model

Core `DataPoint` fields:

```swift
@Model
final class DataPoint {
    var localSequence: Int64
    var id: UUID // API client_point_id
    var deviceId: UUID
    var stream: String
    var schemaVersion: Int
    var source: String
    var sourceRecordId: String?
    var startedAt: Date?
    var endedAt: Date?
    var recordedAt: Date
    var receivedAt: Date
    var timezone: String
    var payload: Data
    var payloadHash: String
    var deleted: Bool
    var syncState: String
    var syncedAt: Date?
    var syncAttemptCount: Int
    var lastSyncError: String?
}
```

Examples of `stream`:

- `health.quantity.step_count`
- `health.category.sleep_analysis`
- `health.workout`
- `location.gps`
- `location.visit`
- `motion.activity`
- `motion.pedometer`
- `device.battery`
- `app.session`
- `photos.asset_metadata`
- `contacts.contact`
- `files.metadata`
- `bluetooth.observation`
- `homekit.command`
- `screentime.monitor_event`

Indexes:

- `localSequence`
- `(syncState, localSequence)`
- `(stream, recordedAt)`
- `(deviceId, source, sourceRecordId)`
- `payloadHash`

Collector checkpoint model:

```swift
@Model
final class CollectorCheckpoint {
    var collector: String
    var stream: String
    var cursor: Data?
    var updatedAt: Date
}
```

HealthKit anchors live here, keyed by HealthKit type identifier.

---

## Server Sync API Contract

The server does not exist yet, so this contract defines both sides. The design assumes an append-only event table on the server, with unique constraints for dedupe.

### Transport

- Base URL configured in app.
- Initial server URL is plain HTTP to a private server, for example `http://rob-server.local:8080`.
- Because iOS App Transport Security blocks arbitrary HTTP by default, add a narrowly scoped ATS exception for the private server host/IP used during development.
- Authentication uses a long-lived shared secret access key configured on both the server and app.
- The app sends the shared secret as a bearer token.
- Token is stored in Keychain.
- Requests and responses use JSON.
- Client may gzip large ingest requests with `Content-Encoding: gzip`.

Common headers:

```http
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-robios-Protocol-Version: 1
```

### Identity

The app creates and persists:

- `device_id`: stable UUID for the physical phone/install pairing.
- `installation_id`: UUID reset if the app is deleted/reinstalled.

Each `DataPoint` has:

- `client_point_id`: stable UUID generated by the app.
- `source_record_id`: source-native identifier when available, such as HealthKit sample UUID.
- `payload_hash`: SHA-256 of canonical payload plus key metadata.

Server dedupe rule:

- Primary idempotency key: `(device_id, client_point_id)`.
- Secondary dedupe key where useful: `(device_id, stream, source, source_record_id)`.
- Payload conflict on same id is a server error and should be surfaced.

### GET `/v1/status`

Checks server reachability and protocol compatibility.

Response:

```json
{
  "ok": true,
  "server_time": "2026-04-25T15:00:00Z",
  "protocol_version": 1,
  "max_points_per_batch": 500,
  "max_body_bytes": 1048576
}
```

### POST `/v1/devices/register`

Optional but useful first-run handshake. If skipped, the server can auto-create the device on first ingest.

Request:

```json
{
  "device_id": "7C5B5D0D-4F6C-4E44-90E5-111111111111",
  "installation_id": "A8C3C490-7A21-4C4F-8EF5-222222222222",
  "device_name": "Rob's iPhone",
  "model": "iPhone",
  "os_name": "iOS",
  "os_version": "18.4",
  "app_version": "1.0",
  "app_build": "1"
}
```

Response:

```json
{
  "ok": true,
  "device_id": "7C5B5D0D-4F6C-4E44-90E5-111111111111",
  "server_device_id": "srv_abc123"
}
```

### POST `/v1/ingest`

Uploads an ordered, idempotent batch of unsynced points.

Request:

```json
{
  "protocol_version": 1,
  "batch_id": "E42F0E50-0D64-40D4-97E7-333333333333",
  "device_id": "7C5B5D0D-4F6C-4E44-90E5-111111111111",
  "installation_id": "A8C3C490-7A21-4C4F-8EF5-222222222222",
  "created_at": "2026-04-25T15:00:00Z",
  "local_sequence_min": 1001,
  "local_sequence_max": 1500,
  "points": [
    {
      "client_point_id": "2D2715A6-7A5E-4D0D-9F9A-444444444444",
      "local_sequence": 1001,
      "stream": "health.quantity.heart_rate",
      "schema_version": 1,
      "source": "healthkit",
      "source_record_id": "HKSampleUUID",
      "started_at": "2026-04-25T14:58:12Z",
      "ended_at": "2026-04-25T14:58:12Z",
      "recorded_at": "2026-04-25T14:58:12Z",
      "received_at": "2026-04-25T14:58:20Z",
      "timezone": "America/New_York",
      "deleted": false,
      "payload_hash": "sha256:...",
      "payload": {
        "quantity": 72,
        "unit": "count/min",
        "source_bundle_id": "com.apple.health",
        "source_name": "Apple Watch",
        "metadata": {}
      }
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "batch_id": "E42F0E50-0D64-40D4-97E7-333333333333",
  "server_received_at": "2026-04-25T15:00:02Z",
  "accepted": [
    {
      "client_point_id": "2D2715A6-7A5E-4D0D-9F9A-444444444444",
      "server_point_id": "pt_abc123"
    }
  ],
  "duplicate": [],
  "rejected": [],
  "server_watermark": {
    "device_id": "7C5B5D0D-4F6C-4E44-90E5-111111111111",
    "max_local_sequence": 1001
  }
}
```

Partial rejection response still uses HTTP 200 if the request was valid:

```json
{
  "ok": false,
  "batch_id": "E42F0E50-0D64-40D4-97E7-333333333333",
  "accepted": [],
  "duplicate": [],
  "rejected": [
    {
      "client_point_id": "2D2715A6-7A5E-4D0D-9F9A-444444444444",
      "code": "schema_validation_failed",
      "message": "Missing payload.unit",
      "retryable": false
    }
  ]
}
```

Client behavior:

- Mark accepted and duplicate points as synced.
- Keep retryable rejections pending with backoff.
- Mark non-retryable rejections as failed and visible in the Sync view.
- Never delete local data solely because it was uploaded; pruning is a separate setting.

### File Blob Uploads

File metadata is synced through `/v1/ingest` as normal `DataPoint` records. File bytes use a content-addressed blob endpoint so large binary data does not bloat the event stream.

Selected files and folders sync actual file bytes by default. The `files.metadata` payload references the content blob:

```json
{
  "display_name": "notes.md",
  "content_type": "net.daringfireball.markdown",
  "size_bytes": 12048,
  "modified_at": "2026-04-25T14:40:00Z",
  "blob_sha256": "4d967c...",
  "blob_uploaded": false
}
```

Check whether the server already has a blob:

```http
HEAD /v1/files/blobs/4d967c...
Authorization: Bearer <token>
```

Upload a missing blob:

```http
PUT /v1/files/blobs/4d967c...
Authorization: Bearer <token>
Content-Type: application/octet-stream
X-robios-Blob-SHA256: 4d967c...
X-robios-Blob-Size: 12048
```

Blob response:

```json
{
  "ok": true,
  "sha256": "4d967c...",
  "size_bytes": 12048,
  "stored": true,
  "duplicate": false
}
```

Server behavior:

- Verify the received byte count and SHA-256 before marking a blob stored.
- Treat `PUT` as idempotent when the hash already exists.
- Keep file metadata and blob storage separate; multiple file metadata records can reference the same blob hash.

### Mock Server

Phase 1 includes a tiny development mock server, intended to run on the Mac or private server while building the iPhone app.

Implementation location: `tools/mock-server/robios_mock_server.py`, using Python 3 standard library only unless a separate server repo is created later.

Responsibilities:

- Listen on local HTTP, default `http://127.0.0.1:8080` for simulator/Mac tests and `0.0.0.0:8080` with a LAN base URL for the physical iPhone.
- Require the same bearer access key as the app.
- Implement `GET /v1/status`.
- Implement `POST /v1/devices/register`.
- Implement `POST /v1/ingest`.
- Implement `HEAD /v1/files/blobs/{sha256}`.
- Implement `PUT /v1/files/blobs/{sha256}`.
- Persist received JSON batches and blobs to a local directory.
- Validate basic request shape, bearer token, blob size, and blob hash.

This is not the production server. It exists so the app's sync engine can be exercised before the real database-backed server is built.

### GET `/v1/sync/state?device_id=<uuid>`

Returns what the server believes it has for a device. Useful after reinstall, server restore, or debugging.

Response:

```json
{
  "device_id": "7C5B5D0D-4F6C-4E44-90E5-111111111111",
  "max_local_sequence": 1500,
  "last_ingest_at": "2026-04-25T15:00:02Z",
  "counts_by_stream": {
    "health.quantity.heart_rate": 9281,
    "location.gps": 312
  }
}
```

### Error Semantics

| HTTP Status | Meaning | Client Action |
|---|---|---|
| 200 | Valid request; inspect accepted/duplicate/rejected | Mark per-point result |
| 400 | Malformed JSON or unsupported protocol | Stop and show error |
| 401/403 | Bad token or unauthorized device | Stop and show auth error |
| 409 | Idempotency conflict | Stop affected records and show error |
| 413 | Batch too large | Reduce batch size |
| 429 | Rate limited | Back off using `Retry-After` |
| 500/502/503/504 | Server unavailable | Retry with exponential backoff |

### Server Storage Expectations

Minimum server tables:

- `devices`
- `ingest_batches`
- `data_points`
- `file_blobs`

Recommended unique constraints:

- `data_points(device_id, client_point_id)`
- `data_points(device_id, stream, source, source_record_id)` where `source_record_id is not null`
- `ingest_batches(device_id, batch_id)`
- `file_blobs(sha256)`

The server should store:

- Original JSON payload.
- Parsed common timestamps.
- Stream/category.
- Source identifiers.
- Payload hash.
- Ingest timestamp.
- App/device metadata.
- Blob hash, size, content type, and storage path for uploaded files.

---

## Sync Engine Behavior

Triggers:

- App foreground.
- Manual Sync button.
- After HealthKit background delivery handling.
- After significant location or visit events.
- BGAppRefreshTask when granted.
- BGProcessingTask when granted.

Batching:

- Query pending points ordered by `localSequence`.
- Default batch size: 500 points or 1 MB, whichever comes first.
- Generate a new `batch_id` per upload attempt.
- Upload.
- Mark accepted/duplicate as synced.
- Retry failures with exponential backoff and jitter.

Incremental guarantees:

- Every local point has a monotonic `localSequence`.
- Uploads are ordered but server correctness does not depend on exactly-once delivery.
- Dedupe is server-enforced.
- Collector checkpoints are advanced only after source data is durably written locally, not after sync.

Pruning:

- Default: keep all local data.
- Optional setting later: delete synced payloads older than N days while retaining minimal index/status rows.

---

## Project Structure

```
robios/
├── robios.xcodeproj
├── robios/
│   ├── robiosApp.swift
│   ├── ContentView.swift
│   ├── Models/
│   │   ├── DataPoint.swift
│   │   ├── CollectorCheckpoint.swift
│   │   └── SyncModels.swift
│   ├── Collectors/
│   │   ├── HealthCollector.swift
│   │   ├── LocationCollector.swift
│   │   ├── MotionCollector.swift
│   │   ├── DeviceCollector.swift
│   │   ├── ScreenTimeCollector.swift
│   │   ├── PhotoCollector.swift
│   │   ├── ContactsCollector.swift
│   │   ├── FilesCollector.swift
│   │   └── BluetoothCollector.swift
│   ├── Services/
│   │   ├── DataOrchestrator.swift
│   │   ├── LocalStore.swift
│   │   ├── SyncEngine.swift
│   │   ├── ServerAPI.swift
│   │   ├── FileBlobUploader.swift
│   │   ├── HomeKitController.swift
│   │   └── BackgroundTaskManager.swift
│   ├── Views/
│   │   ├── DashboardView.swift
│   │   ├── DataBrowserView.swift
│   │   ├── SyncStatusView.swift
│   │   └── SettingsView.swift
│   └── Utilities/
│       ├── JSONCanonicalizer.swift
│       └── Extensions.swift
├── ScreenTimeReportExtension/
├── ScreenTimeMonitorExtension/
├── tools/
│   └── mock-server/
│       └── robios_mock_server.py
└── PLAN.md
```

Screen Time extension targets are optional and should be added only if the feasibility spike confirms they produce useful syncable data under public API rules.

---

## Implementation Phases

### Phase 1: Local App Skeleton + Mock Sync Server

- Use bundle ID `com.zocomputer.robios`.
- Target iOS 26.1 or newer with the latest installed public SDK.
- Use Swift 6 language mode.
- Use Xcode automatic signing with Substrate Labs Inc. team `C8HFK26MUS` for the registered iPhone.
- Create SwiftUI shell: Dashboard, Data, Sync, Settings.
- Add local `DataPoint`, `CollectorCheckpoint`, and sync status models.
- Implement append-only local writes.
- Implement server settings: HTTP base URL and shared secret access key.
- Store access key in Keychain.
- Implement `/v1/status` and `/v1/ingest` client.
- Implement file blob upload client.
- Add tiny mock server for local contract testing.
- Add manual test event creation and manual sync.

### Phase 2: HealthKit Required Path

- Add HealthKit capability and permissions.
- Build HealthKit type registry.
- Implement historical backfill with anchors.
- Implement observer queries and anchored incremental fetch.
- Enable background delivery where supported.
- Persist HealthKit samples and deletions into `DataPoint`.
- Sync to server contract.

### Phase 3: Location

- Implement low-power significant-change and visit collection.
- Add optional continuous GPS setting.
- Add location background mode.
- Add clear UI state for continuous GPS.
- Sync location events.

### Phase 4: Contacts, Files, Device, Motion, Photos

- Add Contacts permission and collector.
- Implement full Contacts snapshot and change-history incremental sync.
- Add user-selected Files/Documents picker.
- Persist security-scoped bookmarks.
- Sync file metadata and optional blobs.
- Add device state snapshots and notifications.
- Add pedometer/activity/altimeter collectors.
- Add foreground/explicit-session raw motion sampling only if useful.
- Add PhotoKit metadata scanner.

### Phase 5: Optional Bluetooth and HomeKit

- Add Bluetooth collector if still desired.
- Add HomeKit capability if still desired.
- Build accessory/scene browser.
- Add command execution and command logs.
- Keep server-queued commands best effort unless a reliable wake mechanism is added.

### Phase 6: Screen Time Feasibility Spike

- Add Family Controls capability if available.
- Request individual authorization.
- Build a small FamilyActivityPicker flow.
- Add DeviceActivity monitor/report extension targets.
- Determine exactly which values can be legally and technically persisted/synced.
- If useful, add `screentime.monitor_event` or aggregate streams.
- If not useful, keep only robios app lifecycle tracking.

### Phase 7: Dashboard & Operations

- Dashboard with collector health, last sample times, and sync backlog.
- Data browser with stream/date filters.
- Sync error details and retry controls.
- Export diagnostics bundle.
- Optional local pruning policy.

---

## Open Questions

- Should local data be encrypted beyond iOS file protection and device passcode?
- Which HealthKit types are most important for the first backfill?
- Is coarse Screen Time aggregate data useful enough if raw app usage export is unavailable?
- Should HomeKit stay as local/manual control in the iPhone app, or should reliable server-side home automation be handled by Home Assistant/Hue/Matter directly on the server?
