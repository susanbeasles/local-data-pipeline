import Foundation

struct UsageRow: Identifiable {
 let id: String
 var calls = 0, input = 0, output = 0, unknown = 0, pending = 0
 var estimate = 0
 var unmeasured = false
 var forecast: Int? { unmeasured ? nil : estimate }
}
/// Display aggregates only. Unknown or partly measured forecasts stay unknown.
struct UsageData {
 let available: Bool
 let rows: [UsageRow]
 var hasHistory: Bool { rows.contains { $0.calls > 0 } }
 init(_ value: [String: Any]) {
  available = value["available"] as? Bool ?? false
  var grouped: [String: UsageRow] = [:]
  for record in value["history"] as? [[String: Any]] ?? [] {
   guard let role = record["role"] as? String else { continue }
   var row = grouped[role] ?? UsageRow(id: role)
   row.calls += record["calls"] as? Int ?? 0
   row.input += record["inputTokens"] as? Int ?? 0
   row.output += record["outputTokens"] as? Int ?? 0
   row.unknown += record["unknown"] as? Int ?? 0
   grouped[role] = row
  }
  for record in value["forecast"] as? [[String: Any]] ?? [] {
   guard let role = record["role"] as? String else { continue }
   var row = grouped[role] ?? UsageRow(id: role)
   row.pending += record["pending"] as? Int ?? 0
   if let input = record["inputTokens"] as? Int, let output = record["outputTokens"] as? Int {
    row.estimate += input + output
   } else { row.unmeasured = true }
   grouped[role] = row
  }
  rows = grouped.values.sorted { $0.id < $1.id }
 }
}
