import SwiftUI
import AppKit

struct JsonTree: View {
 let value: Any
 let source: String
 var body: some View {
  ScrollView([.vertical, .horizontal]) {
   JsonBranch(node: JsonNode("", value), source: source, root: true)
    .padding(12).frame(minWidth: 280, alignment: .leading)
  }.background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
 }
}
struct JsonBranch: View {
 @EnvironmentObject var work: Workspace
 let node: JsonNode
 let source: String
 var root = false
 @State private var expanded = false
 var open: Bool { expanded }
 var color: Color {
  switch node.kind {
  case .string: return .green
  case .number: return .cyan
  case .boolean: return .purple
  case .null, .notice: return .secondary
  default: return .secondary
  }
 }
 var body: some View {
  VStack(alignment: .leading, spacing: 0) {
   HStack(alignment: .firstTextBaseline, spacing: 6) {
    if node.container && node.count > 0 {
     Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary).frame(width: 12)
    } else { Color.clear.frame(width: 12, height: 1) }
    if !node.label.isEmpty { Text(JsonNode.quote(node.label) + ":").foregroundStyle(.primary) }
    Text(open && node.container ? (node.kind == .array ? "[" : "{") : node.text).foregroundStyle(color).textSelection(.enabled)
   }
   .font(.system(size: 12, design: .monospaced)).padding(.vertical, 3).padding(.trailing, 12)
   .contentShape(Rectangle())
   .onTapGesture { if node.container && node.count > 0 { expanded.toggle() } }
   .accessibilityLabel((node.label.isEmpty ? "JSON" : node.label) + ": " + node.text)
   .accessibilityAction(named: open ? "Collapse" : "Expand") { if node.container { expanded.toggle() } }
   .contextMenu {
    if node.container && node.count > 0 { Button(open ? "Collapse" : "Expand") { expanded.toggle() } }
    Button("Copy value") {
     let value = (try? JSONSerialization.data(withJSONObject: node.raw, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes])).map { String(decoding: $0, as: UTF8.self) } ?? node.text
     NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string)
    }
    Button("Copy JSON path") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(node.id, forType: .string) }
    Divider()
    Button("Explain this field…") { work.explain(Field(node.id, node.label.isEmpty ? "JSON record" : node.label, node.raw, meaning: "Selected JSON field. Source data remains read-only; transformations create separate revisions.", origin: source + " " + node.id), source: source) }
   }
   if open, let children = node.children {
    VStack(alignment: .leading, spacing: 0) { ForEach(children) { child in JsonBranch(node: child, source: source) } }
     .padding(.leading, 18).overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.15)).frame(width: 1).padding(.leading, 6) }
    Text(node.kind == .array ? "]" : "}").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).padding(.leading, 18).padding(.vertical, 3)
   }
  }.onAppear { if root { expanded = true } }
 }
}
