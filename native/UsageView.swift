import SwiftUI

struct UsageView: View {
 @EnvironmentObject var work: Workspace
 @ObservedObject var panel: Panel
 @State private var details = false
 var data: UsageData {
  UsageData((try? JSONSerialization.jsonObject(with: Data(panel.usage.utf8))) as? [String: Any] ?? [:])
 }
 var body: some View {
  ScrollView {
   VStack(alignment: .leading, spacing: 24) {
    VStack(alignment: .leading, spacing: 8) {
     Label(data.hasHistory ? "Recorded model usage" : "No model usage recorded yet", systemImage: "chart.bar.xaxis").font(.title2.bold())
     Text(data.hasHistory ? "Measured tokens from saved inference calls. Unknown calls mean totals may be incomplete." : "A zero here does not mean your dataset is empty. Usage appears after instrumented model calls are saved.").foregroundStyle(.secondary)
     Text("Local inference · no hosted API charge is calculated").font(.caption).foregroundStyle(.secondary)
    }
    if data.hasHistory {
     HStack(spacing: 16) {
      metric("Prompt tokens", panel.inputTokens.formatted(), "Text sent into the local model")
      metric("Generated tokens", panel.outputTokens.formatted(), "Text produced by the local model")
      metric("Unmeasured calls", panel.unknown.formatted(), "Usage could not be recovered")
     }
    }
    VStack(alignment: .leading, spacing: 14) {
     Text("Usage by stage").font(.headline)
     Text("Compare recorded usage with the estimated tokens needed for queued work.").font(.callout).foregroundStyle(.secondary)
     if data.rows.isEmpty {
      ContentUnavailableView("Waiting for measured calls", systemImage: "chart.bar", description: Text(data.available ? "No stage usage or queued-work estimates have been recorded for this instance." : "This instance has no readable token-accounting record. Older runs may predate instrumentation."))
     } else {
      Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 14) {
       GridRow { Text("Stage"); Text("Prompt"); Text("Generated"); Text("Queued jobs"); Text("Tokens remaining") }.font(.caption.bold()).foregroundStyle(.secondary)
       Divider()
       ForEach(data.rows) { row in
        GridRow {
         Text(row.id.capitalized).fontWeight(.medium)
         value(row.calls == 0 ? "—" : row.input.formatted(), row.id + ".prompt", "Recorded prompt tokens")
         value(row.calls == 0 ? "—" : row.output.formatted(), row.id + ".generated", "Recorded generated tokens")
         value(row.pending.formatted(), row.id + ".queued", "Queued stage jobs")
         value(row.pending == 0 ? "No queued work" : row.forecast.map { "≈ " + $0.formatted() } ?? "Not enough history", row.id + ".estimate", "Estimated tokens remaining").foregroundStyle(.secondary)
        }.monospacedDigit()
        if row.unknown > 0 { GridRow { Text("\(row.unknown.formatted()) calls have unmeasured usage").font(.caption).foregroundStyle(.orange).gridCellColumns(5) } }
       }
      }.frame(maxWidth: .infinity, alignment: .leading)
     }
    }.padding(20).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 14))
    Label("Estimates need successful calls with the same stage configuration. Retries and work not yet queued are excluded; an estimate is not a token limit.", systemImage: "info.circle").font(.callout).foregroundStyle(.secondary)
    DisclosureGroup("Technical details", isExpanded: $details) {
     Text(panel.usage).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10)
    }
   }.padding(.vertical, 8)
  }
 }
 private func metric(_ title: String, _ value: String, _ note: String) -> some View {
  VStack(alignment: .leading, spacing: 8) { Text(title).font(.callout).foregroundStyle(.secondary); self.value(value, title, note).font(.largeTitle.bold()).monospacedDigit(); Text(note).font(.caption).foregroundStyle(.secondary) }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
 }
 private func value(_ text: String, _ id: String, _ meaning: String) -> some View {
  HStack(spacing: 6) {
   Text(text).textSelection(.enabled)
   Button { work.explain(Field("usage." + id, meaning, text, meaning: meaning + ". Values are read from saved local usage records; estimates exclude retries and unmaterialized work.", origin: panel.bridge.config), source: "metrics") } label: { Image(systemName: "questionmark.circle").font(.caption).foregroundStyle(.secondary) }.buttonStyle(.plain).help("Explain " + meaning.lowercased())
  }
 }
}
