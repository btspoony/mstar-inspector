/**
 * Task 3 — the App read face under tenant mode.
 *
 * Pins three things:
 *   - `strict` INNER JOINs `app_workspaces`, so an unmapped App is INVISIBLE
 *     and every returned row carries `workspace_id`;
 *   - `off` prepares byte-identical SQL (`APP_READ_SQL.*.off`, frozen);
 *   - no `src/**` file outside the allowlist reads `github_apps` directly.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "./helpers";
import {
  APP_READ_SQL,
  createAppsStore,
  type CreateAppInput,
  type GithubAppRow,
} from "../../src/dashboard/apps-store";
import type { D1Like } from "../../src/store/types";

const SRC_DIR = join(import.meta.dir, "../../src");

const APP_INPUT: CreateAppInput = {
  id: "018f4a2e-7c1d-4e5a-9b2f-3d6c8a1e4f70",
  slug: "tenant-read-face",
  githubAppId: 987654,
  name: "tenant-read-face",
  privateKeyEnc: "v1.primary.aXZpdi.Y3QmIHRhZw==",
  webhookSecretEnc: "v1.primary.aXZpdi.d2ViaG9vaw==",
  createdBy: "octocat",
};

async function seedApp(db: D1Like, overrides: Partial<CreateAppInput> = {}): Promise<GithubAppRow> {
  return createAppsStore(db).createApp({ ...APP_INPUT, id: crypto.randomUUID(), ...overrides });
}

/** One App mapped to the 'default' workspace, one orphan App with no mapping. */
async function seedMappedAndOrphan() {
  const db = createMigratedTestD1();
  const mapped = await seedApp(db, { slug: "mapped", githubAppId: 1 });
  const orphan = await seedApp(db, { slug: "orphan", githubAppId: 2 });
  db.raw.prepare(`DELETE FROM app_workspaces WHERE app_id = ?`).run(orphan.id);
  return { db, mapped, orphan };
}

describe("apps-store tenant read face (mode: strict)", () => {
  test("listApps returns only mapped Apps, each carrying workspace_id", async () => {
    const { db, mapped } = await seedMappedAndOrphan();
    const rows = await createAppsStore(db, "strict").listApps();
    expect(rows.map((r) => r.id)).toEqual([mapped.id]);
    expect(rows[0]!.workspace_id).toBe("default");
  });

  test("an orphan App is null from getAppById and getAppBySlug", async () => {
    const { db, mapped, orphan } = await seedMappedAndOrphan();
    const store = createAppsStore(db, "strict");
    expect((await store.getAppById(mapped.id))?.workspace_id).toBe("default");
    expect(await store.getAppById(orphan.id)).toBeNull();
    expect((await store.getAppBySlug("mapped"))?.workspace_id).toBe("default");
    expect(await store.getAppBySlug("orphan")).toBeNull();
  });

  test("mode: off still sees the orphan and omits workspace_id", async () => {
    const { db, orphan } = await seedMappedAndOrphan();
    const row = await createAppsStore(db).getAppById(orphan.id);
    expect(row?.slug).toBe("orphan");
    expect(row?.workspace_id).toBeUndefined();
  });
});

describe("apps-store off SQL is frozen", () => {
  test("the three read methods prepare the frozen off SQL byte-for-byte", async () => {
    const queries: string[] = [];
    const statement = {
      bind: () => statement,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ results: [], meta: { changes: 0, last_row_id: 0 } }),
    };
    const db = {
      prepare(query: string) {
        queries.push(query);
        return statement;
      },
      batch: async () => [],
    };
    const store = createAppsStore(db);
    await store.getAppBySlug("slug");
    await store.getAppById("id");
    await store.listApps();
    // Literals, NOT APP_READ_SQL: a mutated production constant must fail here.
    expect(queries).toEqual([
      `SELECT * FROM github_apps WHERE slug = ?`,
      `SELECT * FROM github_apps WHERE id = ?`,
      `SELECT * FROM github_apps WHERE deleted_at IS NULL ORDER BY created_at DESC, id`,
    ]);
    for (const sql of queries) expect(sql).not.toContain("app_workspaces");
  });

  test("strict SQL joins app_workspaces and selects workspace_id", () => {
    for (const pair of Object.values(APP_READ_SQL)) {
      expect(pair.strict).toContain("INNER JOIN app_workspaces");
      expect(pair.strict).toContain("w.workspace_id");
    }
  });
});

/** Every `.ts` file under src/, relative to the repo root. */
function srcFiles(dir = SRC_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const DIRECT_READ = /\b(?:from|join)\s+github_apps\b/i;
const TENANT_BYPASS = "shortcut: tenant-bypass";

/** Line offsets of every direct `github_apps` read in one source text. */
function readSites(src: string): number[] {
  return src.split("\n").flatMap((line, i) => (DIRECT_READ.test(line) ? [i] : []));
}

/**
 * True when the statement carrying the read at `lineIndex` is annotated: walk
 * up to the `.prepare(` that opened it, then through the contiguous
 * non-blank block above, looking for the marker in that statement's comment.
 */
function isAnnotated(lines: string[], lineIndex: number): boolean {
  let p = lineIndex;
  while (p >= 0 && !/\.prepare\s*\(/.test(lines[p]!)) p--;
  if (p < 0) return false;
  for (let k = p - 1; k >= 0 && lines[k]!.trim() !== ""; k--) {
    if (lines[k]!.includes(TENANT_BYPASS)) return true;
  }
  return false;
}

function directReadFiles(): string[] {
  return srcFiles()
    .filter((path) => DIRECT_READ.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(SRC_DIR.length + 1))
    .sort();
}

/** The maintenance face: every direct `github_apps` read outside apps-store. */
const MAINTENANCE_SITES: Record<string, number> = {
  "worker/lifecycle-reconcile.ts": 1,
  "worker/check-reconcile.ts": 2,
  "pipeline/review-threads.ts": 1,
  "store/review-checks.ts": 1,
};

describe("tenant read face allowlist", () => {
  test("tenant-facing modules hold no direct github_apps read", () => {
    for (const rel of ["dashboard/index.ts", "dashboard/views.ts", "pipeline/consumer.ts"]) {
      expect(readFileSync(join(SRC_DIR, rel), "utf8")).not.toMatch(DIRECT_READ);
    }
  });

  test("only apps-store plus the four maintenance files read github_apps", () => {
    expect(directReadFiles()).toEqual([
      "dashboard/apps-store.ts",
      ...Object.keys(MAINTENANCE_SITES).sort(),
    ]);
  });

  test("maintenance files hold exactly their pinned number of direct reads", () => {
    const counts = Object.fromEntries(
      Object.keys(MAINTENANCE_SITES)
        .sort()
        .map((rel) => [rel, readSites(readFileSync(join(SRC_DIR, rel), "utf8")).length]),
    );
    expect(counts).toEqual(MAINTENANCE_SITES);
  });

  test("every maintenance direct read carries its tenant-bypass annotation", () => {
    for (const rel of Object.keys(MAINTENANCE_SITES)) {
      const lines = readFileSync(join(SRC_DIR, rel), "utf8").split("\n");
      for (const site of readSites(lines.join("\n"))) {
        expect({ file: rel, line: site + 1, annotated: isAnnotated(lines, site) }).toEqual({
          file: rel,
          line: site + 1,
          annotated: true,
        });
      }
    }
  });
});
