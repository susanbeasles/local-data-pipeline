import { createHash } from "node:crypto";
export type Format = "code" | "document" | "conversation" | "text";
export type Part = {
  id: string;
  ordinal: number;
  start: number;
  end: number;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  text: string;
  hash: string;
  version: string;
  boundary: "logical" | "split";
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Lossless boundary-aware chunker. Heuristic code boundaries do not claim AST parsing. */
export function* chunks(
  sourceHash: string,
  text: string,
  format: Format,
  maximum = 24000,
): Generator<Part> {
  if (
    !/^[a-f0-9]{64}$/.test(sourceHash) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 2
  )
    throw Error("Invalid chunk configuration");
  const version = "structure-v1",
    lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0,
    byteStart = 0,
    lineStart = 1,
    ordinal = 0,
    buffer = "",
    line = 1;
  const logical = (value: string) =>
    format === "document"
      ? /^#{1,6}\s/.test(value)
      : format === "code"
        ? /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s/.test(
            value,
          )
        : format === "conversation"
          ? /^\s*\{/.test(value)
          : false;
  function part(value: string, boundary: "logical" | "split"): Part {
    const end = start + value.length,
      byteEnd = byteStart + Buffer.byteLength(value),
      newlines = (value.match(/\n/g) ?? []).length,
      result = {
        id: sha([sourceHash, version, format, start, end].join(":")),
        ordinal: ordinal++,
        start,
        end,
        byteStart,
        byteEnd,
        lineStart,
        lineEnd: lineStart + newlines,
        text: value,
        hash: sha(value),
        version,
        boundary,
      };
    start = end;
    byteStart = byteEnd;
    lineStart += newlines;
    return result;
  }
  for (const value of lines) {
    if (buffer && logical(value)) {
      yield part(buffer, "logical");
      buffer = "";
    }
    buffer += value;
    while (buffer.length > maximum) {
      let cut = buffer.lastIndexOf("\n", maximum);
      if (cut > 0) cut++;
      else cut = maximum;
      if (
        cut < buffer.length &&
        /[\uD800-\uDBFF]/.test(buffer[cut - 1]) &&
        /[\uDC00-\uDFFF]/.test(buffer[cut])
      )
        cut--;
      yield part(buffer.slice(0, cut), "split");
      buffer = buffer.slice(cut);
    }
    line++;
  }
  if (buffer) yield part(buffer, "logical");
}
