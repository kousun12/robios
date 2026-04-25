# iosrob - Personal Data Collection & Sync

## Overview

A personal-use iOS app that continuously collects all available sensor, health, location, and device data from your iPhone, stores it locally, and syncs it to your own server for later analysis. Not intended for App Store distribution — runs via Xcode/TestFlight on your own device.

---

## Data Sources

### 1. Health & Fitness (HealthKit)

- **Activity**: steps, distance walked/run, flights climbed, active energy, basal energy, exercise minutes, stand hours, VO2 max
- **Heart**: heart rate, resting heart rate, walking heart rate average, HRV, cardio fitness
- **Sleep**: sleep analysis (in bed, asleep core, asleep deep, asleep REM, awake)
- **Body**: weight, height, BMI, body fat %, lean body mass
- **Nutrition**: dietary energy, protein, carbs, fat, caffeine, water
- **Vitals**: blood pressure, respiratory rate, blood oxygen (SpO2), body temperature
- **Workouts**: type, duration, distance, energy burned, route (GPS), heart rate zones
- **Mindfulness**: mindful minutes
- **Other**: walking steadiness, walking speed, step length, double support time, stair speed

Collection strategy: Use `HKObserverQuery` + `HKAnchoredObjectQuery` with background delivery to get near-real-time updates for all types. On first launch, do a historical backfill.

### 2. Location (Core Location)

- **Continuous GPS**: latitude, longitude, altitude, speed, course, horizontal/vertical accuracy
- **Visits**: arrival/departure at significant places (CLVisitMonitor)
- **Significant location changes**: low-power background triggers
- **Region monitoring**: geofences for home, work, gym, etc. (optional)

Collection strategy: Use "Always" location permission. Run continuous background location with `allowsBackgroundLocationUpdates`. Use significant location changes as a fallback when app is suspended. Log every location update with timestamp.

### 3. Motion & Activity (Core Motion)

- **Device motion**: accelerometer (x, y, z), gyroscope (x, y, z), magnetometer
- **Pedometer**: real-time step count, distance, pace, cadence, floors
- **Activity recognition**: stationary, walking, running, cycling, automotive, unknown
- **Altitude**: barometric pressure, relative altitude changes

Collection strategy: `CMMotionActivityManager` for activity classification. `CMAltimeter` for pressure. Pedometer for step data. Raw motion sampled periodically (e.g., every 10s when awake).

### 4. Screen Time & Device State

- **Battery**: level, charging state, low power mode
- **Device info**: model, OS version, storage usage, thermal state
- **Connectivity**: WiFi SSID (with location permission), cellular carrier, network type
- **Display**: brightness level, dark mode status
- **Audio**: volume level, audio route (speaker, headphones, AirPods)

Collection strategy: Periodic polling via timers + `NotificationCenter` observers for state changes.

### 5. Weather (WeatherKit)

- **Current conditions**: temperature, humidity, UV index, wind speed/direction, pressure, visibility, cloud cover, condition description
- **Forecasts**: hourly and daily forecasts tied to your location

Collection strategy: Fetch weather on each significant location change or every 30 minutes, whichever comes first.

### 6. Calendar & Reminders (EventKit)

- **Calendar events**: title, start/end time, location, duration, calendar name
- **Reminders**: title, due date, completion status

Collection strategy: Snapshot on launch + `EKEventStoreChanged` notification observer.

### 7. Notifications & App Usage

- **Notification history**: via `UNUserNotificationCenter` (limited to your own app's notifications)
- **App session tracking**: foreground/background timestamps, session duration

Collection strategy: Log app lifecycle events. Track session start/end.

### 8. Media & Photos Metadata (PhotoKit)

- **Photo count**: total photos/videos in library
- **Recent photos metadata**: creation date, location, camera model, dimensions (no pixel data synced)

Collection strategy: Periodic metadata scan, not syncing actual images.

### 9. Bluetooth & Nearby Devices

- **Connected peripherals**: names, UUIDs of paired/nearby BLE devices
- **Nearby iBeacons**: if configured

Collection strategy: `CBCentralManager` scan on interval.

### 10. Keyboard & Text Metrics (Optional)

- **Custom keyboard could track**: words per minute, typing sessions (privacy-sensitive, implement only if desired)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   SwiftUI Views                  │
│         Dashboard / Status / History / Logs      │
├─────────────────────────────────────────────────┤
│                  DataOrchestrator                │
│      Coordinates all collectors & sync           │
├──────────┬──────────┬──────────┬────────────────┤
│ Health   │ Location │ Motion   │ Device/Weather │
│ Collector│ Collector│ Collector│ Collector      │
├──────────┴──────────┴──────────┴────────────────┤
│              Local Storage (SwiftData)           │
│         Unified DataPoint model + metadata       │
├─────────────────────────────────────────────────┤
│                  SyncEngine                       │
│     Batched upload to server, retry, dedup       │
├─────────────────────────────────────────────────┤
│              Background Tasks                    │
│    BGAppRefreshTask + BGProcessingTask           │
└─────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Swift 6 + SwiftUI** — modern concurrency throughout (async/await, actors)
- **SwiftData** for local persistence — lightweight, Apple-native, no external deps
- **Zero third-party dependencies** — everything uses Apple frameworks
- **Actor-based collectors** — each data source is an isolated actor to avoid threading issues
- **Unified data model** — all data stored as typed `DataPoint` records with a category, timestamp, and JSON payload
- **Offline-first** — everything works without a server; sync is opportunistic
- **Background execution** — uses every available background mode (location, fetch, processing, health background delivery)

### Data Model (Core)

```swift
@Model
class DataPoint {
    var id: UUID
    var category: String        // "health.steps", "location.gps", "device.battery", etc.
    var timestamp: Date
    var payload: Data           // JSON-encoded value(s)
    var synced: Bool
    var syncedAt: Date?
}
```

### Sync Engine

- Batches unsynced `DataPoint` records (e.g., 500 at a time)
- POST to `{serverURL}/api/ingest` as JSON array
- Server responds with accepted IDs — marks them synced locally
- Exponential backoff on failure
- Runs on: app foreground, background fetch, background processing task, significant location change
- Server URL configurable in-app (stored in UserDefaults/AppStorage)

### Background Execution Strategy

| Mechanism | Used For |
|---|---|
| Background Location | Continuous GPS + triggers sync |
| HealthKit Background Delivery | Heart rate, steps, sleep, workouts |
| BGAppRefreshTask | Periodic device state snapshot |
| BGProcessingTask | Large batch sync, historical backfill |
| Silent Push Notifications | Server-triggered sync (future) |

---

## Server API Contract (Minimal)

The app will POST to these endpoints. Backend implementation is deferred.

```
POST /api/ingest
Content-Type: application/json
Authorization: Bearer {token}

Body: {
  "device_id": "uuid",
  "points": [
    {
      "id": "uuid",
      "category": "health.heart_rate",
      "timestamp": "2026-02-08T12:00:00Z",
      "payload": { "bpm": 72 }
    },
    ...
  ]
}

Response: { "accepted": ["uuid1", "uuid2", ...] }
```

```
GET /api/status
Authorization: Bearer {token}

Response: { "ok": true, "last_sync": "2026-02-08T..." }
```

---

## Permissions Required

| Permission | Reason | Info.plist Key |
|---|---|---|
| HealthKit (all types) | Read health data | `NSHealthShareUsageDescription` |
| Location Always | Background GPS | `NSLocationAlwaysAndWhenInUseUsageDescription` |
| Motion & Fitness | Activity recognition | `NSMotionUsageDescription` |
| Calendars | Read events | `NSCalendarsUsageDescription` |
| Reminders | Read reminders | `NSRemindersUsageDescription` |
| Bluetooth | Scan nearby devices | `NSBluetoothAlwaysUsageDescription` |
| Photo Library | Read metadata | `NSPhotoLibraryUsageDescription` |
| Local Network | Sync to local server | `NSLocalNetworkUsageDescription` |

---

## Project Structure

```
iosrob/
├── iosrob.xcodeproj
├── iosrob/
│   ├── App.swift                      # @main entry point
│   ├── ContentView.swift              # Tab-based root view
│   ├── Models/
│   │   └── DataPoint.swift            # SwiftData model
│   ├── Collectors/
│   │   ├── HealthCollector.swift       # HealthKit
│   │   ├── LocationCollector.swift     # Core Location
│   │   ├── MotionCollector.swift       # Core Motion
│   │   ├── DeviceCollector.swift       # Battery, connectivity, etc.
│   │   ├── WeatherCollector.swift      # WeatherKit
│   │   ├── CalendarCollector.swift     # EventKit
│   │   ├── PhotoCollector.swift        # PhotoKit metadata
│   │   └── BluetoothCollector.swift    # Core Bluetooth
│   ├── Services/
│   │   ├── DataOrchestrator.swift      # Coordinates all collectors
│   │   ├── SyncEngine.swift           # Server upload logic
│   │   └── BackgroundTaskManager.swift # BGTaskScheduler setup
│   ├── Views/
│   │   ├── DashboardView.swift        # Live stats overview
│   │   ├── DataBrowserView.swift      # Browse collected data
│   │   ├── SyncStatusView.swift       # Sync status & controls
│   │   └── SettingsView.swift         # Server URL, permissions
│   └── Utilities/
│       └── Extensions.swift
└── PLAN.md
```

---

## Implementation Phases

### Phase 1: Project Skeleton
- Create Xcode project with SwiftUI lifecycle
- Set up SwiftData with `DataPoint` model
- Create tab-based UI shell (Dashboard, Data, Sync, Settings)
- Configure all entitlements and Info.plist permissions
- Implement Settings view with server URL input

### Phase 2: Core Collectors
- HealthCollector — request all permissions, historical backfill, background delivery
- LocationCollector — always-on GPS, visit monitoring, significant changes
- MotionCollector — activity recognition, pedometer, altimeter
- DeviceCollector — battery, connectivity, thermal state polling

### Phase 3: Secondary Collectors
- WeatherCollector — current conditions tied to location
- CalendarCollector — event snapshots
- PhotoCollector — library metadata scan
- BluetoothCollector — peripheral scanning

### Phase 4: Sync Engine
- Batch upload of unsynced DataPoints
- Retry with exponential backoff
- Manual sync trigger from UI
- Background fetch + processing task sync

### Phase 5: Dashboard & Polish
- Live dashboard with key metrics
- Data browser with filtering by category/date
- Sync status indicators
- Local data size management (optional pruning of synced data)

---

## Notes

- Since this is personal-use only, we can use aggressive background modes and permissions without App Store review concerns
- All data stays on-device until explicitly synced to your server
- No analytics, no tracking SDKs, no third-party anything
- Target iOS 17+ (for SwiftData, modern WeatherKit, etc.)
