import XCTest
import SwiftUI
import AppKit
@testable import Pipeline

final class LayoutTests: XCTestCase {
 @MainActor func testExpandedDockFitsItsAllocatedHeight() {
  XCTAssertNil(Bundle.main.url(forResource:"bridge",withExtension:"json"),"Synthetic UI test must not load operator bindings")
  _ = NSApplication.shared
  for height:CGFloat in [260,340] {
   let host=NSHostingView(rootView:TerminalDock(maxHeight:height,expanded:true).environmentObject(Workspace()))
   host.frame=NSRect(x:0,y:0,width:1080,height:height)
   host.layoutSubtreeIfNeeded()
   XCTAssertLessThanOrEqual(host.fittingSize.height,height+1)
   XCTAssertLessThanOrEqual(host.fittingSize.width,1080)
   func terminal(in view:NSView)->NSView? {
    if NSStringFromClass(type(of:view)).contains("TerminalView") { return view }
    return view.subviews.lazy.compactMap { terminal(in:$0) }.first
   }
   let surface=terminal(in:host)
   XCTAssertNotNil(surface)
   if let surface {
    let rect=surface.convert(surface.bounds,to:host)
    XCTAssertGreaterThanOrEqual(rect.minY,-1)
    XCTAssertLessThanOrEqual(rect.maxY,height+1)
   }
  }
 }
 @MainActor func testDashboardMinimumDoesNotAddTerminalHeight() {
  XCTAssertNil(Bundle.main.url(forResource:"bridge",withExtension:"json"))
  _ = NSApplication.shared
  let host=NSHostingView(rootView:StudioView(panel:Panel()))
  host.frame=NSRect(x:0,y:0,width:1280,height:820)
  host.layoutSubtreeIfNeeded()
  XCTAssertLessThanOrEqual(host.fittingSize.height,820)
 }

 @MainActor func testJsonPaneStartsAtTopAfterViewportResize() {
  _ = NSApplication.shared
  let values=Dictionary(uniqueKeysWithValues:(0..<100).map { (String(format:"field%03d",$0),"value") })
  let host=NSHostingView(rootView:JsonTree(value:values,source:"fixture").environmentObject(Workspace()))
  let window=NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:320),styleMask:[.titled,.resizable],backing:.buffered,defer:false)
  window.isReleasedWhenClosed=false
  window.contentView=host
  func scrolls(_ view:NSView)->[NSScrollView] { (view as? NSScrollView).map{[$0]} ?? view.subviews.flatMap{scrolls($0)} }
  for height:CGFloat in [320,180,400] {
   window.setContentSize(NSSize(width:600,height:height))
   host.layoutSubtreeIfNeeded()
   RunLoop.main.run(until:Date().addingTimeInterval(0.1))
   host.layoutSubtreeIfNeeded()
   let views=scrolls(host)
   XCTAssertFalse(views.isEmpty)
   for scroll in views {
    guard let document=scroll.documentView else { continue }
    let visible=scroll.documentVisibleRect
    if document.isFlipped { XCTAssertGreaterThanOrEqual(visible.minY,-1);XCTAssertLessThanOrEqual(visible.minY,1) }
    else { XCTAssertLessThanOrEqual(abs(visible.maxY-document.bounds.maxY),1) }
   }
  }
  window.close()
 }
}
