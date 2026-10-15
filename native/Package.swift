// swift-tools-version: 5.9
import PackageDescription
let package = Package(
 name: "PipelinePanel",
 platforms: [.macOS(.v14)],
 dependencies: [.package(url: "https://github.com/migueldeicaza/SwiftTerm.git", revision: "8840e3596739adfe9599c0e7fff89f4fa88bedcf")],
 targets: [.executableTarget(name: "Pipeline", dependencies: ["CPty",.product(name: "SwiftTerm", package: "SwiftTerm")], path: ".", exclude: ["build.ts", "tests", "pty"]), .target(name:"CPty",path:"pty",publicHeadersPath:"include"), .testTarget(name:"TerminalPTY",dependencies:["Pipeline"],path:"tests/TerminalPTY") ]
)
