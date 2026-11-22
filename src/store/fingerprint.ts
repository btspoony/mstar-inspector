
/** One finding's fingerprint-relevant fields (subset of MstarReviewFinding + body exclusion). */
export type FindingFingerprintInput = {
  file_path?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  title: string;
  category?: string | null;
  mergeClass?: string | null;
  fingerprint_hint?: string | null;
};

const TRAILING_PUNCTUATION = /[.,;:!?'"。，；：！？、…”’」』）】》〉]+$/;
const REDACTION_MARKER = "[REDACTED]";

const FNV_HIGH = 0xcbf29ce4;
const FNV_LOW = 0x84222325;
const FNV_PRIME = 0x1b3;
const TWO_32 = 0x100000000;

function fnv1a64Hex(input: string): string {
  let hi = FNV_HIGH;
  let lo = FNV_LOW;
  for (let i = 0; i < input.length; i++) {
    lo = (lo ^ input.charCodeAt(i)) >>> 0;
    const prod = lo * FNV_PRIME;
    const loNext = prod & 0xffffffff;
    const carry = Math.floor(prod / TWO_32);
    const hiNext = (carry + ((hi * FNV_PRIME) & 0xffffffff) + (((lo << 8) & 0xffffffff) >>> 0)) & 0xffffffff;
    lo = loNext;
    hi = hiNext;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

function lineBucket(lineStart: number | null | undefined): string {
  if (lineStart == null || lineStart <= 0) return "noline";
  return String(Math.floor((lineStart - 1) / 10) * 10 + 1);
}

function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(TRAILING_PUNCTUATION, "");
}

/**
 * Deterministic finding fingerprint: a non-blank `fingerprint_hint` that
 * does NOT contain the redaction marker is returned verbatim (legacy
 * passthrough); otherwise FNV-1a 64 over the normalized composite
 * `path \0 bucket \0 title` (W-1 + Bugbot wave-1 — a blank or marker-bearing
 * hint falls back so the marker is never identity, embedded or exact).
 * Synchronous pure function — safe to call inside the persist path's
 * synchronous `.map()` (AL-21-1).
 */
export function computeFindingFingerprint(f: FindingFingerprintInput): string {
  const hint = f.fingerprint_hint;
  if (hint != null && hint.trim() !== "" && !hint.includes(REDACTION_MARKER)) {
    return hint;
  }
  const path = (f.file_path ?? "").replace(/\\/g, "/");
  return fnv1a64Hex(path + "\0" + lineBucket(f.line_start) + "\0" + normalizeTitle(f.title));
}
