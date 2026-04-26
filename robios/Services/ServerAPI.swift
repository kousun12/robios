import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case statusCode(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: "Invalid server URL"
        case .invalidResponse: "Invalid server response"
        case let .statusCode(code, body): "Server returned \(code): \(body)"
        }
    }
}

struct ServerAPI {
    let settings: AppSettings

    private func request(path: String, method: String) throws -> URLRequest {
        guard let baseURL = URL(string: settings.serverBaseURL),
              let url = URL(string: path, relativeTo: baseURL)
        else {
            throw APIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(settings.accessKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }

    func status() async throws -> StatusResponse {
        let req = try request(path: "/v1/status", method: "GET")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200 ... 299).contains(http.statusCode) else {
            throw APIError.statusCode(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder.robios.decode(StatusResponse.self, from: data)
    }

    func registerDevice() async throws -> DeviceRegistrationResponse {
        var req = try request(path: "/v1/devices/register", method: "POST")
        let body = DeviceRegistrationRequest(
            deviceId: settings.deviceID,
            installationId: settings.installationID,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString
        )
        req.httpBody = try JSONEncoder.robios.encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200 ... 299).contains(http.statusCode) else {
            throw APIError.statusCode(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder.robios.decode(DeviceRegistrationResponse.self, from: data)
    }

    func ingest(points: [DataPoint]) async throws -> IngestResponse {
        var req = try request(path: "/v1/ingest", method: "POST")
        let dto = points.map {
            IngestPointDTO(
                pointId: $0.id,
                localSequence: $0.localSequence,
                stream: $0.stream,
                eventDate: $0.eventDate,
                receivedAt: $0.receivedAt,
                payload: String(data: $0.payloadJSON, encoding: .utf8) ?? "{}",
                payloadHashSHA256: $0.payloadHashSHA256
            )
        }
        req.httpBody = try JSONEncoder.robios.encode(
            IngestRequest(
                deviceId: settings.deviceID,
                installationId: settings.installationID,
                sentAt: .now,
                points: dto
            )
        )

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200 ... 299).contains(http.statusCode) else {
            throw APIError.statusCode(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder.robios.decode(IngestResponse.self, from: data)
    }
}

extension JSONEncoder {
    static var robios: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var robios: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
