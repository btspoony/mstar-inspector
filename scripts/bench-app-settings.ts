import { gzipSync } from "node:zlib";
import worker from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { createReviewBotsStore } from "../src/dashboard/apps-store";
import { createAppConfigStore } from "../src/dashboard/app-config-store";
import { createSecretbox } from "../src/dashboard/secretbox";
import { createUser } from "../src/dashboard/users";
import { SESSION_COOKIE, createSessionValue } from "../src/dashboard/session";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget } from "../tests/store/helpers";
import type { D1Like, D1StatementLike } from "../src/store/types";

// note: Usage: bun scripts/bench-app-settings.ts [delay-ms=15] [optional-catalog-path]
const delayMs = Number(process.argv[2] ?? 15);
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delay-ms must be nonnegative");
const catalogPath = process.argv[3];
const sessionSecret = "benchmark-only-session-secret-not-a-real-secret";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const db = createMigratedTestD1();
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("Unexpected outbound request: fixture metadata must remain fresh");
}) as unknown as typeof fetch;

let calls = 0;
let latency = 0;
async function bindingCall<T>(operation: () => Promise<T>): Promise<T> {
  calls++;
  if (latency > 0) await Bun.sleep(latency);
  return operation();
}
const originals = new WeakMap<D1StatementLike, D1StatementLike>();
function wrap(statement: D1StatementLike): D1StatementLike {
  const proxy = new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...args: unknown[]) => wrap(Reflect.apply(target.bind, target, args));
      const value = Reflect.get(target, property);
      if (["first", "all", "run", "raw"].includes(String(property))) {
        return (...args: unknown[]) => bindingCall(async () => Reflect.apply(value, target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  originals.set(proxy, statement);
  return proxy;
}
const meteredDb: D1Like = {
  prepare: (sql) => wrap(db.prepare(sql)),
  batch: (statements) => bindingCall(() => db.batch(statements.map((statement) => originals.get(statement) ?? statement))),
};

try {
  await createUser(db, { login: "bench-owner", role: "member" });
  await createUser(db, { login: "bench-member", role: "member" });
  seedDefaultMemberships(db, { "bench-owner": "owner", "bench-member": "member" });
  const appId = "benchmark-app";
  const box = createSecretbox(encryptionKey);
  const apps = createReviewBotsStore(db);
  await apps.createApp({
    id: appId, githubAppId: 1001, githubSlug: "benchmark-app", name: "Benchmark App",
    privateKeyEnc: await box.encryptSecret("fixture-pem", `github_apps.private_key_enc:${appId}`),
    webhookSecretEnc: await box.encryptSecret("fixture-webhook", `github_apps.webhook_secret_enc:${appId}`),
    createdBy: "bench-owner", workspaceId: "default", maxApps: null,
  });
  seedTarget(db, appId, { id: "benchmark-target", name: "benchmark-repo" });
  await apps.saveGithubMetadata(appId, {
    githubName: "Benchmark App", githubDescription: null, githubSlug: "benchmark-app",
    githubHtmlUrl: "https://github.com/apps/benchmark-app", githubAvatarUrl: null,
  });
  const config = createAppConfigStore(db, encryptionKey);
  // F12: bot configuration writes carry the owning workspace's authority.
  const authority = { botId: appId, workspaceId: "default", role: "owner" as const };
  await config.saveVerifiedKey(authority, appId, "anthropic", "fixture-built-in-key", ["fixture-model"]);
  await config.upsertCustomProvider(authority, appId, {
    provider_id: "fixture-custom", base_url: "https://provider.example/v1",
    api: "openai-completions", model_ids: ["custom-model"],
  }, "fixture-custom-key");

  await meteredDb.prepare("SELECT 1").first();
  await meteredDb.prepare("SELECT 1").all();
  await meteredDb.prepare("SELECT 1").run();
  await meteredDb.batch([meteredDb.prepare("SELECT 1"), meteredDb.prepare("SELECT 2")]);
  if (calls !== 4) throw new Error(`D1 meter self-check failed: ${calls} calls, expected 4`);

  const env = {
    DB: meteredDb, DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: sessionSecret, DASHBOARD_ENCRYPTION_KEY: encryptionKey,
    GITHUB_OAUTH_CLIENT_ID: "fixture-client", GITHUB_OAUTH_CLIENT_SECRET: "fixture-secret",
    ASSETS: { fetch: async () => new Response("asset stub", { status: 404 }) },
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
  } as unknown as Env;
  const cookies = new Map<string, string>();
  for (const login of ["bench-owner", "bench-member"]) {
    cookies.set(login, `${SESSION_COOKIE}=${await createSessionValue(login, null, sessionSecret)}`);
  }
  const base = "/dashboard/default/api/apps/1001";
  async function request(path: string, login: string) {
    const response = await worker.fetch(new Request(`https://worker.local${path}`, {
      headers: { Accept: "application/json", Cookie: cookies.get(login)! },
    }), env);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}: ${new TextDecoder().decode(bytes)}`);
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (path.endsWith("/settings") && body.can_manage !== (login === "bench-owner")) {
      throw new Error("Unexpected settings authorization face");
    }
    if (path.endsWith("/models") && !Array.isArray(body.groups)) throw new Error("Missing model groups");
    return bytes;
  }
  const reference = JSON.parse(new TextDecoder().decode(await request(`${base}/settings`, "bench-owner"))) as {
    provider_catalog_version?: string;
  };
  const versionedCatalogPath = catalogPath && reference.provider_catalog_version
    ? `${catalogPath}${catalogPath.includes("?") ? "&" : "?"}v=${encodeURIComponent(reference.provider_catalog_version)}`
    : catalogPath;
  const cases = [
    { name: "owner settings", paths: [`${base}/settings`], login: "bench-owner" },
    { name: "owner /models", paths: [`${base}/models`], login: "bench-owner" },
    { name: "SPA critical path (settings to ready)", paths: [`${base}/settings`], login: "bench-owner" },
    { name: "settings then /models (legacy path)", paths: [`${base}/settings`, `${base}/models`], login: "bench-owner" },
    { name: "member settings", paths: [`${base}/settings`], login: "bench-member" },
    ...(versionedCatalogPath ? [{ name: "catalog (versioned)", paths: [versionedCatalogPath], login: "bench-owner" }] : []),
  ];
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  console.log("App settings benchmark: real worker.fetch, migrated in-memory SQLite D1, SaaS");
  console.log("Fixture: one workspace/App/repository, owner + member, built-in + custom key, fresh metadata");
  console.log(`Warm-up: 1 per case/mode; medians: 7 local, 5 at ${delayMs}ms per D1 call (one per batch)`);
  console.log("Wall time includes response consumption; gzip is computed outside timing, separately per response.");
  console.log("Optional catalog endpoint: " + (catalogPath ? `${catalogPath} (v from settings)` : "not supplied (pass third argument when available)"));
  console.log("| Case | D1 calls local/injected | Local median ms | Injected median ms | Raw bytes | Gzip bytes |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const entry of cases) {
    const modes = [];
    for (const mode of [{ delay: 0, runs: 7 }, { delay: delayMs, runs: 5 }]) {
      latency = mode.delay;
      const times: number[] = [];
      const counts: number[] = [];
      let raw = 0;
      let gzip = 0;
      for (let run = -1; run < mode.runs; run++) {
        calls = 0;
        const bodies: Uint8Array[] = [];
        const start = performance.now();
        for (const path of entry.paths) bodies.push(await request(path, entry.login));
        const elapsed = performance.now() - start;
        if (run < 0) continue;
        times.push(elapsed);
        counts.push(calls);
        raw = bodies.reduce((sum, body) => sum + body.byteLength, 0);
        gzip = bodies.reduce((sum, body) => sum + gzipSync(body).byteLength, 0);
      }
      if (new Set(counts).size !== 1) throw new Error(`Unstable D1 counts for ${entry.name}: ${counts}`);
      modes.push({ ms: median(times), count: counts[0], raw, gzip });
    }
    console.log(`| ${entry.name} | ${modes[0]!.count}/${modes[1]!.count} | ${modes[0]!.ms.toFixed(2)} | ${modes[1]!.ms.toFixed(2)} | ${modes[0]!.raw} | ${modes[0]!.gzip} |`);
  }
  if (networkCalls !== 0) throw new Error(`Unexpected outbound calls: ${networkCalls}`);
  console.log("Checks: D1 meter self-check OK; all responses HTTP 200 with expected authorization/model shape; outbound fetch calls = 0");
} finally {
  globalThis.fetch = originalFetch;
  db.raw.close();
}
