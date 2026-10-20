/**
 * `scripts/mstar-export-review.ts` — finding-carry bridge.
 *
 * Pins the carry claim in a temp harness root: a valid `mstar.review/v1`
 * envelope round-trips through FsStore to the documented destination, a
 * malformed envelope is rejected before any write, the idempotency tuple
 * normalizes `/` and `:` to one legal key (a 4-part tuple exits non-zero),
 * the hex key derivation is injective and never plan-shaped, and
 * `--store <module>` is forwarded to the engine loader.
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
const KEY = "r-61636d65-6f7267-7265706f-37-616263313233";

describe("deriveReviewKey", () => {
  test("normalizes / and : to the same legal key", () => {
    expect(deriveReviewKey(IDEM)).toBe(KEY);
    expect(deriveReviewKey("acme:org:repo:7:abc123")).toBe(KEY);
  });

  test("rejects a 4-part tuple", () => {
    expect(() => deriveReviewKey("acme/org/repo/7")).toThrow();
  });

  test("dash-aliased tuples derive distinct keys", () => {
    const a = deriveReviewKey("1/foo/bar-baz/7/deadbeef");
    const b = deriveReviewKey("1/foo-bar/baz/7/deadbeef");
    expect(a).not.toBe(b);
  });

  test("key is never plan-shaped", () => {
    const key = deriveReviewKey("12345678/acme/repo/7/abc123");
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(key).not.toMatch(/^[0-9]{8}-[a-z0-9-]+$/);
  });

  test("rejects a lone surrogate that would alias U+FFFD", () => {
    expect(() => deriveReviewKey("acme/\uD800/repo/7/abc123")).toThrow(/well-formed/);
    expect(() => deriveReviewKey("acme/\uDC00/repo/7/abc123")).toThrow(/well-formed/);
    // The alias target itself stays legal and encodes as itself.
    expect(deriveReviewKey("acme/\uFFFD/repo/7/abc123")).toMatch(/^r-[0-9a-f-]+$/);
  });

  test("a lone surrogate rejects the export with one line and writes nothing", async () => {
    const root = makeTempRoot();
    try {
      const rejection = await exportReview({ raw: JSON.stringify(ENVELOPE), idem: "acme/\uD800/repo/7/abc123", harnessRoot: root }).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(rejection?.message.split("\n")).toHaveLength(1);
      expect(rejection?.message).toMatch(/well-formed/);
      expect(existsSync(join(root, "sdd"))).toBe(false);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("CLI exits non-zero on a 4-part tuple", () => {
    const run = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../scripts/mstar-export-review.ts"), "--idem", "acme/org/repo/7"],
      { stdin: new TextEncoder().encode(JSON.stringify(ENVELOPE)) },
    );
    expect(run.exitCode).not.toBe(0);
  });

  test("CLI rejects --file without a value as usage", () => {
    const run = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../scripts/mstar-export-review.ts"), "--idem", IDEM, "--file"],
      { stdin: new TextEncoder().encode(JSON.stringify(ENVELOPE)) },
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString().trim().split("\n")).toHaveLength(1);
  });

  test("CLI fails an unreadable --file with one clean line", () => {
    const root = makeTempRoot();
    try {
      const run = Bun.spawnSync([
        "bun",
        "run",
        join(import.meta.dir, "../../scripts/mstar-export-review.ts"),
        "--idem",
        IDEM,
        "--harness",
        root,
        "--file",
        join(root, "missing.json"),
      ]);
      expect(run.exitCode).toBe(1);
      const lines = run.stderr.toString().trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/^\s+at /);
    } finally {
      disposeTempRoot(root);
    }
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

  test("aliased tuples write two distinct files, no overwrite", async () => {
    const root = makeTempRoot();
    try {
      const a = await exportReview({ raw: JSON.stringify(ENVELOPE), idem: "1/foo/bar-baz/7/deadbeef", harnessRoot: root });
      const b = await exportReview({ raw: JSON.stringify(ENVELOPE), idem: "1/foo-bar/baz/7/deadbeef", harnessRoot: root });
      expect(a.key).not.toBe(b.key);
      expect(existsSync(join(root, "sdd", "_reviews", `${a.key}.json`))).toBe(true);
      expect(existsSync(join(root, "sdd", "_reviews", `${b.key}.json`))).toBe(true);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("plan-shaped tuple still lands under sdd/_reviews/", async () => {
    const root = makeTempRoot();
    try {
      const result = await exportReview({
        raw: JSON.stringify(ENVELOPE),
        idem: "12345678/acme/repo/7/abc123",
        harnessRoot: root,
      });
      expect(result.path).toBe(join(root, "sdd", "_reviews", `${result.key}.json`));
      expect(existsSync(join(root, "sdd", result.key))).toBe(false);
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
