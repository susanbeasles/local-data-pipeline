import XCTest
@testable import Pipeline
import Darwin

final class PTYTests: XCTestCase {
 @MainActor final class Probe {
  var process: PtyProcess!
  var text = ""
  var sent = false
  let finished: XCTestExpectation
  init(_ finished:XCTestExpectation) { self.finished = finished;process = PtyProcess();process.onData = { [weak self] data in self?.dataReceived(slice:Array(data)[...]) };process.onExit = { [weak self] code in self?.processTerminated(exitCode:code) } }
  func getWindowSize() -> winsize { winsize(ws_row:24,ws_col:80,ws_xpixel:0,ws_ypixel:0) }
  func dataReceived(slice:ArraySlice<UInt8>) {
   text += String(decoding:slice,as:UTF8.self)
   if text.contains("READY"), !sent { sent = true;process.send(Array("fixture-input\n".utf8)[...]) }
  }
  func processTerminated(exitCode:Int32?) { XCTAssertEqual(exitCode,0,text);finished.fulfill() }
 }
 @MainActor func testInteractivePTYAcceptsInputAndANSIOutput() throws {
  let done = expectation(description:"synthetic terminal exits")
  let probe = Probe(done)
  let script = #"test -t 0 && test -t 1 || exit 91; printf '\033[32mREADY\033[0m\n'; IFS= read -r line; printf 'GOT:%s\n' "$line""#
  try probe.process.start(executable:"/bin/sh",args:["-c",script],environment:["PATH=/usr/bin:/bin","TERM=xterm-256color"])
  wait(for:[done],timeout:10)
  XCTAssertTrue(probe.sent)
  XCTAssertTrue(probe.text.contains("GOT:fixture-input"))
  XCTAssertTrue(probe.text.contains("\u{1b}[32m"))
  probe.process.stop()
 }
 @MainActor func testPTYRetainsSingleWorkspaceWriteBoundary() throws {
  let root = URL(fileURLWithPath:"/private/tmp").appendingPathComponent("pipeline-pty-"+UUID().uuidString)
  try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
  defer { try? FileManager.default.removeItem(at:root) }
  let workspace = root.appendingPathComponent("artifacts")
  try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
  let done = expectation(description:"sandboxed terminal exits")
  let probe = Probe(done)
  let path = String(decoding:try JSONSerialization.data(withJSONObject:workspace.path,options:[.fragmentsAllowed,.withoutEscapingSlashes]),as:UTF8.self)
  let profile = #"(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "# + path + #") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))"#
  let script = #"test -t 0 && test -t 1 || exit 91; printf '\033[32mREADY\033[0m\n'; IFS= read -r line; printf 'GOT:%s\n' "$line"; printf note > "$WORKSPACE/note.md" || exit 92; (printf forbidden > "$OUTSIDE/outside.md") 2>/dev/null && exit 93; exit 0"#
  try probe.process.start(executable:"/usr/bin/sandbox-exec",args:["-p",profile,"/bin/sh","-c",script],environment:["PATH=/usr/bin:/bin","TERM=xterm-256color","WORKSPACE="+workspace.path,"OUTSIDE="+root.path])
  wait(for:[done],timeout:10)
  XCTAssertTrue(probe.text.contains("GOT:fixture-input"))
  XCTAssertEqual(try String(contentsOf:workspace.appendingPathComponent("note.md")),"note")
  XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("outside.md").path))
  probe.process.stop()
 }

 @MainActor func testProcessCanRestartAfterExit() throws {
  let process = PtyProcess()
  for index in 0..<3 {
   let done = expectation(description:"session \(index) exits")
   process.onExit = { code in XCTAssertEqual(code,0);done.fulfill() }
   try process.start(executable:"/bin/sh",args:["-c","printf fixture"],environment:["PATH=/usr/bin:/bin"])
   wait(for:[done],timeout:5)
   XCTAssertEqual(process.pid,0)
   process.stop()
  }
 }
 @MainActor func testResistantSessionIsStoppedWithoutHanging() throws {
  let process = PtyProcess()
  let done = expectation(description:"resistant process exits")
  var stopped = false
  process.onData = { data in if String(decoding:data,as:UTF8.self).contains("READY"),!stopped { stopped=true;process.stop() } }
  process.onExit = { code in XCTAssertEqual(code,137);done.fulfill() }
  try process.start(executable:"/bin/sh",args:["-c","trap '' TERM; printf READY; while :; do sleep 1; done"],environment:["PATH=/usr/bin:/bin"])
  wait(for:[done],timeout:6)
  XCTAssertEqual(process.pid,0)
 }

}
