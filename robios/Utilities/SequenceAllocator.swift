import Foundation

enum SequenceAllocator {
    private static let key = "local_sequence_counter"

    static func next() -> Int64 {
        let defaults = UserDefaults.standard
        let nextValue = defaults.object(forKey: key) as? Int64 ?? 0
        let allocated = nextValue + 1
        defaults.set(allocated, forKey: key)
        return allocated
    }
}
