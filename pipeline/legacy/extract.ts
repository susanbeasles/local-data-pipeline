import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
export type ExtractChunk = {
  index: number;
  text: string;
  start: number;
  end: number;
};
/** Ranges and characters count UTF-16 code units. null hash means source was not read. */
export type ExtractResult = {
  status: "complete" | "blocked";
  format: string;
  sourceHash: string | null;
  bytes: number;
  characters: number;
  chunks: number;
  reason?: string;
};
/** Conservative filename exclusion, evaluated before stat/open. */
export function exclude(path: string): string | undefined {
  const name = basename(path).toLowerCase();
  if (
    /(?:^|\/)remote\/(github-ops|github-logs|github-artifacts)(\/|$)/i.test(
      path,
    )
  )
    return "GitHub Actions source excluded without reading";
  if (
    /^(?:auth\.json|credentials(?:\..*)?|secrets?\.(?:json|ya?ml)|id_(?:rsa|ed25519).*|.*\.(?:keystore|jks)|.*(?:credential|token|password)[-_]?store.*|cookies(?:-journal)?|login data(?:-journal)?)$/.test(
      name,
    ) ||
    path.toLowerCase().includes("/.config/gcloud/")
  )
    return "Credential source excluded without reading";
  if (
    /\.(enc|sparseimage|dmg)$/i.test(path) ||
    /(^|\/)\S*\.sparsebundle(\/|$)/i.test(path)
  )
    return "Encrypted or disk-image source; no decryption attempted";
  if (
    /(^|\/)(\.ssh|\.aws|\.gnupg|\.azure|\.kube|keychains?|credentials?)(\/|$)/i.test(
      path,
    ) ||
    /^\.env($|\.)/.test(name) ||
    /^(credentials?|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc)$/.test(name) ||
    /\.(pem|key|p12|pfx|keychain|keychain-db)$/i.test(name)
  )
    return "Credential source excluded without reading";
}
const unsupported =
  /\.(sqlite3?|db|pack|idx|pdf|png|jpe?g|gif|webp|ico|tiff?|heic|mp[34]|m4[av]|wav|aiff?|flac|ogg|mov|avi|zip|gz|bz2|xz|7z|tar|woff2?|ttf|otf|docx?|xlsx?|pptx?|exe|dll|so|dylib)$/i;
function signature(data: Buffer): boolean {
  const prefix = data.subarray(0, 32);
  return (
    prefix.subarray(0, 4).equals(Buffer.from("%PDF")) ||
    prefix.subarray(0, 4).equals(Buffer.from("PACK")) ||
    prefix.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ||
    prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))
  );
}
/** Partial yielded chunks must be discarded when terminal status is blocked. Memory is bounded. */
export async function* extract(
  path: string,
): AsyncGenerator<ExtractChunk, ExtractResult> {
  let bytes = 0,
    characters = 0,
    chunks = 0;
  const denied = exclude(path);
  if (denied)
    return {
      status: "blocked",
      format: "excluded",
      sourceHash: null,
      bytes,
      characters,
      chunks,
      reason: denied,
    };
  let info;
  try {
    info = await lstat(path);
  } catch {
    return {
      status: "blocked",
      format: "unreadable",
      sourceHash: null,
      bytes,
      characters,
      chunks,
      reason: "Source cannot be inspected",
    };
  }
  if (!info.isFile())
    return {
      status: "blocked",
      format: "unsupported",
      sourceHash: null,
      bytes,
      characters,
      chunks,
      reason: "Only regular files are supported; symlinks are not followed",
    };
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let reason = unsupported.test(extname(path))
    ? "Unsupported format; text extraction unavailable"
    : undefined;
  // Git loose objects are zlib binary; deliberately blocked rather than partially inflated.
  if (/\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/i.test(path))
    reason = "Git loose compressed object extraction unavailable";
  let pending = "",
    first = true;
  try {
    for await (const value of createReadStream(path, {
      highWaterMark: 65536,
    })) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(data);
      bytes += data.length;
      if (first) {
        if (signature(data)) reason = "Unsupported binary format";
        first = false;
      }
      if (reason) continue;
      if (data.includes(0)) {
        reason = "Binary NUL byte detected";
        pending = "";
        continue;
      }
      let text: string;
      try {
        text = decoder.decode(data, { stream: true });
      } catch {
        reason = "Invalid UTF-8; full text extraction unavailable";
        pending = "";
        continue;
      }
      if (/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
        reason = "Binary control characters detected";
        pending = "";
        continue;
      }
      pending += text;
      while (pending.length >= 24000) {
        let size = 24000;
        const unit = pending.charCodeAt(size - 1);
        if (unit >= 0xd800 && unit <= 0xdbff) size--;
        const text = pending.slice(0, size);
        pending = pending.slice(size);
        yield {
          index: chunks++,
          text,
          start: characters,
          end: characters + text.length,
        };
        characters += text.length;
      }
    }
    if (!reason) {
      try {
        pending += decoder.decode();
      } catch {
        reason = "Incomplete UTF-8 sequence at end";
      }
    }
  } catch {
    return {
      status: "blocked",
      format: "unreadable",
      sourceHash: null,
      bytes,
      characters,
      chunks,
      reason: "Source read failed; hash would be incomplete",
    };
  }
  if (reason)
    return {
      status: "blocked",
      format: "unsupported",
      sourceHash: hash.digest("hex"),
      bytes,
      characters,
      chunks,
      reason,
    };
  if (pending) {
    yield {
      index: chunks++,
      text: pending,
      start: characters,
      end: characters + pending.length,
    };
    characters += pending.length;
  }
  return {
    status: "complete",
    format: "utf-8",
    sourceHash: hash.digest("hex"),
    bytes,
    characters,
    chunks,
  };
}
