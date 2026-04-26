import Foundation
import SwiftData

@Model
final class CollectorCheckpoint {
    var collector: String
    var checkpointData: Data
    var updatedAt: Date

    init(collector: String, checkpointData: Data, updatedAt: Date = .now) {
        self.collector = collector
        self.checkpointData = checkpointData
        self.updatedAt = updatedAt
    }
}
