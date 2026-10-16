import XCTest
import SwiftUI
import AppKit
@testable import Pipeline

final class ViewportTests: XCTestCase {
 @MainActor func testSidebarKeepsTopPaddingAcrossWindowResizes() throws {
  XCTAssertNil(Bundle.main.url(forResource:"bridge",withExtension:"json"))
  _ = NSApplication.shared
  let work=Workspace();work.section="Explorer"
  let host=NSHostingView(rootView:StudioView(panel:Panel(),work:work))
  let window=NSWindow(contentRect:NSRect(x:200,y:200,width:1280,height:820),styleMask:[.titled,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
  window.isReleasedWhenClosed=false
  window.toolbar=NSToolbar(identifier:"fixture-toolbar");window.toolbarStyle = .unified
  window.contentView=host;window.orderFront(nil)
  defer {window.close()}
  func scrolls(_ view:NSView)->[NSScrollView] { (view as? NSScrollView).map{[$0]} ?? view.subviews.flatMap{scrolls($0)} }
  for height:CGFloat in [820,720,940] {
   window.setContentSize(NSSize(width:1280,height:height));host.layoutSubtreeIfNeeded()
   RunLoop.main.run(until:Date().addingTimeInterval(0.15));host.layoutSubtreeIfNeeded()
   let views=scrolls(host)
   let sidebar=try XCTUnwrap(views.filter{$0.convert($0.bounds,to:host).minX<100}.first)
   let viewport=window.convertToScreen(sidebar.convert(sidebar.bounds,to:nil))
   let usable=window.convertToScreen(window.contentLayoutRect)
   print("fixture sidebar top gap \(usable.maxY-viewport.maxY) at height \(height)")
   XCTAssertGreaterThanOrEqual(usable.maxY-viewport.maxY,40,"Sidebar must reserve significant top padding below the toolbar")
   XCTAssertLessThanOrEqual(host.fittingSize.height,height+1)
   if height==820,let directory=ProcessInfo.processInfo.environment["PIPELINE_LAYOUT_CAPTURE"],let bitmap=host.bitmapImageRepForCachingDisplay(in:host.bounds) {
    host.cacheDisplay(in:host.bounds,to:bitmap)
    try bitmap.representation(using:.png,properties:[:])?.write(to:URL(fileURLWithPath:directory).appendingPathComponent("viewport.png"))
   }
  }
 }
}
