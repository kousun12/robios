import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var environment: AppEnvironment

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Base URL", text: settingBinding(\.serverBaseURL))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                    SecureField("Access Key", text: settingBinding(\.accessKey))
                        .textInputAutocapitalization(.never)
                }

                Section("Device") {
                    TextField("Device ID", text: settingBinding(\.deviceID))
                        .textInputAutocapitalization(.never)
                    TextField("Installation ID", text: settingBinding(\.installationID))
                        .textInputAutocapitalization(.never)
                    Stepper("Batch Size: \(environment.settings.batchSize)", value: settingBinding(\.batchSize), in: 1 ... 500)
                }
            }
            .navigationTitle("Settings")
        }
    }

    private func settingBinding<Value>(_ keyPath: ReferenceWritableKeyPath<AppSettings, Value>) -> Binding<Value> {
        Binding(
            get: { environment.settings[keyPath: keyPath] },
            set: { environment.settings[keyPath: keyPath] = $0 }
        )
    }
}
