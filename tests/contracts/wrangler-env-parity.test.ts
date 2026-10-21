/**
 * `env.production` ↔ top-level resource parity lock (PR #63 review, should-fix:
 * "`env.production` is hand-duplicated with no parity guard").
 *
 * A wrangler named environment does NOT inherit resource keys — only
 * name/main/compatibility_* flow down — so `wrangler.jsonc`'s `env.production`
 * restates every binding/trigger/migration by hand against prod-only
 * resources. Until now the only machine guard was the sandbox-image contract
 * test, which pins just the container `dockerfile`/`build_context` values
 * (that ownership stays there; this file never re-pins them). A binding, cron
 * or migration added at the top level would deploy fine to staging and be
 * silently missing in production, where the smoke asserts only healthz, the
 * cron string and the image digest — the drift would surface as a production
 * runtime failure.
 *
 * The expected key list is DERIVED from the top level (minus the fields
 * wrangler inherits or rejects inside an env block), so a future top-level
 * resource key fails this lock loudly instead of being ignored.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONFIG_PATH = join(REPO_ROOT, "wrangler.jsonc");

/**
 * Top-level keys a named environment must NOT restate: name/main/compatibility_*
 * are inherited by wrangler, `keep_vars` is rejected inside an env block
 * (wrangler 4.147.0: `Unexpected fields found in env.production field`), and
 * `env` is the environments container itself.
 */
const NOT_RESTATED: Record<string, true> = {
  name: true,
  main: true,
  compatibility_date: true,
  compatibility_flags: true,
  keep_vars: true,
  env: true,
};

type Json = Record<string, unknown>;

/**
 * Strip JSONC comments before JSON.parse — no dependency. A scanner (not a
 * regex) so a `//` inside a string value is never mistaken for a comment.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

const config: Json = JSON.parse(stripJsonComments(readFileSync(CONFIG_PATH, "utf8")));
const staging: Json = config;
const production: Json = asObject(asObject(config.env).production);

/**
 * Leaf fingerprint of a nested block as `key.path=value` strings, so a
 * one-sided change to any depth (e.g. `observability.traces.head_sampling_rate`
 * or `assets.directory`) shows up as a differing key path instead of passing
 * silently. Arrays are opaque leaves — nothing here restates one.
 */
function leafFingerprints(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${prefix}=${JSON.stringify(value)}`];
  }
  return Object.entries(value as Json).flatMap(([key, child]) =>
    leafFingerprints(child, `${prefix}.${key}`),
  );
}

/** Binding NAMES each block declares, per binding kind. */
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

/** Backing-resource identities each block points at, per resource kind. */
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

/**
 * Fingerprint of one `migrations[]` entry: its `tag` plus whichever class
 * lists it carries (`new_sqlite_classes` / `deleted_classes`). A staging-only
 * `v3` tag or class addition changes a fingerprint, so the set-equality below
 * fails instead of shipping a production Worker that replays a different
 * migration history.
 */
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

/**
 * Fingerprint of one `containers[]` entry: its `class_name`, its
 * `scheduling_policy` and the image keys it declares. The scheduling policy is
 * pinned here because a container application canNOT change it in place
 * (Sandbox 1.0 migration), so a staging-only change would deploy a production
 * Worker whose DO namespace shape no longer matches. The image
 * `dockerfile`/`build_context` VALUES stay owned by `sandbox-images.test.ts`;
 * only the shape is locked here.
 */
function containerFingerprints(block: Json): string[] {
  return asArray(block.containers).map(
    (entry) =>
      `class_name=${String(entry.class_name)}|scheduling_policy=${String(entry.scheduling_policy)}|images=${Object.keys(asObject(entry.images))
        .sort()
        .join(",")}`,
  );
}

/**
 * Fingerprint of the protective tuning each `queues.consumers[]` entry
 * declares. `dead_letter_queue` enters as PRESENCE, never as a value: staging
 * and production each point at their OWN DLQ (`review-dlq` vs
 * `review-dlq-prod` — their distinctness is asserted above), but a consumer
 * that declares no DLQ at all, or drops its retry batch bounds, is exactly the
 * drift this lock catches. Both consumers are pinned at max_batch_size 1,
 * max_concurrency 1 and max_retries 3 (see the wrangler.jsonc rationale).
 */
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

/** Set-equality between the two blocks for one projection (order-irrelevant). */
function expectSameSet(kind: string, values: (block: Json) => string[]): void {
  expect(
    new Set(values(production)),
    `wrangler.jsonc: ${kind} differs between the top level (staging) and env.production; a ` +
      `restatement with nothing to compare against would pass vacuously`,
  ).toEqual(new Set(values(staging)));
}

describe("wrangler env.production parity (PR #63 should-fix)", () => {
  test("env.production exists and every restatable top-level resource key is restated", () => {
    expect(Object.keys(production).length, `wrangler.jsonc: env.production is missing`).toBeGreaterThan(0);

    const expected = Object.keys(config).filter((key) => NOT_RESTATED[key] !== true);
    // A restatement with nothing to compare against would pass vacuously.
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

  /**
   * The prod Worker name is a named environment's ONLY non-inherited identity
   * key wrangler honours, and every resource name derives from it (the
   * container application name is `<worker>-<class>-<image key>`). `name` sits
   * in `NOT_RESTATED` because wrangler inherits it — so without this pin a
   * deleted/mistyped value would silently redeploy the STAGING Worker against
   * prod D1/KV/queues, orphaning the container application, before the
   * post-deploy healthz smoke notices.
   */
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

  /** A cron added/removed at the top level would ship silently (the prod smoke
   * greps only the literal schedule). */
  test("triggers.crons match between the top level and env.production", () => {
    expectSameSet("triggers.crons", (block) => asArray(asObject(block.triggers).crons).map(String));
  });

  /** A staging-only `v3` tag or class addition changes the replayed history;
   * every restatable block must restate it identically. */
  test("migrations (tag + class lists) match between the top level and env.production", () => {
    expectSameSet("migrations", migrationFingerprints);
  });

  /** The consumer tuning is the protective fix (max_concurrency 1 against
   * `max_instances: 1`): a staging-only loosening would silently open a retry
   * storm → DLQ path in production. */
  test("queues.consumers[] tuning (batch size, concurrency, retries, DLQ presence) matches between the top level and env.production", () => {
    expectSameSet("queues.consumers[] tuning", consumerTuningFingerprints);
  });

  /** A second/unregistered container entry must fail the lock, not hide behind
   * the first. Image values stay owned by `sandbox-images.test.ts`. */
  test("containers (class_name + scheduling_policy + images keys) match between the top level and env.production", () => {
    expectSameSet("containers[]", containerFingerprints);
  });

  /** The lock previously compared `assets` by `binding` only: a staging-only
   * `directory` or `run_worker_first` change would ship silently. Fingerprints
   * carry the `assets.<key>` path, so the failure names the differing key. */
  test("assets (directory, binding, run_worker_first) match between the top level and env.production", () => {
    expectSameSet("assets", (block) => leafFingerprints(asObject(block.assets), "assets"));
  });

  /** Nothing read `observability` before: the legacy top-level `enabled` plus
   * the `logs`/`traces` sub-toggles (their enabled flags, sampling rates and
   * persist) were only guarded by hand. A one-sided sub-toggle change would
   * silently alter prod log/trace volume; fingerprints carry the full
   * `observability.<sub>.<key>` path. */
  test("observability (top-level flags, logs/traces sub-toggles) match between the top level and env.production", () => {
    expectSameSet("observability", (block) =>
      leafFingerprints(asObject(block.observability), "observability"),
    );
  });

  /** The prod-only resources `wrangler deploy --env production` resolves to.
   * Pinned here (once) so a copy-paste staging value fails loudly; the smoke
   * workflow's own literal grep is a different artifact. */
  test("env.production resolves to the prod-only resources and route", () => {
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
      routes.map((entry) => String(entry.pattern)),
      `wrangler.jsonc: prod route host`,
    ).toEqual(["inspector.mstar.page"]);
    expect(
      routes.map((entry) => entry.custom_domain),
      `wrangler.jsonc: prod route must be a Custom Domain`,
    ).toEqual([true]);
  });

  /**
   * `WORKSPACE_TENANT_MODE` (migration 0026) is the tenant route/read switch.
   * It rides `--var` on BOTH deploy commands, so the artifact and the mode stay
   * independent: the same SHA is deployed `off` (Deploy A) and replayed
   * `strict` (Deploy B). A workflow that lost the `--var` would fall back to the
   * config default and ship a different mode than its run says.
   */
  test("WORKSPACE_TENANT_MODE: both deploy workflows pass --var, and prod config carries the default", () => {
    for (const name of ["deploy.yml", "deploy-prod.yml"]) {
      const text = readFileSync(join(REPO_ROOT, ".github", "workflows", name), "utf8");
      expect(text, `${name}: tenant_mode dispatch input is missing`).toMatch(/\n\s+tenant_mode:\n/);
      expect(text, `${name}: deploy command does not pass the tenant mode`).toContain(
        '--var "WORKSPACE_TENANT_MODE:$TENANT_MODE"',
      );
    }
    expect(asObject(production.vars).WORKSPACE_TENANT_MODE).toBe("off");
  });
});
