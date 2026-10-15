import SwiftUI

struct WorkflowView: View {
 @EnvironmentObject var work: Workspace
 @State private var draft = "{}"
 @State private var version = ""
 @State private var run = ""
 @State private var result = "Connect to an authorized workflow platform to begin."
 @State private var versions: [[String: Any]] = []
 @State private var busy = false
 var body: some View {
  VStack(alignment: .leading, spacing: 10) {
   HStack {
    Text("Workflow JSON").font(.headline)
    Spacer()
    Button("Check platform") { perform("health") }
    Button("Registry") { perform("capabilities") }
    Button("Refresh versions") { perform("flows") }
   }
   Text("Preview checks a draft. Publishing freezes a version. Run queues that published version for an authorized worker.").font(.caption).foregroundStyle(.secondary)
   HSplitView {
    VStack(alignment: .leading) {
     TextEditor(text: $draft).font(.system(.caption, design: .monospaced)).frame(minHeight: 240)
     HStack {
      Button("Preview draft") { definition("preview") }
      Button("Publish version") { definition("publish") }
     }
     Picker("Published version", selection: $version) {
      Text("Select a published version").tag("")
      ForEach(versions, id: \.recordId) { item in
       Text(String(describing: item["name"] ?? "Workflow") + " · v" + String(describing: item["version"] ?? "") + " · " + String(item.recordId.prefix(12))).tag(item.recordId)
      }
     }
     Button("Queue run") { perform("run", ["version": version]) }.disabled(version.isEmpty)
    }.frame(minWidth: 340)
    VStack(alignment: .leading) {
     TextField("Run identifier", text: $run)
     HStack {
      Button("Status") { perform("status", ["run": run]) }
      Button("Pause") { perform("pause", ["run": run]) }
      Button("Resume") { perform("resume", ["run": run]) }
     }.disabled(run.isEmpty)
     ScrollView { Text(result).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(minHeight: 260)
    }.frame(minWidth: 340)
   }
  }.padding(12).disabled(busy)
 }
 func definition(_ action: String) {
  do {
   guard let document = try JSONSerialization.jsonObject(with: Data(draft.utf8)) as? [String: Any] else { throw NSError(domain: "Workflow", code: 1, userInfo: [NSLocalizedDescriptionKey: "Enter a platform-definition/1 JSON object."]) }
   perform(action, document)
  } catch { work.error = error.localizedDescription }
 }
 func perform(_ action: String, _ input: [String: Any] = [:]) {
  busy = true
  Task {
   defer { busy = false }
   guard let response = await work.request("platform", ["action": action, "input": input]) else { return }
   let value = response["result"] ?? NSNull()
   result = Workspace.pretty(value)
   if action == "flows" { versions = value as? [[String: Any]] ?? [] }
   if let object = value as? [String: Any] {
    if action == "publish" { version = object["id"] as? String ?? ""; if let list = await work.request("platform", ["action": "flows", "input": [:]]) { versions = list["result"] as? [[String: Any]] ?? [] } }
    if action == "run" { run = object["id"] as? String ?? "" }
   }
  }
 }
}
