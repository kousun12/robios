import SwiftData
import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @Query private var allPoints: [DataPoint]

    private var pendingCount: Int { allPoints.filter { $0.syncStateRaw == SyncState.pending.rawValue }.count }
    private var failedCount: Int { allPoints.filter { $0.syncStateRaw == SyncState.failed.rawValue }.count }

    var body: some View {
        NavigationStack {
            List {
                statCard(title: "Local Points", value: "\(allPoints.count)")
                statCard(title: "Pending", value: "\(pendingCount)")
                statCard(title: "Failed", value: "\(failedCount)")
                statCard(title: "Server", value: environment.syncEngine.serverStatus)
            }
            .navigationTitle("Dashboard")
            .task {
                await environment.syncEngine.refreshStatus()
            }
        }
    }

    private func statCard(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.bold())
        }
        .padding(.vertical, 6)
    }
}
