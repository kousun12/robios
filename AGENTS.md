# Repository Guidelines

## Project Structure & Module Organization

`robios.xcodeproj` is the Xcode project for the native iOS app. App source lives under `robios/`, organized by responsibility:

- `robios/Models/`: SwiftData models and sync DTOs.
- `robios/Services/`: app services such as settings, local storage, sync, server API, and keychain access.
- `robios/Views/`: SwiftUI tabs and screens.
- `robios/Utilities/`: hashing, JSON canonicalization, and sequence helpers.
- `robios/Assets.xcassets/`: app icon, accent color, and other assets.
- `tools/mock-server/`: Python standard-library mock sync server.

The project uses Xcode file-system-synchronized groups, so new Swift files placed under `robios/` are picked up by the app target.

## Build, Test, and Development Commands

Build the iOS app:

```sh
xcodebuild -project robios.xcodeproj -scheme robios -destination 'generic/platform=iOS' build
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

Use Swift 6, SwiftUI, SwiftData, and public Apple frameworks only. Keep app state and service objects `@MainActor` unless there is a specific reason to isolate work elsewhere. Use four-space indentation, `UpperCamelCase` for types, and `lowerCamelCase` for methods and properties. Prefer existing service boundaries: collectors write through `LocalStore`; sync goes through `SyncEngine` and `ServerAPI`.

## Testing Guidelines

There is no dedicated test target yet. For now, verify changes with `xcodebuild` and a manual mock-server sync flow: create a test event in the Sync tab, run Sync Now, and confirm the point is marked synced. When tests are added, prefer XCTest with test files named after the unit under test, for example `SyncEngineTests.swift`.

## Commit & Pull Request Guidelines

Recent history uses short conventional prefixes such as `feat:` and `chore:`. Keep commit subjects concise and imperative, for example `feat: Add HealthKit checkpoint model`.

Pull requests should include a focused summary, verification steps, and screenshots for UI changes. Link related issues or PLAN.md checklist items. Do not commit Xcode build output, DerivedData, or `tools/mock-server/.data/`.

## Security & Configuration Tips

Store the shared access key in Keychain via app settings. Keep mock-server tokens and runtime data local. Add iOS capabilities, entitlements, Info.plist usage descriptions, and ATS exceptions only in the phase that needs them.
