import Foundation
import CoreFoundation

/// Children are constructed only when their containing branch is opened.
final class JsonNode: Identifiable {
 enum Kind { case object, array, string, number, boolean, null, notice }
 let id: String
 let label: String
 let raw: Any
 let depth: Int
 let kind: Kind
 init(_ label: String, _ value: Any, path: String = "$", depth: Int = 0, notice: Bool = false) {
  self.id = path; self.label = label; self.raw = value; self.depth = depth
  if notice { kind = .notice }
  else if value is NSNull { kind = .null }
  else if value is [String: Any] { kind = .object }
  else if value is [Any] { kind = .array }
  else if value is String { kind = .string }
  else if let number = value as? NSNumber { kind = CFGetTypeID(number) == CFBooleanGetTypeID() ? .boolean : .number }
  else { kind = .string }
 }
 static func quote(_ value: String) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) else { return "\"\"" }
  return String(decoding: data, as: UTF8.self)
 }
 var count: Int { (raw as? [String: Any])?.count ?? (raw as? [Any])?.count ?? 0 }
 var container: Bool { kind == .object || kind == .array }
 var text: String {
  switch kind {
  case .object: return count == 0 ? "{}" : "{…}  \(count) properties"
  case .array: return count == 0 ? "[]" : "[…]  \(count) items"
  case .string: return Self.quote(String(describing: raw))
  case .null: return "null"
  case .boolean: return (raw as? NSNumber)?.boolValue == true ? "true" : "false"
  case .number: return String(describing: raw)
  case .notice: return String(describing: raw)
  }
 }
 lazy var children: [JsonNode]? = {
  guard container, count > 0 else { return nil }
  if depth >= 20 {
   return [JsonNode("…", "Depth preview limit reached — use Raw JSON to inspect deeper values.", path:id+"#depth", depth:depth+1, notice:true)]
  }
  var nodes: [JsonNode]
  if let object = raw as? [String: Any] {
   nodes = object.keys.sorted().prefix(500).map { JsonNode($0, object[$0]!, path:id+"["+Self.quote($0)+"]", depth:depth+1) }
  } else {
   nodes = (raw as? [Any] ?? []).prefix(500).enumerated().map { JsonNode(String($0.offset), $0.element, path:id+"[\($0.offset)]", depth:depth+1) }
  }
  if count > 500 {
   nodes.append(JsonNode("…", "\(count-500) more values — use Raw JSON to inspect this full preview.", path:id+"#more", depth:depth+1, notice:true))
  }
  return nodes
 }()
}
