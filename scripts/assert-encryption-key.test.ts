/**
 * why: The encryption-key preflight's verdict (`scripts/assert-encryption-key.ts`).
 *
 * The verdict is the gate's only decision, so the table below is over the
 * VALUES: every shape `importKey` rejects aborts with the required shape named,
 * a usable key passes, and no verdict ever echoes the value. Nothing here stubs
 * the parser — `createSecretbox` is the runtime's own face, which is the whole
 * point of the gate.
 *
 * One row disagrees with the plan's table on purpose: a trailing newline PASSES.
 * `importKey` decodes through `atob`, whose forgiving-base64 form ignores ASCII
 * whitespace, so such a key decodes to the same 32 bytes and the runtime uses it
 * happily. A gate that refused it would be a second validity rule rejecting a
 * key the Worker accepts — the divergence this plan exists to prevent.
 *
 * No database anywhere: the verdict takes a key and returns a message, and the
 * import list below proves the gate reaches no store or D1 binding.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encryptionKeyVerdict, REQUIRED_SHAPE } from "./assert-encryption-key";

/** note: 32 raw bytes as standard base64 — the one accepted shape. */
const KEY_32 = btoa("k".repeat(32));
/** note: The same bytes in base64url (`-`/`_` for `+`/`/`): rejected by the parser. */
const KEY_32_URL = btoa("ÿ".repeat(32)).replace(/\+/g, "-").replace(/\//g, "_");
/** note: Raw bytes as standard base64, for the wrong-length rows. */
const keyOf = (n: number) => btoa("k".repeat(n));

describe("encryptionKeyVerdict: the key shapes the runtime parser rejects", () => {
  test("a valid 32-byte key passes and the round-trip returns its own plaintext", async () => {
    const verdict = await encryptionKeyVerdict(KEY_32);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain(REQUIRED_SHAPE);
    // why: The gate's success means the plaintext came back, not merely that the
    // import succeeded — a green verdict after a broken GCM round-trip would be
    // the same lie the issue reports.
    expect(verdict.message).toContain("round-trip passed");
  });

  /** note: Every malformed row: refused, shape named, length named, value never echoed. */
  const REFUSED: { label: string; value: string | undefined; detail: string }[] = [
    { label: "unset", value: undefined, detail: "is not set" },
    { label: "empty string", value: "", detail: "is not set" },
    { label: "not base64", value: "not-a-base64-key!", detail: "is not valid base64" },
    { label: "31 bytes", value: keyOf(31), detail: "must decode to exactly 32 bytes (got 31)" },
    { label: "33 bytes", value: keyOf(33), detail: "must decode to exactly 32 bytes (got 33)" },
    // why: `openssl rand -hex 32` is the other obvious generation mistake: 64 base64
    // characters, i.e. 48 bytes.
    { label: "hex-encoded key", value: "e".repeat(64), detail: "must decode to exactly 32 bytes (got 48)" },
    { label: "base64url", value: KEY_32_URL, detail: "is not valid base64" },
  ];

  for (const { label, value, detail } of REFUSED) {
    test(`${label} fails, naming the shape and the observed length`, async () => {
      const verdict = await encryptionKeyVerdict(value);
      expect(verdict.ok).toBe(false);
      // why: The parser's own words, not a re-derived rule: the message carries the
      // reason the runtime would have thrown at first use.
      expect(verdict.message).toContain(detail);
      expect(verdict.message).toContain(REQUIRED_SHAPE);
      // invariant: The refusal is a sentence an operator can act on, never the value.
      if (value) {
        expect(verdict.message).not.toContain(value);
        expect(verdict.message).not.toContain(value.slice(0, 6));
      }
    });
  }

  test("the base64url fixture really is outside the standard alphabet", () => {
    // why: Guards the row above from passing for the wrong reason (a 32-byte value
    // that happened to need no `+`/`/` would be valid standard base64).
    expect(KEY_32_URL).toMatch(/[-_]/);
    expect(keyOf(32)).not.toBe(KEY_32_URL);
  });

  test("a trailing newline passes: atob ignores ASCII whitespace, so the key is the same 32 bytes", async () => {
    const verdict = await encryptionKeyVerdict(`${KEY_32}\n`);
    expect(verdict.ok).toBe(true);
  });
});

describe("the gate reads no database", () => {
  test("its only import is the runtime secretbox", () => {
    // why: The plan's acceptance criterion is "a valid key passes regardless of
    // whether the database holds encrypted rows". That holds because the gate
    // has no database handle at all: an empty production D1 is indistinguishable
    // from a full one here.
    const source = readFileSync(join(import.meta.dir, "assert-encryption-key.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*from\s+"([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../src/dashboard/secretbox"]);
    for (const needle of ["D1Database", "wrangler", "--db", "SELECT", "INSERT"]) {
      expect(source).not.toContain(needle);
    }
  });
});
