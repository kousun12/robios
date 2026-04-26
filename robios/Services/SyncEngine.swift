import Foundation
import Combine

@MainActor
final class SyncEngine: ObservableObject {
    @Published var isSyncing = false
    @Published var lastSyncAt: Date?
    @Published var lastError: String?
    @Published var serverStatus: String = "Unknown"

    private let localStore: LocalStore
    private let serverAPI: ServerAPI

    init(localStore: LocalStore, serverAPI: ServerAPI) {
        self.localStore = localStore
        self.serverAPI = serverAPI
    }

    func refreshStatus() async {
        do {
            let status = try await serverAPI.status()
            serverStatus = status.status
            lastError = nil
        } catch {
            serverStatus = "Offline"
            lastError = error.localizedDescription
        }
    }

    func syncNow(batchSize: Int) async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }

        do {
            let pending = try localStore.pendingPoints(limit: batchSize)
            guard !pending.isEmpty else {
                lastSyncAt = .now
                return
            }

            _ = try await serverAPI.registerDevice()
            let response = try await serverAPI.ingest(points: pending)
            try localStore.updateSyncResults(response.results)
            lastSyncAt = .now
            lastError = nil
        } catch {
            do {
                let pending = try localStore.pendingPoints(limit: batchSize)
                try localStore.markAttempted(points: pending, errorMessage: error.localizedDescription)
            } catch {
                lastError = "Sync failed and local update failed: \(error.localizedDescription)"
                return
            }
            lastError = error.localizedDescription
        }
    }
}
