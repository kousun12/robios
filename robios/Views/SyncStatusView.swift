import SwiftData
import SwiftUI

struct SyncStatusView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @Query private var points: [DataPoint]

    private var pendingCount: Int { points.filter { $0.syncStateRaw == SyncState.pending.rawValue }.count }
    private var syncedCount: Int { points.filter { $0.syncStateRaw == SyncState.synced.rawValue }.count }
    private var failedCount: Int { points.filter { $0.syncStateRaw == SyncState.failed.rawValue }.count }

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    Label(environment.syncEngine.serverStatus, systemImage: "network")
                    if let lastError = environment.syncEngine.lastError {
                        Text(lastError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    if let lastSyncAt = environment.syncEngine.lastSyncAt {
                        Text("Last sync: \(lastSyncAt.formatted())")
                            .font(.caption)
                    }
                }

                Section("Counts") {
                    Text("Pending: \(pendingCount)")
                    Text("Synced: \(syncedCount)")
                    Text("Failed: \(failedCount)")
                }

                Section("Actions") {
                    Button("Create Test Event") {
                        createTestEvent()
                    }

                    Button(environment.syncEngine.isSyncing ? "Syncing…" : "Sync Now") {
                        Task { await environment.syncEngine.syncNow(batchSize: environment.settings.batchSize) }
                    }
                    .disabled(environment.syncEngine.isSyncing)
                }
            }
            .navigationTitle("Sync")
            .task { await environment.syncEngine.refreshStatus() }
        }
    }

    private func createTestEvent() {
        do {
            _ = try environment.localStore.append(
                stream: "app.test_event",
                source: "robios",
                payloadObject: [
                    "message": "manual event",
                    "created_at": ISO8601DateFormatter().string(from: .now)
                ]
            )
        } catch {
            environment.syncEngine.lastError = error.localizedDescription
        }
    }
}
