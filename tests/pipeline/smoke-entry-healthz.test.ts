/**
 * The local smoke entry's `/healthz` keeps the same shape as
 * the production worker face — `{"ok":true,"version":"vX.Y.Z"}` from the
 * generated single source (src/version.ts). The module statically imports
 * the workerd-only sandbox SDK chain, so Bun tests cannot import it; this is
 * the same source-scan pin contract as the SPA pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const smokeEntry = readFileSync(join(import.meta.dir, "../../src/pipeline/smoke-entry.ts"), "utf8");

describe("smoke-entry healthz face", () => {
  test("consumes the generated version constant (single source)", () => {
    expect(smokeEntry).toContain('import { APP_VERSION } from "../version";');
  });

  test("answers the same shape as the worker healthz (ok + v-prefixed version)", () => {
    expect(smokeEntry).toContain("Response.json({ ok: true, version: `v${APP_VERSION}` })");
  });
});
