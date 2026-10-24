/**
 * Task 3 — the App read face.
 *
 * Pins three things:
 *   - every read INNER JOINs `app_workspaces`, so an unmapped App is INVISIBLE
 *     and every returned row carries `workspace_id`;
 *   - the prepared SQL is the frozen `APP_READ_SQL` text, byte-for-byte;
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
  workspaceId: "default",
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

describe("apps-store tenant read face", () => {
  test("listApps returns only mapped Apps, each carrying workspace_id", async () => {
    const { db, mapped } = await seedMappedAndOrphan();
    const rows = await createAppsStore(db).listApps();
    expect(rows.map((r) => r.id)).toEqual([mapped.id]);
    expect(rows[0]!.workspace_id).toBe("default");
  });

  test("an orphan App is null from getAppById and getAppBySlug", async () => {
    const { db, mapped, orphan } = await seedMappedAndOrphan();
    const store = createAppsStore(db);
    expect((await store.getAppById(mapped.id))?.workspace_id).toBe("default");
    expect(await store.getAppById(orphan.id)).toBeNull();
    expect((await store.getAppBySlug("mapped"))?.workspace_id).toBe("default");
    expect(await store.getAppBySlug("orphan")).toBeNull();
  });
});

describe("apps-store read SQL is frozen", () => {
  test("the three read methods prepare the frozen join SQL byte-for-byte", async () => {
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
      `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id WHERE g.slug = ?`,
      `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id WHERE g.id = ?`,
      `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC, g.id`,
    ]);
  });

  test("APP_READ_SQL joins app_workspaces and selects workspace_id", () => {
    for (const sql of Object.values(APP_READ_SQL)) {
      expect(sql).toContain("INNER JOIN app_workspaces");
      expect(sql).toContain("w.workspace_id");
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

const DIRECT_READ = /(?:from|join)\s+github_apps\b/;
const TENANT_BYPASS = "shortcut: tenant-bypass";

/**
 * Every `.prepare(…)` call in one source, as {line, sql}: a single left-to-right
 * scan over the file, so several calls on ONE line are all enumerated and a
 * multi-line SQL statement is ONE site. String literals are skipped while
 * balancing parens, so a paren inside SQL does not end the call.
 */
function prepareStatements(src: string): { line: number; sql: string }[] {
  const out: { line: number; sql: string }[] = [];
  const marker = ".prepare";
  let pos = 0;
  let counted = 0;
  let line = 0;
  // Lazy line counter: `counted` only moves forward because `pos` does.
  const lineAt = (idx: number): number => {
    while (counted < idx) {
      if (src[counted] === "\n") line++;
      counted++;
    }
    return line;
  };
  for (;;) {
    const start = src.indexOf(marker, pos);
    if (start < 0) return out;
    const open = src.indexOf("(", start + marker.length);
    if (open < 0) return out;
    const callLine = lineAt(start);
    let depth = 0;
    let quote: string | null = null;
    let sql = "";
    let i = open;
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (quote !== null) {
        sql += ch;
        if (ch === "\\") sql += src[++i] ?? "";
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        sql += ch;
      } else if (ch === "(") {
        if (depth++ > 0) sql += ch;
      } else if (ch === ")") {
        if (--depth === 0) {
          i++;
          break;
        }
        sql += ch;
      } else {
        sql += ch;
      }
    }
    out.push({ line: callLine, sql: sql.replace(/\s+/g, " ").trim().toLowerCase() });
    pos = i;
  }
}

/** Every `.prepare(…)` statement that reads `github_apps`, with its start line. */
function readSites(src: string): { line: number }[] {
  return prepareStatements(src).filter((s) => DIRECT_READ.test(s.sql));
}

/**
 * True when the `.prepare(` line is IMMEDIATELY preceded by a contiguous
 * `//` comment block carrying the marker. A blank line or any code line
 * between the comment and the call means unannotated. Two calls on one line
 * share that line's annotation block, which is the point: the comment covers
 * every call on the line it precedes.
 */
function isAnnotated(lines: string[], prepareLine: number): boolean {
  for (let k = prepareLine - 1; k >= 0 && lines[k]!.trim().startsWith("//"); k--) {
    if (lines[k]!.includes(TENANT_BYPASS)) return true;
  }
  return false;
}

function directReadFiles(): string[] {
  return srcFiles()
    .filter((path) => readSites(readFileSync(path, "utf8")).length > 0)
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
      const src = readFileSync(join(SRC_DIR, rel), "utf8");
      expect({ file: rel, sites: readSites(src) }).toEqual({ file: rel, sites: [] });
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
      const src = readFileSync(join(SRC_DIR, rel), "utf8");
      const lines = src.split("\n");
      for (const site of readSites(src)) {
        expect({ file: rel, line: site.line + 1, annotated: isAnnotated(lines, site.line) }).toEqual({
          file: rel,
          line: site.line + 1,
          annotated: true,
        });
      }
    }
  });

  /**
   * The annotation claims "no tenant-facing field". The review-threads read
   * used to select `ga.slug` (a tenant-facing column) while reading
   * `identity.slug` instead — a comment that was not true of its statement.
   * Every maintenance SELECT must stay off the identity/ownership columns
   * (`private_key_enc` is frozen plan-scope maintenance credential routing, not
   * a response field).
   */
  test("a maintenance read selects no identity or ownership column", () => {
    const TENANT_FACING = /\b(?:slug|name|workspace_id)\b/i;
    for (const rel of Object.keys(MAINTENANCE_SITES)) {
      for (const site of prepareStatements(readFileSync(join(SRC_DIR, rel), "utf8"))) {
        expect({ file: rel, line: site.line + 1, tenantFacing: TENANT_FACING.test(site.sql) }).toEqual({
          file: rel,
          line: site.line + 1,
          tenantFacing: false,
        });
      }
    }
  });
});
