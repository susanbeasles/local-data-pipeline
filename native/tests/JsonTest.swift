import Foundation
@main struct JsonTest {
 static func main() {
  let root = JsonNode("root", ["a.b": 1, "a": ["b": 2], "nothing": NSNull(), "flag": true, "text": "line\n\"quoted\""])
  let nodes = root.children!
  precondition(nodes.count == 5)
  let literal = nodes.first { $0.label == "a.b" }!
  let nested = nodes.first { $0.label == "a" }!.children![0]
  precondition(literal.id != nested.id, "Literal dots must not collide with nested paths")
  precondition(nodes.first { $0.label == "flag" }!.text == "true")
  precondition(nodes.first { $0.label == "nothing" }!.text == "null")
  precondition(nodes.first { $0.label == "text" }!.text == "\"line\\n\\\"quoted\\\"\"")
  precondition(JsonNode("empty", [:] as [String:Any]).children == nil)
  let array = JsonNode("items", Array(0..<501))
  precondition(array.children!.count == 501)
  precondition(array.children!.last!.kind == .notice)
  precondition(array.children!.last!.text.contains("1 more"))
  let deep = JsonNode("deep", ["x": ["y":1]], depth:20)
  precondition(deep.children!.first!.kind == .notice)
  let long = String(repeating:"a",count:1000)
  precondition(JsonNode("long",long).text.count == 1002, "Tree values must not silently lose text")
  print("JSON tree presentation checks passed")
 }
}
