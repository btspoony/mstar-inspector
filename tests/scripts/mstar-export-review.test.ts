/**
 * `scripts/mstar-export-review.ts` — finding-carry bridge.
 *
 * Pins the carry claim in a temp harness root: a valid `mstar.review/v1`
 * envelope round-trips through FsStore to the documented destination, a
 * malformed envelope is rejected before any write, the idempotency tuple
 * normalizes `/` and `:` to one legal key (a 4-part tuple exits non-zero),
 * and `--store <module>` is forwarded to the engine loader.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore } from "@mstar-harness/engine";
import { deriveReviewKey, exportReview } from "../../scripts/mstar-export-review";
import { makeTempRoot, disposeTempRoot } from "./helpers";

const ENVELOPE = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "One finding.",
  findings: [
    {
      mergeClass: "should-fix",
      category: "logic",
      file_path: "src/server.ts",
      line_start: 3,
      title: "Null deref risk",
      body: "`user` may be null here.",
    },
  ],
};

const IDEM = "acme/org/repo/7/abc123";
const KEY = "acme-org-repo-7-abc123";

describe("deriveReviewKey", () => {
  test("normalizes / and : to the same legal key", () => {
    expect(deriveReviewKey(IDEM)).toBe(KEY);
    expect(deriveReviewKey("acme:org:repo:7:abc123")).toBe(KEY);
  });

  test("rejects a 4-part tuple", () => {
    expect(() => deriveReviewKey("acme/org/repo/7")).toThrow();
  });

  test("CLI exits non-zero on a 4-part tuple", () => {
    const run = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../scripts/mstar-export-review.ts"), "--idem", "acme/org/repo/7"],
      { stdin: new TextEncoder().encode(JSON.stringify(ENVELOPE)) },
    );
    expect(run.exitCode).not.toBe(0);
  });
});

describe("exportReview", () => {
  test("valid envelope round-trips into the documented destination", async () => {
    const root = makeTempRoot();
    try {
      const result = await exportReview({ raw: JSON.stringify(ENVELOPE), idem: IDEM, harnessRoot: root });
      const dest = join(root, "sdd", "_reviews", `${KEY}.json`);
      expect(result.path).toBe(dest);
      expect(existsSync(dest)).toBe(true);
      expect(await createFsStore(root).get({ kind: "review", key: KEY })).toEqual(ENVELOPE);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("malformed envelope is rejected before write", async () => {
    const root = makeTempRoot();
    try {
      const malformed = { ...ENVELOPE, schema: "mstar.review/v0", summary_md: "" };
      const rejection = await exportReview({ raw: JSON.stringify(malformed), idem: IDEM, harnessRoot: root }).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(rejection?.message).toMatch(/review\./);
      expect(existsSync(join(root, "sdd", "_reviews", `${KEY}.json`))).toBe(false);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("--store module is forwarded to the engine loader", async () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-export-store-"));
    const storeModule = join(root, "store.ts");
    writeFileSync(
      storeModule,
      `const log = ((globalThis as any).__mstarExportPuts ??= []);
export default () => ({
  async put(doc: any) { log.push(doc); },
  async get() { return undefined; },
});`,
    );
    try {
      await exportReview({ raw: JSON.stringify(ENVELOPE), idem: IDEM, harnessRoot: root, storeModule });
      const puts = (globalThis as any).__mstarExportPuts as { kind: string; key: string; payload: unknown }[];
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatchObject({ kind: "review", key: KEY, payload: ENVELOPE });
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__mstarExportPuts;
    }
  });
});
