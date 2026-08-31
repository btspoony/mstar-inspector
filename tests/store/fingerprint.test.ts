/**
 * Finding fingerprint normalization contract lock (plan 21 Task 1, AL-21-1).
 *
 * `src/store/fingerprint.ts` is the single source of truth for the
 * deterministic finding fingerprint written to `findings.fingerprint`
 * (persist path consumes it in Task 2). Locked input domain:
 *
 *   fnv1a64(normPath(file_path) + "\0" + bucket + "\0" + normTitle)
 *
 * - normPath: `\` → `/` (Windows path normalization), NO case folding
 * - normTitle: trim → collapse whitespace → lowercase → strip TRAILING punctuation
 * - bucket: `line_start == null ? "noline" : String(Math.floor((line_start - 1) / 10) * 10 + 1)`
 *   (N=10 FIXED line bucket, not a sliding window)
 * - `body` / `line_end` / `category` / `mergeClass` never enter the hash
 * - `fingerprint_hint` (non-blank) wins verbatim — legacy passthrough behavior
 *
 * These pins are the AC-21a evidence set ("归一化单测 pin 过": near-line same
 * fingerprint / cross-file different / title normalization / mergeClass no
 * effect / hint priority) plus the fixed-bucket boundary, no-line bucket, and
 * a golden FNV-1a 64 vector (pins the hash algorithm + 16 lowercase hex shape).
 */
import { describe, expect, test } from "bun:test";
import { computeFindingFingerprint, type FindingFingerprintInput } from "../../src/store/fingerprint";

/** Default realistic finding; tests override only the dimension under pin. */
function finding(over: Partial<FindingFingerprintInput> = {}): FindingFingerprintInput {
  return {
    file_path: "src/app.ts",
    line_start: 15,
    line_end: 18,
    category: "bug",
    mergeClass: "must-fix",
    title: "Fix the bug",
    ...over,
  };
}

const fp = (f: FindingFingerprintInput): string => computeFindingFingerprint(f);

describe("computeFindingFingerprint", () => {
  test("output shape: 16 lowercase hex for every normalized input", () => {
    const inputs = [
      finding(),
      finding({ file_path: null, line_start: null, title: "No location issue" }),
      finding({ file_path: "src\\App.TS", line_start: 1, title: "UPPER path" }),
      finding({ title: "  only   whitespace   differences  . " }),
      finding({ line_start: undefined, file_path: undefined }),
    ];
    for (const f of inputs) {
      expect(fp(f)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("golden vector: pins FNV-1a 64 over the normalized composite", () => {
    // normPath("src/foo.ts") + "\0" + bucket(15 → "11") + "\0" + normTitle("Fix the bug!") =
    // "src/foo.ts\011\0fix the bug" → FNV-1a 64 = c3f136c3fe89ebbb (canonical vector, verified
    // against the BigInt FNV-1a 64 reference: "" → cbf29ce484222325, "a" → af63dc4c8601ec8c).
    expect(fp(finding({ file_path: "src/foo.ts", title: "Fix the bug!" }))).toBe("c3f136c3fe89ebbb");
  });

  test("fixed bucket N=10: lines 1 and 10 share a fingerprint", () => {
    expect(fp(finding({ line_start: 1 }))).toBe(fp(finding({ line_start: 10 })));
  });

  test("fixed bucket N=10: lines 11 and 20 share a fingerprint", () => {
    expect(fp(finding({ line_start: 11 }))).toBe(fp(finding({ line_start: 20 })));
  });

  test("fixed bucket N=10: lines 15 and 16 share a fingerprint", () => {
    expect(fp(finding({ line_start: 15 }))).toBe(fp(finding({ line_start: 16 })));
  });

  test("bucket boundary pin: lines 10 and 11 are DIFFERENT buckets", () => {
    expect(fp(finding({ line_start: 10 }))).not.toBe(fp(finding({ line_start: 11 })));
  });

  test("no-line pin: line_start null → noline bucket, file+title dimension", () => {
    const a = fp(finding({ line_start: null }));
    // Same file+title, null line → deterministic noline fingerprint.
    expect(a).toBe(fp(finding({ line_start: null })));
    // noline bucket ≠ line-1 bucket.
    expect(a).not.toBe(fp(finding({ line_start: 1 })));
    // Different file in the noline dimension → different fingerprint.
    expect(a).not.toBe(fp(finding({ line_start: null, file_path: "src/other.ts" })));
  });

  test("no-line pin: undefined line_start behaves like null (noline bucket)", () => {
    expect(fp(finding({ line_start: undefined }))).toBe(fp(finding({ line_start: null })));
  });

  test("cross-file: different file_path → different fingerprint", () => {
    expect(fp(finding({ file_path: "src/app.ts" }))).not.toBe(fp(finding({ file_path: "src/other.ts" })));
  });

  test("normPath: backslash equals slash (Windows path, no case folding)", () => {
    expect(fp(finding({ file_path: "src\\app.ts" }))).toBe(fp(finding({ file_path: "src/app.ts" })));
    expect(fp(finding({ file_path: "src/App.ts" }))).not.toBe(fp(finding({ file_path: "src/app.ts" })));
  });

  test("title normalization: case/whitespace/trailing punctuation are equivalent", () => {
    const base = fp(finding({ title: "Fix the bug" }));
    const variants = [
      "FIX THE BUG",
      "fix the bug",
      "  Fix   the  bug  ",
      "Fix the bug.",
      "Fix the bug!",
      "Fix the bug...?",
      "  FIX   the  BUG. ",
    ];
    for (const title of variants) {
      expect(fp(finding({ title }))).toBe(base);
    }
  });

  test("title normalization: different content → different fingerprint", () => {
    expect(fp(finding({ title: "Fix the bug" }))).not.toBe(fp(finding({ title: "Fix the typo" })));
  });

  test("mergeClass and category never enter the hash", () => {
    const base = fp(finding());
    expect(fp(finding({ mergeClass: "nit" }))).toBe(base);
    expect(fp(finding({ mergeClass: null }))).toBe(base);
    expect(fp(finding({ category: "performance" }))).toBe(base);
    expect(fp(finding({ category: null }))).toBe(base);
    expect(fp(finding({ category: undefined, mergeClass: undefined }))).toBe(base);
  });

  test("line_end never enters the hash", () => {
    const base = fp(finding());
    expect(fp(finding({ line_end: 99 }))).toBe(base);
    expect(fp(finding({ line_end: null }))).toBe(base);
  });

  test("hint priority: non-blank hint is returned verbatim, regardless of the finding", () => {
    expect(fp(finding({ fingerprint_hint: "abc123" }))).toBe("abc123");
    // Verbatim: no hex coercion, no case folding, no trimming.
    expect(fp(finding({ fingerprint_hint: "custom-hint!" }))).toBe("custom-hint!");
    // Title/body/file changes do not change the fingerprint while a hint exists.
    expect(fp(finding({ fingerprint_hint: "abc123", file_path: "other.ts", line_start: 1, title: "Different" }))).toBe(
      "abc123",
    );
  });

  test("hint priority: null/undefined/blank hint falls back to normalization", () => {
    const base = fp(finding());
    expect(fp(finding({ fingerprint_hint: null }))).toBe(base);
    expect(fp(finding({ fingerprint_hint: undefined }))).toBe(base);
    expect(fp(finding({ fingerprint_hint: "" }))).toBe(base);
    expect(fp(finding({ fingerprint_hint: "   " }))).toBe(base);
  });
});
