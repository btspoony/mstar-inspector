/**
 * Finding fingerprint normalization (plan 21 Task 1, AL-21-1) — the single
 * source of truth for the deterministic fingerprint written to
 * `findings.fingerprint` (persist-path consumer: `artifact-store.ts`, Task 2).
 *
 * Locked input domain (architect verdict AL-21-1):
 *
 *   fnv1a64(normPath(file_path) + "\0" + bucket + "\0" + normTitle)
 *
 * - normPath: `\` → `/` (Windows path normalization), NO case folding;
 *   `null`/`undefined` file_path normalizes to "" (repo-level dimension)
 * - normTitle: trim → collapse whitespace → lowercase → strip TRAILING
 *   punctuation (locked set below)
 * - bucket: N=10 FIXED line bucket (lines 1–10 → "1", 11–20 → "11", …), NOT
 *   a sliding window; null/undefined OR non-positive line_start → "noline"
 *   (file+title dimension; S-2 — a ≤0 line is not a real location)
 * - `body` / `line_end` / `category` / `mergeClass` NEVER enter the hash
 * - `fingerprint_hint` (non-blank, non-marker) wins verbatim — legacy
 *   passthrough preserved (Global Constraint "fingerprint_hint 优先"); a
 *   blank or `[REDACTED]`-marker hint falls back to the normalized path
 *   (W-1, qc2 F-001 — the marker is never identity)
 *
 * This is a LEAF pure function: no imports, no IO, no clock — the same
 * output in Bun tests and workerd production. FNV-1a 64-bit is a two-word
 * (32-bit halves) pure-JS multiply loop (no BigInt, no async
 * `crypto.subtle` — AL-21-1 同步性裁决), output is the canonical 16
 * lowercase hex digits (verified against the BigInt FNV-1a 64 reference:
 * "" → cbf29ce484222325, "a" → af63dc4c8601ec8c).
 */

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

/**
 * Trailing punctuation stripped by normTitle (locked set): ASCII and CJK
 * sentence punctuation plus closing quotes/brackets.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"。，；：！？、…”’」』）】》〉]+$/;
/**
 * The redaction marker `redactSecrets` substitutes for every secret-shaped
 * span (src/pipeline/redact.ts `REDACTED`). A hint equal to it must never be
 * persisted or matched as identity — every secret-bearing finding would
 * otherwise collapse into one false repeat. Kept as a literal here: this
 * module is a zero-import leaf (AL-21-1), so the constant is mirrored with a
 * sync comment instead of imported.
 */
const REDACTION_MARKER = "[REDACTED]";

/** FNV-1a 64-bit offset basis, split into high/low 32-bit words. */
const FNV_HIGH = 0xcbf29ce4;
const FNV_LOW = 0x84222325;
/** FNV-1a 64-bit prime = 0x100000001b3 (low word 0x1b3; high multiply by 0x100 + 2^40 term). */
const FNV_PRIME = 0x1b3;
const TWO_32 = 0x100000000;

/** FNV-1a 64-bit over the UTF-16 code units of `input`, as 16 lowercase hex digits. */
function fnv1a64Hex(input: string): string {
  let hi = FNV_HIGH;
  let lo = FNV_LOW;
  for (let i = 0; i < input.length; i++) {
    lo = (lo ^ input.charCodeAt(i)) >>> 0;
    // hash = hash * 0x100000001b3 (mod 2^64) = hash * 0x1b3 + hash * 2^40.
    // hash * 0x1b3: low word + carry into high word.
    const prod = lo * FNV_PRIME; // ≤ ~2^47, exactly representable
    const loNext = prod & 0xffffffff;
    const carry = Math.floor(prod / TWO_32);
    // hash * 2^40: only bits 40–63 survive (≤ 2^64), landing in high word
    // bits 8–31 → (lo << 8) masked to 32 bits.
    const hiNext = (carry + ((hi * FNV_PRIME) & 0xffffffff) + (((lo << 8) & 0xffffffff) >>> 0)) & 0xffffffff;
    lo = loNext;
    hi = hiNext;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

/** bucket: N=10 fixed line bucket; null/undefined or non-positive line_start → "noline" (S-2). */
function lineBucket(lineStart: number | null | undefined): string {
  if (lineStart == null || lineStart <= 0) return "noline";
  return String(Math.floor((lineStart - 1) / 10) * 10 + 1);
}

/** normTitle: trim → collapse whitespace → lowercase → strip trailing punctuation. */
function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(TRAILING_PUNCTUATION, "");
}

/**
 * Deterministic finding fingerprint: a non-blank `fingerprint_hint` that is
 * NOT the redaction marker is returned verbatim (legacy passthrough);
 * otherwise FNV-1a 64 over the normalized composite `path \0 bucket \0 title`
 * (W-1 — a blank or `[REDACTED]` hint falls back so the marker is never
 * identity). Synchronous pure function — safe to call inside the persist
 * path's synchronous `.map()` (AL-21-1).
 */
export function computeFindingFingerprint(f: FindingFingerprintInput): string {
  const hint = f.fingerprint_hint;
  if (hint != null && hint.trim() !== "" && hint !== REDACTION_MARKER) {
    return hint;
  }
  // normPath: `\` → `/`, no case folding; null/undefined file_path → "" (repo-level dimension).
  const path = (f.file_path ?? "").replace(/\\/g, "/");
  return fnv1a64Hex(path + "\0" + lineBucket(f.line_start) + "\0" + normalizeTitle(f.title));
}
