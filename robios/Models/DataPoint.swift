import Foundation
import SwiftData

@Model
final class DataPoint {
    var id: UUID
    var stream: String
    var source: String
    var sourceId: String?
    var eventDate: Date
    var receivedAt: Date
    var payloadJSON: Data
    var payloadHashSHA256: String
    var localSequence: Int64
    var syncStateRaw: String
    var syncAttempts: Int
    var lastSyncAttemptAt: Date?
    var lastSyncError: String?
    var remoteIngestedAt: Date?

    init(
        id: UUID = UUID(),
        stream: String,
        source: String,
        sourceId: String? = nil,
        eventDate: Date = .now,
        receivedAt: Date = .now,
        payloadJSON: Data,
        payloadHashSHA256: String,
        localSequence: Int64,
        syncStateRaw: String = SyncState.pending.rawValue,
        syncAttempts: Int = 0,
        lastSyncAttemptAt: Date? = nil,
        lastSyncError: String? = nil,
        remoteIngestedAt: Date? = nil
    ) {
        self.id = id
        self.stream = stream
        self.source = source
        self.sourceId = sourceId
        self.eventDate = eventDate
        self.receivedAt = receivedAt
        self.payloadJSON = payloadJSON
        self.payloadHashSHA256 = payloadHashSHA256
        self.localSequence = localSequence
        self.syncStateRaw = syncStateRaw
        self.syncAttempts = syncAttempts
        self.lastSyncAttemptAt = lastSyncAttemptAt
        self.lastSyncError = lastSyncError
        self.remoteIngestedAt = remoteIngestedAt
    }
}

enum SyncState: String, CaseIterable, Identifiable {
    case pending
    case synced
    case failed

    var id: String { rawValue }
}
