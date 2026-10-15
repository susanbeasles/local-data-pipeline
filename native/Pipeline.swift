import SwiftUI
import AppKit

struct Bridge: Decodable, Sendable { let node: String; let script: String; let config: String }
@MainActor final class Panel: ObservableObject {
    @Published var status = "Loading pipeline…"
    @Published var logs = ""
    @Published var sample = "Choose a stage, then request a local sample."
    @Published var error = ""
    @Published var busy = false
    @Published var alive = false
    @Published var fraction = 0.0
    @Published var partition = "Pipeline"
    @Published var phase = "Connecting"
    @Published var usage = "Token accounting unavailable for older runs."
    @Published var completed = 0
    @Published var pending = 0
    @Published var failed = 0
    @Published var sources = 0
    @Published var hasUsage = false
    @Published var inputTokens = 0
    @Published var outputTokens = 0
    @Published var unknown = 0
    @Published var sampleIndex = 0
    @Published var roles: [(String, Int, Int)] = []
    let bridge: Bridge
    init() {
        if let url = Bundle.main.url(forResource: "bridge", withExtension: "json"), let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(Bridge.self, from: data) { bridge = value }
        else { bridge = Bridge(node: "/usr/bin/false", script: "", config: ""); error = "App configuration is missing or invalid. Rebuild with native/build.ts." }
    }
    nonisolated static func invoke(_ bridge: Bridge, _ command: String, _ role: String, _ offset: Int) throws -> Data {
        let process = Process(), pipe = Pipe(), diagnostic = Pipe()
        process.executableURL = URL(fileURLWithPath: bridge.node)
        process.arguments = [bridge.script, command, bridge.config, role, String(offset)]
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardOutput = pipe; process.standardError = diagnostic
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard data.count <= 3 * 1024 * 1024 else { throw NSError(domain: "Panel", code: 1, userInfo: [NSLocalizedDescriptionKey: "Response exceeds local preview limit"]) }
        return data
    }
    func call(_ command: String, role: String = "summarize") async {
        if bridge.script.isEmpty { return }; if busy { return }; busy = true; defer { busy = false }
        do {
            let bridge = self.bridge
            let offset = sampleIndex
            let data = try await Task.detached { try Self.invoke(bridge, command, role, offset) }.value
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            if let message = object["error"] as? String { throw NSError(domain: "Panel", code: 2, userInfo: [NSLocalizedDescriptionKey: message]) }
            if command != "status" { error = "" }
            if command == "status" {
                alive = object["alive"] as? Bool ?? false
                partition = object["partition"] as? String ?? "Pipeline"
                let state = object["status"] as? [String: Any] ?? [:]
                phase = state["phase"] as? String ?? "Unknown"
                fraction = (state["percent"] as? Double ?? 0) / 100
                let jobs = state["jobs"] as? [String: Any] ?? [:]
                completed = jobs["completed"] as? Int ?? 0; pending = jobs["pending"] as? Int ?? 0; failed = jobs["failed"] as? Int ?? 0
                sources = (state["inventory"] as? [[String: Any]] ?? []).reduce(0) { $0 + ($1["files"] as? Int ?? 0) }
                let rows = state["roles"] as? [[String: Any]] ?? []
                roles = (object["stages"] as? [String] ?? rows.compactMap { $0["role"] as? String }).map { name in let row = rows.first { $0["role"] as? String == name }; return (name,row?["completed"] as? Int ?? 0,row?["total"] as? Int ?? 0) }
                status = Self.pretty(state)
                let accounting = object["usage"] as? [String: Any] ?? [:]
                hasUsage = accounting["available"] as? Bool ?? false
                let history = accounting["history"] as? [[String: Any]] ?? []
                inputTokens = history.reduce(0) { $0 + ($1["inputTokens"] as? Int ?? 0) }
                outputTokens = history.reduce(0) { $0 + ($1["outputTokens"] as? Int ?? 0) }
                unknown = history.reduce(0) { $0 + ($1["unknown"] as? Int ?? 0) }
                usage = Self.pretty(accounting)
            } else if command == "logs" { logs = object["text"] as? String ?? "" }
            else if command == "sample" { sample = Self.pretty(object) }
        } catch { self.error = error.localizedDescription }
    }
    static func pretty(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return "Unavailable" }
        return String(decoding: data, as: UTF8.self)
    }
}
struct ControlView: View {
    @ObservedObject var panel: Panel
    @State private var section = "Overview"
    @State private var role = "summarize"
    @State private var action = ""
    @State private var confirming = false
    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Label("Overview", systemImage: "chart.bar.xaxis").tag("Overview")
                Label("Stages", systemImage: "list.bullet.rectangle").tag("Stages")
                Label("Tokens & forecast", systemImage: "number.circle").tag("Tokens")
                Label("Live logs", systemImage: "terminal").tag("Logs")
                Label("Data review", systemImage: "doc.text.magnifyingglass").tag("Samples")
            }.navigationTitle("Pipeline").navigationSplitViewColumnWidth(190)
        } detail: {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Image(systemName: panel.alive ? "circle.fill" : "pause.circle.fill").foregroundStyle(panel.alive ? .green : .orange)
                    VStack(alignment: .leading) { Text(panel.partition).font(.title.bold()); Text(panel.phase).foregroundStyle(.secondary) }
                    Spacer()
                    Button { Task { await panel.call("status") } } label: { Image(systemName: "arrow.clockwise") }.help("Refresh status")
                }
                ProgressView(value: panel.fraction)
                HStack {
                    Button("Pause", systemImage: "pause.fill") { action = "pause"; confirming = true }.disabled(!panel.alive || panel.busy)
                    Button("Resume", systemImage: "play.fill") { Task { await panel.call("resume"); await panel.call("status") } }.disabled(panel.alive || panel.busy)
                    Button("Restart pipeline", systemImage: "arrow.trianglehead.2.clockwise") { action = "restart"; confirming = true }.disabled(panel.busy)
                    Spacer(); if panel.busy { ProgressView().controlSize(.small) }
                }
                if !panel.error.isEmpty { Text(panel.error).foregroundStyle(.red).textSelection(.enabled) }
                Divider()
                if section == "Stages" {
                    List(Array(panel.roles.enumerated()), id: \.offset) { _, stage in
                        HStack { Text(stage.0.capitalized); Spacer(); Text(stage.2 == 0 ? "No jobs materialized" : "\(stage.1) / \(stage.2)").monospacedDigit().foregroundStyle(.secondary) }
                    }
                } else if section == "Samples" {
                    HStack { Picker("Stage", selection: $role) { ForEach(panel.roles.map { $0.0 }, id: \.self) { Text($0) } }; Button("Load local sample") { panel.sampleIndex = 0; Task { await panel.call("sample", role: role) } }; Button("Next sample") { panel.sampleIndex += 1; Task { await panel.call("sample", role: role) } } }
                    Text("Samples stay on this Mac. They load only when requested.").font(.caption).foregroundStyle(.secondary)
                    scroll(panel.sample)
                } else if section == "Logs" { scroll(panel.logs) }
                else if section == "Tokens" {
                    if panel.hasUsage { HStack(spacing: 16) { metric("Prompt tokens recorded", panel.inputTokens, "arrow.down.circle"); metric("Generated tokens recorded", panel.outputTokens, "arrow.up.circle"); metric("Calls with unknown usage", panel.unknown, "questionmark.circle") } } else { Text("This run predates token instrumentation. Exact token use is unavailable; new instances will record it.").font(.headline) }
                    Text("Local inference · token counts, not API charges. Older runs and interrupted calls can have unknown usage; recorded totals are lower bounds.").font(.caption).foregroundStyle(.secondary)
                    scroll(panel.usage)
                }
                else {
                    HStack(spacing: 16) {
                        metric("Sources inventoried", panel.sources, "doc.on.doc")
                        metric("Jobs completed", panel.completed, "checkmark.circle")
                        metric("Pending records", panel.pending, "hourglass")
                        metric("Failed jobs", panel.failed, "exclamationmark.triangle")
                    }
                    Text("Stage completion").font(.headline)
                    ForEach(Array(panel.roles.enumerated()), id: \.offset) { _, stage in
                        VStack(alignment: .leading) { HStack { Text(stage.0.capitalized); Spacer(); Text("\(stage.1.formatted()) / \(stage.2.formatted())").font(.caption).foregroundStyle(.secondary) }; ProgressView(value: stage.2 > 0 ? Double(stage.1)/Double(stage.2) : 0) }
                    }
                    Text("Preparation may still be running while inference jobs remain pending. Counts report durable checkpoints; unknown estimates stay unknown.").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
            }.padding(24).navigationTitle(section)
        }
        .onChange(of: role) { _, _ in panel.sampleIndex = 0 }
        .frame(minWidth: 800, minHeight: 540)
        .confirmationDialog(action == "restart" ? "Restart this pipeline from its durable checkpoint?" : "Pause this pipeline and preserve its checkpoint?", isPresented: $confirming) {
            Button(action == "restart" ? "Restart pipeline" : "Pause") { Task { await panel.call("pause"); if action == "restart" && panel.error.isEmpty { await panel.call("resume") }; await panel.call("status") } }
        }
        .task { await panel.call("status") }
        .task(id: section) { while !Task.isCancelled { try? await Task.sleep(for: .seconds(section == "Logs" ? 2 : 5)); if Task.isCancelled { break }; await panel.call(section == "Logs" ? "logs" : "status") } }
    }
    func metric(_ title: String, _ value: Int, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) { Label(title, systemImage: icon).font(.caption).foregroundStyle(.secondary); Text(value.formatted()).font(.title2.bold()).monospacedDigit() }.frame(maxWidth: .infinity, alignment: .leading).padding(16).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }
    func scroll(_ text: String) -> some View { ScrollView { Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.background(.background, in: RoundedRectangle(cornerRadius: 10)) }
}
@main struct PipelineApp: App {
    @StateObject private var panel = Panel()
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        MenuBarExtra("Pipeline", systemImage: "point.3.connected.trianglepath.dotted") {
            Text("Processing instance · "+panel.partition).font(.headline)
            Text(panel.alive ? "Running · \(panel.phase)" : panel.phase)
            Button("Open data workspace") { openWindow(id: "control"); NSApp.activate(ignoringOtherApps: true) }
            Button("Refresh") { Task { await panel.call("status") } }
            Divider(); Button("Quit panel") { NSApp.terminate(nil) }
        }
        WindowGroup("Pipeline", id: "control") { StudioView(panel: panel) }.defaultSize(width: 1280, height: 820)
    }
}
