import Foundation

enum JSONCanonicalizer {
    static func canonicalData(from value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
