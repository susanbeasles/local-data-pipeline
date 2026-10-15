import Foundation
import Darwin
import CPty

private final class PtyChannel: @unchecked Sendable {
 let queue = DispatchQueue(label:"pipeline.terminal.io")
 private let fd: Int32
 private let deliver: (Data) -> Void
 private let failure: () -> Void
 private var reader: DispatchSourceRead?
 private var writer: DispatchSourceWrite?
 private var pending = Data()
 private var closed = false
 init(_ fd:Int32,deliver:@escaping(Data)->Void,failure:@escaping()->Void) {
  self.fd=fd;self.deliver=deliver;self.failure=failure
  let source=DispatchSource.makeReadSource(fileDescriptor:fd,queue:queue)
  source.setEventHandler { [weak self] in self?.drain() }
  source.setCancelHandler { Darwin.close(fd) }
  reader=source;source.resume()
 }
 private func drain() {
  guard !closed else { return }
  var buffer=[UInt8](repeating:0,count:16384)
  var total=0
  while total < 262144 {
   let n=Darwin.read(fd,&buffer,buffer.count)
   if n>0 { total+=n;let data=Data(buffer.prefix(n));DispatchQueue.main.async { self.deliver(data) } }
   else if n<0 && errno==EINTR { continue }
   else { break }
  }
 }
 func send(_ data:Data) {
  queue.async {
   guard !self.closed else { return }
   guard self.pending.count+data.count <= 1024*1024 else { DispatchQueue.main.async { self.failure() };return }
   self.pending.append(data);self.flush()
  }
 }
 private func flush() {
  guard !closed else { return }
  while !pending.isEmpty {
   let n=pending.withUnsafeBytes { Darwin.write(fd,$0.baseAddress,$0.count) }
   if n>0 { pending.removeFirst(n) }
   else if n<0 && errno==EINTR { continue }
   else { break }
  }
  if pending.isEmpty { writer?.cancel();writer=nil }
  else if writer==nil {
   let source=DispatchSource.makeWriteSource(fileDescriptor:fd,queue:queue)
   source.setEventHandler { [weak self] in self?.flush() }
   writer=source;source.resume()
  }
 }
 func resize(cols:Int,rows:Int) {
  queue.async {
   guard !self.closed else { return }
   var size=winsize(ws_row:UInt16(clamping:max(1,rows)),ws_col:UInt16(clamping:max(1,cols)),ws_xpixel:0,ws_ypixel:0)
   _=ioctl(self.fd,TIOCSWINSZ,&size)
  }
 }
 /// Called on the I/O queue before process-exit notification.
 func finish() { drain();closed=true;writer?.cancel();writer=nil;reader?.cancel();reader=nil;pending.removeAll() }
}

/// One descriptor owner. Signals and process reaping are serialized on the main thread.
@MainActor final class PtyProcess {
 var onData: (Data)->Void = {_ in}
 var onExit: (Int32)->Void = {_ in}
 var onOverflow: ()->Void = {}
 private(set) var pid:pid_t=0
 private var channel:PtyChannel?
 private var monitor:DispatchSourceProcess?
 func start(executable:String,args:[String],environment:[String]) throws {
  guard pid==0 else { throw NSError(domain:"Terminal",code:1,userInfo:[NSLocalizedDescriptionKey:"Terminal is already running"]) }
  var argv=([executable]+args).map { strdup($0) }+[nil]
  var env=environment.map { strdup($0) }+[nil]
  defer { for p in argv { free(p) };for p in env { free(p) } }
  var fd:Int32 = -1
  let child=argv.withUnsafeMutableBufferPointer { a in env.withUnsafeMutableBufferPointer { e in pipeline_pty(executable,a.baseAddress,e.baseAddress,&fd,100,24) } }
  guard child>0 else { throw POSIXError(.init(rawValue:errno) ?? .EIO) }
  pid=child
  let io=PtyChannel(fd,deliver:onData,failure:onOverflow)
  channel=io
  let watch=DispatchSource.makeProcessSource(identifier:child,eventMask:.exit,queue:io.queue)
  watch.setEventHandler { [weak self] in
   io.finish()
   DispatchQueue.main.async {
    guard let self,self.pid==child else { return }
    var status:Int32=0
    _=waitpid(child,&status,0)
    self.pid=0;self.channel=nil;self.monitor?.cancel();self.monitor=nil
    let signal=status & 0x7f
    self.onExit(signal==0 ? (status >> 8) & 0xff : 128+signal)
   }
  }
  monitor=watch;watch.resume()
 }
 func send(_ data:ArraySlice<UInt8>) { channel?.send(Data(data)) }
 func resize(cols:Int,rows:Int) { channel?.resize(cols:cols,rows:rows) }
 func stop() {
  guard pid>0 else { return }
  let child=pid
  kill(-child,SIGTERM)
  DispatchQueue.main.asyncAfter(deadline:.now()+2) { [weak self] in
   guard let self,self.pid==child else { return }
   kill(-child,SIGKILL)
  }
 }
}
