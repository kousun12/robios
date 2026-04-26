import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "rectangle.3.group") }
            DataBrowserView()
                .tabItem { Label("Data", systemImage: "list.bullet.rectangle") }
            SyncStatusView()
                .tabItem { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

#Preview {
    ContentView()
}
