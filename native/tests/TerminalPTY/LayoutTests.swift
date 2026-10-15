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
}
