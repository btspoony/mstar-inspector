/**
 * Task 3 — the App read face.
 *
 * Pins two things:
 *   - every read INNER JOINs `bot_workspaces`, so an unmapped App is INVISIBLE
 *     and every returned row carries `workspace_id`;
 *   - no `src/**` file outside the allowlist reads `review_bots` directly.
 *
 * The exact SQL text is deliberately NOT pinned: those literals proved nothing
 * a behaviour test does not (see the orphan-App and soft-deleted-tenant cases),
 * and re-pinning them made every wording change a false regression.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "./helpers";
import {
  APP_READ_SQL,
  createReviewBotsStore,
  type CreateAppInput,
  type GithubAppRow,
} from "../../src/dashboard/apps-store";
import type { D1Like } from "../../src/store/types";

const SRC_DIR = join(import.meta.dir, "../../src");

const APP_INPUT: CreateAppInput = {
  id: "018f4a2e-7c1d-4e5a-9b2f-3d6c8a1e4f70",
  githubAppId: 987654,
  githubSlug: null,
  name: "tenant-read-face",
  privateKeyEnc: "v1.primary.aXZpdi.Y3QmIHRhZw==",
  webhookSecretEnc: "v1.primary.aXZpdi.d2ViaG9vaw==",
  createdBy: "octocat",
  workspaceId: "default",
  maxApps: null,
};

async function seedApp(db: D1Like, overrides: Partial<CreateAppInput> = {}): Promise<GithubAppRow> {
  return createReviewBotsStore(db).createApp({ ...APP_INPUT, id: crypto.randomUUID(), ...overrides });
}

/** One App mapped to the 'default' workspace, one orphan App with no mapping. */
async function seedMappedAndOrphan() {
  const db = createMigratedTestD1();
  const mapped = await seedApp(db, { githubAppId: 1 });
  const orphan = await seedApp(db, { githubAppId: 2 });
  db.raw.prepare(`DELETE FROM bot_workspaces WHERE bot_id = ?`).run(orphan.id);
  return { db, mapped, orphan };
}

describe("apps-store tenant read face", () => {
  test("listApps returns only mapped Apps, each carrying workspace_id", async () => {
    const { db, mapped } = await seedMappedAndOrphan();
    const rows = await createReviewBotsStore(db).listApps();
    expect(rows.map((r) => r.id)).toEqual([mapped.id]);
    expect(rows[0]!.workspace_id).toBe("default");
  });

  test("an orphan App is null from getAppById, getAppForWebhook and getAppByGithubId", async () => {
    const { db, mapped, orphan } = await seedMappedAndOrphan();
    const store = createReviewBotsStore(db);
    expect((await store.getAppById(mapped.id))?.workspace_id).toBe("default");
    expect(await store.getAppById(orphan.id)).toBeNull();
    expect((await store.getAppForWebhook("default", mapped.id))?.workspace_id).toBe("default");
    expect(await store.getAppForWebhook("default", orphan.id)).toBeNull();
    expect((await store.getAppByGithubId(1))?.workspace_id).toBe("default");
    expect(await store.getAppByGithubId(2)).toBeNull();
  });
});

describe("apps-store read SQL joins the tenant", () => {
  test("APP_READ_SQL joins bot_workspaces and selects workspace_id", () => {
    for (const sql of Object.values(APP_READ_SQL)) {
      expect(sql).toContain("INNER JOIN bot_workspaces");
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

const DIRECT_READ = /(?:from|join)\s+review_bots\b/;
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

/** Every `.prepare(…)` statement that reads `review_bots`, with its SQL. */
function readSites(src: string): { line: number; sql: string }[] {
  return prepareStatements(src).filter((s) => DIRECT_READ.test(s.sql));
}

/**
 * The statement's selected columns: from its first `select` to the `from` that
 * closes the projection at paren depth 0. A subquery in the projection list
 * carries its own `from`, so depth — not the first `from` anywhere — decides
 * where the outer projection ends. A column name in a JOIN predicate is a
 * filter on another table's row, not a tenant-facing field of the read, so only
 * the projection is scanned.
 */
function projection(sql: string): string {
  const start = sql.search(/\bselect\b/i);
  let depth = 0;
  for (let i = start; i >= 0 && i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^from\b/i.test(sql.slice(i, i + 4)) && !/\w/.test(sql[i - 1] ?? "")) {
      return sql.slice(start, i);
    }
  }
  return start < 0 ? sql : sql.slice(start);
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

/** The maintenance face: every direct `review_bots` read outside apps-store. */
const MAINTENANCE_SITES: Record<string, number> = {
  // The replay lane resolves a failure's live target/bot/workspace for both callers
  // (the operator route and the internal sweep retry); it is a maintenance read,
  // never a tenant read.
  "admin/maintenance-replay.ts": 1,
  "worker/lifecycle-reconcile.ts": 1,
  "worker/check-reconcile.ts": 3,
  "pipeline/review-threads.ts": 1,
  "store/review-checks.ts": 1,
};

/**
 * A direct read that is NOT a maintenance bypass: the statement carries the
 * workspace predicate itself, so it is a tenant read and may select the
 * tenant-facing columns a maintenance read may not.
 */
const TENANT_DIRECT_SITES: Record<string, number> = {
  "dashboard/targets-store.ts": 1,
};

describe("tenant read face allowlist", () => {
  test("tenant-facing modules hold no direct review_bots read", () => {
    for (const rel of ["dashboard/index.ts", "dashboard/views.ts", "pipeline/consumer.ts"]) {
      const src = readFileSync(join(SRC_DIR, rel), "utf8");
      expect({ file: rel, sites: readSites(src) }).toEqual({ file: rel, sites: [] });
    }
  });

  test("only apps-store plus the declared maintenance files read review_bots", () => {
    expect(directReadFiles()).toEqual(
      ["dashboard/apps-store.ts", ...Object.keys(MAINTENANCE_SITES), ...Object.keys(TENANT_DIRECT_SITES)].sort(),
    );
  });

  test("direct-read files hold exactly their pinned number of reads", () => {
    const counts = Object.fromEntries(
      [...Object.keys(MAINTENANCE_SITES), ...Object.keys(TENANT_DIRECT_SITES)]
        .sort()
        .map((rel) => [rel, readSites(readFileSync(join(SRC_DIR, rel), "utf8")).length]),
    );
    expect(counts).toEqual({ ...MAINTENANCE_SITES, ...TENANT_DIRECT_SITES });
  });

  /**
   * The workspace predicate is what makes a direct read tenant-scoped, so the
   * tenant classification is checked rather than assumed: a read that loses its
   * predicate would be a maintenance bypass in disguise.
   */
  test("a tenant direct read carries the workspace predicate", () => {
    for (const rel of Object.keys(TENANT_DIRECT_SITES)) {
      for (const site of readSites(readFileSync(join(SRC_DIR, rel), "utf8"))) {
        expect({ file: rel, line: site.line + 1, scoped: /\bworkspace_id\b/i.test(site.sql) }).toEqual({
          file: rel,
          line: site.line + 1,
          scoped: true,
        });
      }
    }
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
   * Migration 0036 replaced it with `github_slug` (0038 later dropped the
   * local route key outright); the cached slug stays off a maintenance read
   * exactly as `slug` did.
   * Every maintenance read of `review_bots` must stay off the identity/ownership
   * columns (`private_key_enc` is frozen plan-scope maintenance credential
   * routing, not a response field). The scan is the read's own statement, not
   * every statement in the file: a mixed file (a store that also serves tenant
   * faces of `review_targets`) selects those columns for its own rows. Within
   * the statement only the projection is scanned: a column named in a JOIN
   * predicate filters another table's row and is never returned, so it is not a
   * tenant-facing field of the read.
   */
  test("a maintenance read selects no identity or ownership column", () => {
    const TENANT_FACING = /\b(?:github_slug|name|workspace_id)\b/i;
    for (const rel of Object.keys(MAINTENANCE_SITES)) {
      for (const site of readSites(readFileSync(join(SRC_DIR, rel), "utf8"))) {
        expect({ file: rel, line: site.line + 1, tenantFacing: TENANT_FACING.test(projection(site.sql)) }).toEqual({
          file: rel,
          line: site.line + 1,
          tenantFacing: false,
        });
      }
    }
  });

  /**
   * The projection ends at the outer `from` only: a subquery in the select list
   * carries its own `from` and must not end the scan early, or a tenant-facing
   * column after it would escape the guard above.
   */
  test("the projection scan crosses a subquery in the select list", () => {
    const sql = "select (select 1 from workspaces limit 1), b.name from review_bots b";
    expect(projection(sql)).toContain("b.name");
    expect(projection(sql)).not.toContain("review_bots");
    // The JOIN side still stays out: only the returned columns are scanned.
    const joined = "select t.id from review_targets t join review_bots b on b.id = t.bot_id and b.name = t.name";
    expect(projection(joined)).not.toContain("b.name");
  });
});
