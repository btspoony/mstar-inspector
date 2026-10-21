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
  test("the three read methods prepare APP_READ_SQL.*.off byte-for-byte", async () => {
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
    expect(queries).toEqual([
      APP_READ_SQL.getAppBySlug.off,
      APP_READ_SQL.getAppById.off,
      APP_READ_SQL.listApps.off,
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

function directReadFiles(): string[] {
  return srcFiles()
    .filter((path) => DIRECT_READ.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(SRC_DIR.length + 1))
    .sort();
}

describe("tenant read face allowlist", () => {
  test("tenant-facing modules hold no direct github_apps read", () => {
    for (const rel of ["dashboard/index.ts", "dashboard/views.ts", "pipeline/consumer.ts"]) {
      expect(readFileSync(join(SRC_DIR, rel), "utf8")).not.toMatch(DIRECT_READ);
    }
  });

  test("only apps-store plus the five annotated maintenance sites read github_apps", () => {
    expect(directReadFiles()).toEqual([
      "dashboard/apps-store.ts",
      "pipeline/review-threads.ts",
      "store/review-checks.ts",
      "worker/check-reconcile.ts",
      "worker/lifecycle-reconcile.ts",
    ]);
  });

  test("every maintenance direct read is annotated tenant-bypass", () => {
    for (const rel of [
      "pipeline/review-threads.ts",
      "store/review-checks.ts",
      "worker/check-reconcile.ts",
      "worker/lifecycle-reconcile.ts",
    ]) {
      expect(readFileSync(join(SRC_DIR, rel), "utf8")).toContain("shortcut: tenant-bypass");
    }
  });
});
