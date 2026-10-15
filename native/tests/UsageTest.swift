import Foundation
@main struct UsageTest {
 static func main() throws {
  let empty = UsageData(["available": true, "history": [], "forecast": [["role":"tag","pending":20,"inputTokens":NSNull(),"outputTokens":NSNull(),"samples":0]]])
  precondition(!empty.hasHistory)
  precondition(empty.rows.count == 1 && empty.rows[0].forecast == nil)
  precondition(empty.rows[0].pending == 20)
  let measured = UsageData(["available":true,"history":[["role":"tag","calls":2,"inputTokens":100,"outputTokens":10,"unknown":1],["role":"tag","calls":1,"inputTokens":40,"outputTokens":5,"unknown":0]],"forecast":[["role":"tag","pending":3,"inputTokens":150,"outputTokens":15,"samples":2],["role":"tag","pending":2,"inputTokens":NSNull(),"outputTokens":NSNull(),"samples":0]]])
  precondition(measured.hasHistory && measured.rows[0].input == 140 && measured.rows[0].output == 15)
  precondition(measured.rows[0].calls == 3 && measured.rows[0].unknown == 1)
  precondition(measured.rows[0].forecast == nil, "Partial estimates must not appear complete")
  let known = UsageData(["available":true,"forecast":[["role":"summarize","pending":2,"inputTokens":40,"outputTokens":20,"samples":3]]])
  precondition(known.rows[0].forecast == 60)
  precondition(!UsageData(["available":false]).available)
  print("Usage presentation checks passed")
 }
}
