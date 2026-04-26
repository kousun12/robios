import Foundation
import Combine

@MainActor
final class AppSettings: ObservableObject {
    private enum Keys {
        static let serverBaseURL = "settings.server_base_url"
        static let deviceID = "settings.device_id"
        static let installationID = "settings.installation_id"
        static let batchSize = "settings.batch_size"
    }

    private let defaults = UserDefaults.standard
    private let keychainService = "com.zocomputer.robios"
    private let keychainAccount = "shared_access_key"

    @Published var serverBaseURL: String {
        didSet { defaults.set(serverBaseURL, forKey: Keys.serverBaseURL) }
    }

    @Published var deviceID: String {
        didSet { defaults.set(deviceID, forKey: Keys.deviceID) }
    }

    @Published var installationID: String {
        didSet { defaults.set(installationID, forKey: Keys.installationID) }
    }

    @Published var batchSize: Int {
        didSet { defaults.set(batchSize, forKey: Keys.batchSize) }
    }

    @Published var accessKey: String {
        didSet {
            _ = KeychainHelper.save(service: keychainService, account: keychainAccount, value: accessKey)
        }
    }

    init() {
        serverBaseURL = defaults.string(forKey: Keys.serverBaseURL) ?? "http://127.0.0.1:8080"
        deviceID = defaults.string(forKey: Keys.deviceID) ?? UUID().uuidString
        installationID = defaults.string(forKey: Keys.installationID) ?? UUID().uuidString
        batchSize = max(1, defaults.integer(forKey: Keys.batchSize))
        if defaults.object(forKey: Keys.batchSize) == nil {
            batchSize = 100
        }
        accessKey = KeychainHelper.read(service: keychainService, account: keychainAccount) ?? "dev-secret"
    }
}
