import Foundation

struct StatusResponse: Codable {
    let status: String
    let serverTime: Date
    let version: String
}

struct DeviceRegistrationRequest: Codable {
    let deviceId: String
    let installationId: String
    let appVersion: String
    let osVersion: String
}

struct DeviceRegistrationResponse: Codable {
    let accepted: Bool
    let deviceToken: String?
}

struct IngestPointDTO: Codable {
    let pointId: UUID
    let localSequence: Int64
    let stream: String
    let eventDate: Date
    let receivedAt: Date
    let payload: String
    let payloadHashSHA256: String
}

struct IngestRequest: Codable {
    let deviceId: String
    let installationId: String
    let sentAt: Date
    let points: [IngestPointDTO]
}

struct IngestPointResult: Codable {
    let pointId: UUID
    let status: String
    let message: String?
}

struct IngestResponse: Codable {
    let acceptedCount: Int
    let duplicateCount: Int
    let rejectedCount: Int
    let results: [IngestPointResult]
}
