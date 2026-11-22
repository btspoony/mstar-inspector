
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { stripJsonComments } from "../../scripts/check-image-inputs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONFIG_PATH = join(REPO_ROOT, "wrangler.jsonc");

const NOT_RESTATED: Record<string, true> = {
  name: true,
  main: true,
  compatibility_date: true,
  compatibility_flags: true,
  keep_vars: true,
  env: true,
};

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function walk(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const config: Json = JSON.parse(stripJsonComments(readFileSync(CONFIG_PATH, "utf8")));
const staging: Json = config;
const production: Json = asObject(asObject(config.env).production);

function leafFingerprints(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${prefix}=${JSON.stringify(value)}`];
  }
  return Object.entries(value as Json).flatMap(([key, child]) =>
    leafFingerprints(child, `${prefix}.${key}`),
  );
}

function bindingNames(block: Json): Record<string, string[]> {
  return {
    "kv_namespaces[].binding": asArray(block.kv_namespaces).map((entry) => String(entry.binding)),
    "d1_databases[].binding": asArray(block.d1_databases).map((entry) => String(entry.binding)),
    "queues.producers[].binding": asArray(asObject(block.queues).producers).map((entry) =>
      String(entry.binding),
    ),
    "durable_objects.bindings[].name": asArray(asObject(block.durable_objects).bindings).map(
      (entry) => String(entry.name),
    ),
    "assets.binding": [String(asObject(block.assets).binding)],
  };
}

function resourceIdentities(block: Json): Record<string, string[]> {
  const consumers = asArray(asObject(block.queues).consumers);
  return {
    "kv_namespaces[].id": asArray(block.kv_namespaces).map((entry) => String(entry.id)),
    "d1_databases[].database_name": asArray(block.d1_databases).map((entry) =>
      String(entry.database_name),
    ),
    "d1_databases[].database_id": asArray(block.d1_databases).map((entry) =>
      String(entry.database_id),
    ),
    "queues.producers[].queue": asArray(asObject(block.queues).producers).map((entry) =>
      String(entry.queue),
    ),
    "queues.consumers[].queue": consumers.map((entry) => String(entry.queue)),
    "queues.consumers[].dead_letter_queue": consumers.map((entry) =>
      String(entry.dead_letter_queue),
    ),
    "containers[].name": asArray(block.containers).map((entry) => String(entry.name)),
  };
}

function migrationFingerprints(block: Json): string[] {
  return asArray(block.migrations).map((entry) =>
    [
      `tag=${String(entry.tag)}`,
      ...["new_sqlite_classes", "deleted_classes"]
        .filter((key) => key in entry)
        .map((key) => `${key}=${asArray(entry[key]).map(String).sort().join(",")}`),
    ].join("|"),
  );
}

function containerFingerprints(block: Json): string[] {
  return asArray(block.containers).map(
    (entry) =>
      `class_name=${String(entry.class_name)}|scheduling_policy=${String(entry.scheduling_policy)}|images=${Object.keys(asObject(entry.images))
        .sort()
        .join(",")}`,
  );
}

function consumerTuningFingerprints(block: Json): string[] {
  return asArray(asObject(block.queues).consumers).map((entry) =>
    [
      `max_batch_size=${String(entry.max_batch_size)}`,
      `max_concurrency=${String(entry.max_concurrency)}`,
      `max_retries=${String(entry.max_retries)}`,
      `dead_letter_queue=${"dead_letter_queue" in entry ? "set" : "none"}`,
    ].join("|"),
  );
}

function expectSameSet(kind: string, values: (block: Json) => string[]): void {
  expect(
    new Set(values(production)),
    `wrangler.jsonc: ${kind} differs between the top level (staging) and env.production; a ` +
      `restatement with nothing to compare against would pass vacuously`,
  ).toEqual(new Set(values(staging)));
}

function routePatternMatches(pattern: string, hostAndPath: string): boolean {
  const literal = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${literal}$`).test(hostAndPath);
}

const WORKER_ENTRY_PATHS = [
  "/dashboard",
  "/dashboard/login",
  "/dashboard/oauth/callback",
  "/_internal_admin",
  "/_internal_admin/api/runtime",
  "/healthz",
  "/app-assets/main-abc.js",
  "/webhook/ws-id/app-id",
] as const;

describe("wrangler env.production parity (PR #63 should-fix)", () => {
  test("env.production exists and every restatable top-level resource key is restated", () => {
    expect(Object.keys(production).length, `wrangler.jsonc: env.production is missing`).toBeGreaterThan(0);

    const expected = Object.keys(config).filter((key) => NOT_RESTATED[key] !== true);
    expect(expected.length, "wrangler.jsonc: no restatable top-level keys found").toBeGreaterThan(0);

    const missing = expected.filter((key) => !(key in production));
    expect(
      missing,
      `wrangler.jsonc: env.production does not restate top-level key(s); a named environment ` +
        `does not inherit resource keys, so staging would drift from production`,
    ).toEqual([]);
  });

  test("binding NAMES match between the top level and env.production", () => {
    for (const [kind, stagingNames] of Object.entries(bindingNames(staging))) {
      expect(bindingNames(production)[kind], `wrangler.jsonc: binding names differ for ${kind}`).toEqual(
        stagingNames,
      );
    }
  });

  test("env.production points at distinct resources from the top-level (staging) block", () => {
    for (const [kind, stagingValues] of Object.entries(resourceIdentities(staging))) {
      const stagingSet = new Set(stagingValues);
      const shared = (resourceIdentities(production)[kind] ?? []).filter((value) =>
        stagingSet.has(value),
      );
      expect(
        shared,
        `wrangler.jsonc: env.production shares ${kind} with the staging block (a copy-paste ` +
          `left a staging resource behind)`,
      ).toEqual([]);
    }
  });

  test("env.production.name is the production Worker, distinct from the staging name", () => {
    expect(production.name, `wrangler.jsonc: env.production.name must be pinned`).toBe(
      "mstar-inspector-production",
    );
    expect(
      production.name,
      `wrangler.jsonc: env.production.name must differ from the top-level staging worker ` +
        `(re-pointing it would deploy the staging Worker at prod bindings)`,
    ).not.toBe(staging.name);
  });

  test("triggers.crons match between the top level and env.production", () => {
    expectSameSet("triggers.crons", (block) => asArray(asObject(block.triggers).crons).map(String));
  });

  test("migrations (tag + class lists) match between the top level and env.production", () => {
    expectSameSet("migrations", migrationFingerprints);
  });

  test("queues.consumers[] tuning (batch size, concurrency, retries, DLQ presence) matches between the top level and env.production", () => {
    expectSameSet("queues.consumers[] tuning", consumerTuningFingerprints);
  });

  test("both consumer blocks pin max_concurrency to 250 and max_batch_size to 1", () => {
    for (const [block, consumer] of [
      ["top level (staging)", asArray(asObject(staging.queues).consumers)[0]],
      ["env.production", asArray(asObject(production.queues).consumers)[0]],
    ] as [string, Json | undefined][]) {
      if (!consumer) throw new Error(`wrangler.jsonc: ${block} consumer entry is missing`);
      expect(consumer.max_concurrency, `wrangler.jsonc: ${block} max_concurrency ceiling`).toBe(250);
      expect(consumer.max_batch_size, `wrangler.jsonc: ${block} max_batch_size`).toBe(1);
    }
  });

  test("containers (class_name + scheduling_policy + images keys) match between the top level and env.production", () => {
    expectSameSet("containers[]", containerFingerprints);
  });

  test("assets (directory, binding, run_worker_first) match between the top level and env.production", () => {
    expectSameSet("assets", (block) => leafFingerprints(asObject(block.assets), "assets"));
  });

  test("observability (top-level flags, logs/traces sub-toggles) match between the top level and env.production", () => {
    expectSameSet("observability", (block) =>
      leafFingerprints(asObject(block.observability), "observability"),
    );
  });

  test("env.production resolves to the prod-only resources and routes", () => {
    const d1 = asArray(production.d1_databases)[0] ?? {};
    expect(d1.database_name, `wrangler.jsonc: prod D1 database name`).toBe(
      "mstar-inspector-prod-db",
    );

    expect(
      asArray(asObject(production.queues).producers).map((entry) => String(entry.queue)),
      `wrangler.jsonc: prod queue names`,
    ).toEqual(["review-queue-prod"]);
    expect(
      asArray(asObject(production.queues).consumers).map((entry) => String(entry.queue)),
      `wrangler.jsonc: prod consumer queue names`,
    ).toEqual(["review-queue-prod"]);
    expect(
      asArray(asObject(production.queues).consumers).map((entry) =>
        String(entry.dead_letter_queue),
      ),
      `wrangler.jsonc: prod dead-letter queue`,
    ).toEqual(["review-dlq-prod"]);

    const routes = asArray(production.routes);
    expect(
      routes.filter((entry) => entry.zone_name !== "mstar.page" || "custom_domain" in entry),
      `wrangler.jsonc: prod routes are Workers Routes on the mstar.page zone — a Custom Domain ` +
        `would claim the whole hostname the marketing Worker needs`,
    ).toEqual([]);
  });

  test("every entry URL this Worker serves is matched by a production route", () => {
    const patterns = asArray(production.routes).map((entry) => String(entry.pattern));
    expect(patterns.length, `wrangler.jsonc: prod declares no routes`).toBeGreaterThan(0);
    expect(
      WORKER_ENTRY_PATHS.filter(
        (path) =>
          !patterns.some((pattern) => routePatternMatches(pattern, `inspector.mstar.page${path}`)),
      ),
      `wrangler.jsonc: these entry URLs match no production route, so the marketing Worker answers them`,
    ).toEqual([]);
  });

  test("DEPLOYMENT_MODE: both deploy workflows pass --var, and each config block declares a value", () => {
    for (const name of ["deploy.yml", "deploy-prod.yml"]) {
      const text = readFileSync(join(REPO_ROOT, ".github", "workflows", name), "utf8");
      expect(text, `${name}: deploy command does not pass the deployment shape`).toContain(
        '--var "DEPLOYMENT_MODE:saas"',
      );
    }
    expect(asObject(production.vars).DEPLOYMENT_MODE).toBe("saas");
  });

  test("DEPLOYMENT_MODE: the top-level vars declares the local self-hosted shape", () => {
    expect(
      asObject(staging.vars).DEPLOYMENT_MODE,
      `wrangler.jsonc: top-level vars must declare the local deployment shape`,
    ).toBe("self-hosted");
    expect([asObject(staging.vars).DEPLOYMENT_MODE, asObject(production.vars).DEPLOYMENT_MODE]).toEqual([
      "self-hosted",
      "saas",
    ]);
  });

  test("env.production.vars carries exactly the deployment shape", () => {
    expect(Object.keys(asObject(production.vars)).sort()).toEqual(["DEPLOYMENT_MODE"]);
  });
});

describe("no deployment allowlist survives", () => {
  const RETIRED_VAR = ["ADMIN", "LOGINS"].join("_");

  const SCANNED_ROOTS = ["src", "tests", "docs"] as const;
  const SCANNED_FILES = [
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-prod.yml",
    "wrangler.jsonc",
    ".env.example",
    "README.md",
    "README_CN.md",
  ] as const;

  test(`${RETIRED_VAR} has zero references in src/, tests/, docs/, the workflows and the deploy config`, () => {
    const files = [...SCANNED_ROOTS.flatMap(walk), ...SCANNED_FILES];
    const offenders = files.filter((path) =>
      readFileSync(join(REPO_ROOT, path), "utf8").includes(RETIRED_VAR),
    );
    expect(
      offenders,
      `${RETIRED_VAR} is retired: sign-in is unconditional, so nothing may still read or document an allowlist`,
    ).toEqual([]);
  });
});

describe("no deployment-wide review brake survives", () => {
  const RETIRED_VAR = ["REVIEW", "ENABLED"].join("_");

  const SCANNED_ROOTS = [
    "src",
    "scripts",
    "tests",
    "docs",
    ".github",
    "docs/specs",
    ".agents/knowledge",
    ".agents/adr",
  ] as const;
  const SCANNED_FILES = [
    "wrangler.jsonc",
    ".env.example",
    "README.md",
    "README_CN.md",
  ] as const;

  test(`${RETIRED_VAR} has zero references in src/, scripts/, tests/, docs/, .github/ and the deploy config`, () => {
    const files = [...SCANNED_ROOTS.flatMap(walk), ...SCANNED_FILES];
    const offenders = files.filter((path) =>
      readFileSync(join(REPO_ROOT, path), "utf8").includes(RETIRED_VAR),
    );
    expect(
      offenders,
      `${RETIRED_VAR} is retired: per-App review_enabled is the only control, so no code, test or doc may name a deployment-level brake`,
    ).toEqual([]);
  });
});

describe("no tenant read mode survives", () => {
  const RETIRED_VAR = ["WORKSPACE", "TENANT", "MODE"].join("_");

  const SCANNED_ROOTS = ["src", "scripts", "tests", "docs"] as const;
  const SCANNED_FILES = [
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-prod.yml",
    "wrangler.jsonc",
  ] as const;

  test(`${RETIRED_VAR} has zero references in src/, scripts/, tests/, docs/, the workflows and the deploy config`, () => {
    const files = [...SCANNED_ROOTS.flatMap(walk), ...SCANNED_FILES];
    const offenders = files.filter((path) =>
      readFileSync(join(REPO_ROOT, path), "utf8").includes(RETIRED_VAR),
    );
    expect(
      offenders,
      `${RETIRED_VAR} is retired: tenant reads are unconditional, so no workflow may pass it and no script, test or doc may read it`,
    ).toEqual([]);
  });
});

describe("no local process ids in tracked content", () => {
  const SCANNED_ROOTS = ["src", "tests", "scripts", "docs", "migrations", ".github", ".changes"] as const;
  const SCANNED_FILES = ["wrangler.jsonc", "wrangler.smoke.jsonc", ".env.example", "README.md", "README_CN.md"] as const;

  const PLAN = ["pl", "an"].join("");
  const ITER = ["it", "er"].join("");
  const DOT_MSTAR = [".mstar", "/"].join("");
  const PLAN_SUBDIR = ["pl", "ans"].join("");

  const BANNED: Array<[label: string, source: string, sample: string]> = [
    ["plan id", `\\b${PLAN}[ _-]?\\d{2,}\\b`, `see ${PLAN} 100 for why`],
    ["iteration id", `\\b${ITER}(?:ation)?[ _-]?\\d{2,}\\b`, `closed in ${ITER} 042`],
    ["iteration slug", `${ITER}ation-v\\d`, `closed at ${ITER}ation-v1.3`],
    [
      "process path",
      `\\${DOT_MSTAR}(?:${PLAN_SUBDIR}|sdd|iterations|workflows)\\b`,
      `see ${DOT_MSTAR}${PLAN_SUBDIR}/x.md`,
    ],
  ];

  test("no tracked file names a local plan, iteration or process path", () => {
    const rules = BANNED.map(([label, source, sample]) => ({ label, pattern: new RegExp(source, "i"), sample }));
    for (const { label, pattern, sample } of rules) {
      expect(pattern.test(sample), `${label} pattern matches nothing — it cannot guard anything`).toBe(true);
    }
    const files = [...SCANNED_ROOTS.flatMap(walk), ...SCANNED_FILES];
    const offenders = files.flatMap((path) => {
      const lines = readFileSync(join(REPO_ROOT, path), "utf8").split("\n");
      return lines.flatMap((line, index) =>
        rules
          .filter(({ pattern }) => pattern.test(line))
          .map(({ label }) => `${path}:${index + 1} [${label}] ${line.trim().slice(0, 120)}`),
      );
    });
    expect(
      offenders,
      "a local plan/iteration id cannot be resolved from the repository (that state is gitignored " +
        "under .mstar/): write what it is plus a date instead",
    ).toEqual([]);
  });
});
