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

async function seedMappedAndOrphan() {
  const db = createMigratedTestD1();
  const mapped = await seedApp(db, { githubAppId: 1 });
  const orphan = await seedApp(db, { githubAppId: 2 });
  db.raw.prepare(`DELETE FROM app_workspaces WHERE app_id = ?`).run(orphan.id);
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
  test("APP_READ_SQL joins app_workspaces and selects workspace_id", () => {
    for (const sql of Object.values(APP_READ_SQL)) {
      expect(sql).toContain("INNER JOIN app_workspaces");
      expect(sql).toContain("w.workspace_id");
    }
  });
});

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

function prepareStatements(src: string): { line: number; sql: string }[] {
  const out: { line: number; sql: string }[] = [];
  const marker = ".prepare";
  let pos = 0;
  let counted = 0;
  let line = 0;
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

function readSites(src: string): { line: number; sql: string }[] {
  return prepareStatements(src).filter((s) => DIRECT_READ.test(s.sql));
}

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

// Post-split truth: every one of these files' review_bots reads moved to
// github_apps (Tasks 3–4 converted the publishing/ops trees); grep finds zero
// remaining references in any of them. The bot table is read by the store
// alone — the allowlist is the proof, not a leftover.
const MAINTENANCE_SITES: Record<string, number> = {};

const TENANT_DIRECT_SITES: Record<string, number> = {};

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

  test("the projection scan crosses a subquery in the select list", () => {
    const sql = "select (select 1 from workspaces limit 1), b.name from review_bots b";
    expect(projection(sql)).toContain("b.name");
    expect(projection(sql)).not.toContain("review_bots");
    const joined = "select t.id from review_targets t join review_bots b on b.id = t.app_id and b.name = t.name";
    expect(projection(joined)).not.toContain("b.name");
  });
});
