import Foundation
import Combine
import SwiftData

@MainActor
final class AppEnvironment: ObservableObject {
    let settings = AppSettings()
    let localStore: LocalStore
    let syncEngine: SyncEngine
    private var cancellables: Set<AnyCancellable> = []

    init(context: ModelContext) {
        localStore = LocalStore(context: context)
        syncEngine = SyncEngine(localStore: localStore, serverAPI: ServerAPI(settings: settings))

        settings.objectWillChange
            .sink { [objectWillChange] _ in objectWillChange.send() }
            .store(in: &cancellables)
        syncEngine.objectWillChange
            .sink { [objectWillChange] _ in objectWillChange.send() }
            .store(in: &cancellables)
    }
}
