import Foundation

struct FileBlobUploader {
    let settings: AppSettings

    func blobExists(sha256: String) async throws -> Bool {
        guard let baseURL = URL(string: settings.serverBaseURL),
              let url = URL(string: "/v1/files/blobs/\(sha256)", relativeTo: baseURL)
        else {
            throw APIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.setValue("Bearer \(settings.accessKey)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 404 { return false }
        guard (200 ... 299).contains(http.statusCode) else {
            throw APIError.statusCode(http.statusCode, "HEAD blob failed")
        }
        return true
    }

    func upload(sha256: String, data: Data) async throws {
        guard let baseURL = URL(string: settings.serverBaseURL),
              let url = URL(string: "/v1/files/blobs/\(sha256)", relativeTo: baseURL)
        else {
            throw APIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.httpBody = data
        req.setValue("Bearer \(settings.accessKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
        let (responseData, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200 ... 299).contains(http.statusCode) else {
            throw APIError.statusCode(http.statusCode, String(data: responseData, encoding: .utf8) ?? "")
        }
    }
}
