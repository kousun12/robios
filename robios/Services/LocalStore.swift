import Foundation
import SwiftData

@MainActor
final class LocalStore {
    private let context: ModelContext

    init(context: ModelContext) {
        self.context = context
    }

    @discardableResult
    func append(stream: String, source: String, payloadObject: [String: Any]) throws -> DataPoint {
        let payloadData = try JSONCanonicalizer.canonicalData(from: payloadObject)
        let hash = PayloadHasher.sha256Hex(payloadData)
        let point = DataPoint(
            stream: stream,
            source: source,
            payloadJSON: payloadData,
            payloadHashSHA256: hash,
            localSequence: SequenceAllocator.next()
        )
        context.insert(point)
        try context.save()
        return point
    }

    func pendingPoints(limit: Int) throws -> [DataPoint] {
        let pendingRawValue = SyncState.pending.rawValue
        var descriptor = FetchDescriptor<DataPoint>(
            predicate: #Predicate { $0.syncStateRaw == pendingRawValue },
            sortBy: [SortDescriptor(\DataPoint.localSequence)]
        )
        descriptor.fetchLimit = limit
        return try context.fetch(descriptor)
    }

    func updateSyncResults(_ results: [IngestPointResult], errorMessage: String? = nil) throws {
        for result in results {
            let pointId = result.pointId
            var descriptor = FetchDescriptor<DataPoint>(
                predicate: #Predicate { $0.id == pointId }
            )
            descriptor.fetchLimit = 1
            guard let point = try context.fetch(descriptor).first else { continue }
            point.lastSyncAttemptAt = .now
            point.syncAttempts += 1
            switch result.status {
            case "accepted", "duplicate":
                point.syncStateRaw = SyncState.synced.rawValue
                point.lastSyncError = nil
                point.remoteIngestedAt = .now
            default:
                point.syncStateRaw = SyncState.failed.rawValue
                point.lastSyncError = result.message ?? errorMessage ?? "Sync rejected"
            }
        }
        try context.save()
    }

    func markAttempted(points: [DataPoint], errorMessage: String) throws {
        for point in points {
            point.lastSyncAttemptAt = .now
            point.syncAttempts += 1
            point.lastSyncError = errorMessage
        }
        try context.save()
    }

    func count(for state: SyncState? = nil) throws -> Int {
        if let state {
            let rawValue = state.rawValue
            let descriptor = FetchDescriptor<DataPoint>(predicate: #Predicate { $0.syncStateRaw == rawValue })
            return try context.fetchCount(descriptor)
        }
        let descriptor = FetchDescriptor<DataPoint>()
        return try context.fetchCount(descriptor)
    }
}
