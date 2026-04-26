import SwiftData
import SwiftUI

struct DataBrowserView: View {
    @Query(sort: [SortDescriptor(\DataPoint.localSequence, order: .reverse)]) private var points: [DataPoint]
    @State private var selectedStream = "All"
    @State private var selectedState = "All"

    private var streams: [String] {
        ["All"] + Array(Set(points.map(\.stream))).sorted()
    }

    private var filtered: [DataPoint] {
        points.filter { point in
            (selectedStream == "All" || point.stream == selectedStream) &&
                (selectedState == "All" || point.syncStateRaw == selectedState)
        }
    }

    var body: some View {
        NavigationStack {
            VStack {
                HStack {
                    Picker("Stream", selection: $selectedStream) {
                        ForEach(streams, id: \.self, content: Text.init)
                    }
                    Picker("State", selection: $selectedState) {
                        Text("All").tag("All")
                        ForEach(SyncState.allCases) { state in
                            Text(state.rawValue.capitalized).tag(state.rawValue)
                        }
                    }
                }
                .pickerStyle(.menu)

                List(filtered, id: \.id) { point in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(point.stream).font(.headline)
                        Text("seq \(point.localSequence) • \(point.syncStateRaw)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(point.eventDate, style: .date)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal)
            .navigationTitle("Data")
        }
    }
}
