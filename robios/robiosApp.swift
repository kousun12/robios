import SwiftData
import SwiftUI

@main
struct robiosApp: App {
    private let modelContainer: ModelContainer
    @StateObject private var environment: AppEnvironment

    init() {
        let schema = Schema([DataPoint.self, CollectorCheckpoint.self])
        let modelConfiguration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        let container: ModelContainer
        do {
            container = try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Failed to create ModelContainer: \(error)")
        }

        modelContainer = container
        _environment = StateObject(wrappedValue: AppEnvironment(context: container.mainContext))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(environment)
        }
        .modelContainer(modelContainer)
    }
}
