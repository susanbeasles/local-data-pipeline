import SwiftUI
import AppKit
import SwiftTerm

@MainActor final class TerminalSession: NSObject, ObservableObject, TerminalViewDelegate {
 @Published var active = false
 @Published var status = "Not started"
 @Published var error = ""
 @Published var artifacts: URL?
 private let process = PtyProcess()
 let view = TerminalView(frame: NSRect(x:0,y:0,width:900,height:280))
 private var termination: NSObjectProtocol?
 override init() {
  super.init()
  view.font = .monospacedSystemFont(ofSize:12,weight:.regular)
  view.terminalDelegate = self
  process.onOverflow = { [weak self] in self?.error = "Terminal input queue is full. Some input was rejected; use smaller pastes." }
  process.onData = { [weak self] data in self?.view.feed(byteArray:Array(data)[...]) }
  process.onExit = { [weak self] code in self?.active = false;self?.status = code == 0 ? "Session ended":"Exited · \(code)" }
  termination = NotificationCenter.default.addObserver(forName:NSApplication.willTerminateNotification,object:nil,queue:.main) { [weak self] _ in MainActor.assumeIsolated { self?.end() } }
 }
 func start(_ provider: String) {
  guard !active else { return }
  do {
   guard ["codex","claude"].contains(provider),
    let url = Bundle.main.url(forResource:"bridge",withExtension:"json") else { throw failure("Terminal configuration is missing") }
   let bridge = try JSONDecoder().decode(StudioBridge.self,from:Data(contentsOf:url))
   guard let script = bridge.studioScript, let config = bridge.studioConfig else { throw failure("Build the dashboard with a workspace configuration first") }
   let entry = URL(fileURLWithPath:script).deletingLastPathComponent().appendingPathComponent("terminal.ts").path
   guard FileManager.default.isExecutableFile(atPath:bridge.node), FileManager.default.fileExists(atPath:entry) else { throw failure("The frozen terminal launcher is missing; rebuild the dashboard") }
   let settings = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:config))) as? [String:Any]
   guard let state = settings?["state"] as? String else { throw failure("Workspace state is not configured") }
   let stateURL = state.hasPrefix("/") ? URL(fileURLWithPath:state) : URL(fileURLWithPath:config).deletingLastPathComponent().appendingPathComponent(state)
   let id = UUID().uuidString.lowercased()
   artifacts = stateURL.standardizedFileURL.resolvingSymlinksInPath().appendingPathComponent("sessions/terminals/"+id+"/workspace")
   error = ""; active = true; status = provider == "codex" ? "Codex session" : "Claude Code session"
   var env = ProcessInfo.processInfo.environment
   env["TERM"] = "xterm-256color";env["COLORTERM"] = "truecolor"
   try process.start(executable:bridge.node,args:[entry,config,provider,id],environment:env.map { $0.key+"="+$0.value })
   view.window?.makeFirstResponder(view)
  } catch { self.error = error.localizedDescription; active = false; status = "Could not start" }
 }
 func end() { if active { process.stop(); status = "Ending…" } }
 func sizeChanged(source:TerminalView,newCols:Int,newRows:Int) { process.resize(cols:newCols,rows:newRows) }
 func setTerminalTitle(source:TerminalView,title:String) {}
 func hostCurrentDirectoryUpdate(source:TerminalView,directory:String?) {}
 func send(source:TerminalView,data:ArraySlice<UInt8>) { process.send(data) }
 func scrolled(source:TerminalView,position:Double) {}
 func requestOpenLink(source:TerminalView,link:String,params:[String:String]) {}
 func bell(source:TerminalView) { NSSound.beep() }
 func clipboardCopy(source:TerminalView,content:Data) { if let text=String(data:content,encoding:.utf8) { NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string) } }
 func iTermContent(source:TerminalView,content:ArraySlice<UInt8>) {}
 func rangeChanged(source:TerminalView,startY:Int,endY:Int) {}
 private func failure(_ text:String) -> NSError { NSError(domain:"Terminal",code:1,userInfo:[NSLocalizedDescriptionKey:text]) }
}
struct TerminalSurface: NSViewRepresentable {
 @ObservedObject var session: TerminalSession
 func makeNSView(context:Context) -> TerminalView { session.view }
 func updateNSView(_ view:TerminalView,context:Context) {}
}
struct TerminalDock: View {
 @EnvironmentObject var work: Workspace
 @StateObject private var session = TerminalSession()
 @State private var expanded = false
 @State private var provider = "codex"
 @State private var large = false
 @State private var confirm = false
 let maxHeight: CGFloat
 init(maxHeight:CGFloat, expanded:Bool = false) {
  self.maxHeight=maxHeight
  self._expanded=State(initialValue:expanded)
 }
 var height: CGFloat { max(80, min(large ? 450:200,maxHeight-86)) }
 var available: Bool { work.providers.contains { $0["id"] as? String == provider && $0["available"] as? Bool == true } }
 var body: some View {
  VStack(spacing:0) {
   Divider()
   HStack(spacing:12) {
    Button { expanded.toggle() } label: { Label("Terminal",systemImage:expanded ? "chevron.down":"chevron.up").fontWeight(.medium) }.buttonStyle(.plain).help(expanded ? "Collapse terminal; keep CLI running":"Open terminal dock")
    Circle().fill(session.active ? Color.green:Color.secondary).frame(width:6,height:6)
    Text(session.status).font(.caption).foregroundStyle(.secondary)
    Spacer()
    if expanded {
     if let folder = session.artifacts { Button("Artifacts…") { NSWorkspace.shared.selectFile(nil,inFileViewerRootedAtPath:folder.path) }.help("Notes, change requests and decisions from this session") }
     Picker("CLI",selection:$provider) { ForEach(["codex","claude"],id:\.self) { id in Text((id == "codex" ? "Codex":"Claude Code") + (work.providers.contains { $0["id"] as? String == id && $0["available"] as? Bool == true } ? "":" · unavailable")).tag(id) } }.labelsHidden().frame(width:190).disabled(session.active)
     if session.active { Button("End session"){confirm=true} }
     else { Button("Start \(provider == "codex" ? "Codex":"Claude Code")"){session.start(provider)}.buttonStyle(.borderedProminent).disabled(!available) }
     Button { large.toggle() } label: { Image(systemName:large ? "arrow.down.right.and.arrow.up.left":"arrow.up.left.and.arrow.down.right") }.help("Resize terminal")
    }
   }.padding(.horizontal,18).padding(.vertical,10)
   VStack(alignment:.leading,spacing:6) {
    if !session.error.isEmpty { Text(session.error).font(.caption).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal,12) }
    if !session.active && !available { Text("Selected CLI is unavailable in the workspace configuration. Choose an available CLI or update its executable binding.").font(.caption).foregroundStyle(.orange).padding(.horizontal,12) }
    Text("Only the artifact workspace is writable · notes / requests / decisions · changes remain proposals").font(.caption).foregroundStyle(.secondary).padding(.horizontal,12)
    TerminalSurface(session:session).frame(maxWidth:.infinity,maxHeight:.infinity)
   }.frame(height:height+36,alignment:.top).frame(height:expanded ? height+36:0,alignment:.top).clipped().allowsHitTesting(expanded).accessibilityHidden(!expanded)
  }.background(.regularMaterial)
  .confirmationDialog("End this CLI session?",isPresented:$confirm) { Button("End session",role:.destructive){session.end()} } message: { Text("This stops the terminal process. It does not pause or stop the processing pipeline.") }
  .onDisappear { session.end() }
 }
}
