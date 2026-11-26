import assert from "node:assert/strict";
import type { D1Like, D1StatementLike } from "../src/store/types";
import { createSessionValue, SESSION_COOKIE } from "../src/dashboard/session";
import { setMaintenanceMode } from "../src/dashboard/runtime-config-store";
import worker from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { withSpaAssets } from "../tests/helpers/spa";
import { createMigratedTestD1 } from "../tests/store/helpers";

const db = createMigratedTestD1();
const now = new Date().toISOString();
db.raw.prepare("INSERT INTO users (id, github_login, role, created_at) VALUES ('u', 'bench', 'member', ?)").run(now);
db.raw.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', 'u', 'owner', ?)").run(now);
db.raw.prepare(
  `INSERT INTO github_apps (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status, created_at, updated_at)
   VALUES ('bench-bot', 1, 'bench-bot', 'enc', 'enc', 'bench', 'active', ?, ?)`,
).run(now, now);
db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('bench-bot', 'default')").run();
db.raw.prepare(
  `INSERT INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
   VALUES ('bench-bot', 'default', 'bench-bot', 1, ?, ?)`,
).run(now, now);
db.raw.prepare(
  `INSERT INTO review_targets
     (id, workspace_id, app_id, name, repo_id, repo_owner, repo_name, review_trigger_mode, created_by, created_at, updated_at)
   VALUES ('bench-target', 'default', 'bench-bot', 'Fixture repo', 1, 'bench', 'repo', 'every_push', 'bench', ?, ?)`,
).run(now, now);
const sessionSecret = "local-dashboard-benchmark-only";
const cookie = `${SESSION_COOKIE}=${await createSessionValue("bench", null, sessionSecret)}`;

let delayMs = 0;
let calls = 0;
async function measureCall<T>(call: () => Promise<T>): Promise<T> {
  calls++;
  if (delayMs) await Bun.sleep(delayMs);
  return call();
}
function wrap(statement: D1StatementLike): D1StatementLike {
  return {
    bind: (...values) => wrap(statement.bind(...values)),
    first: <T>() => measureCall(() => statement.first<T>()),
    all: <T>() => measureCall(() => statement.all<T>()),
    run: <T>() => measureCall(() => statement.run<T>()),
  };
}
const instrumented: D1Like = {
  prepare: (sql) => wrap(db.prepare(sql)),
  batch: () => { throw new Error("unexpected batch in the read-only benchmark"); },
};
const env = withSpaAssets({
  DB: instrumented as unknown as Env["DB"],
  DEPLOYMENT_MODE: "saas",
  DASHBOARD_SESSION_SECRET: sessionSecret,
  GITHUB_OAUTH_CLIENT_ID: "local-benchmark",
  GITHUB_OAUTH_CLIENT_SECRET: "local-benchmark-only",
} satisfies Partial<Env>) as Env;

function percentile(sorted: number[], q: number): string {
  return sorted[Math.ceil(sorted.length * q) - 1]!.toFixed(2);
}

async function bench(
  name: string,
  path: string,
  status: number,
  bodyIncludes: string,
  headers?: Record<string, string>,
): Promise<void> {
  for (delayMs of [0, 15]) {
    const samples: number[] = [];
    const d1Calls = new Set<number>();
    const warmup = 5;
    const iterations = 40;
    for (let i = 0; i < warmup + iterations; i++) {
      const request = new Request(`https://worker.local${path}`, { headers });
      calls = 0;
      const start = performance.now();
      const response = await worker.fetch(request, env);
      const body = await response.text();
      const ms = performance.now() - start;
      assert.equal(response.status, status, name);
      assert.ok(body.includes(bodyIncludes), name);
      if (i >= warmup) {
        samples.push(ms);
        d1Calls.add(calls);
      }
    }
    samples.sort((a, b) => a - b);
    console.log(`| ${name} | ${delayMs} | ${[...d1Calls].join(", ")} | ${percentile(samples, 0.5)} | ${percentile(samples, 0.95)} |`);
  }
}

console.log("| Scenario | Delay per D1 call (ms) | D1 calls | p50 (ms) | p95 (ms) |");
console.log("| --- | ---: | ---: | ---: | ---: |");
const api = "/dashboard/default/api/targets";
await bench("SaaS repository list", api, 200, "bench-target", { Cookie: cookie, Accept: "application/json" });
await bench("SaaS repository HTML", "/dashboard/default/repos", 200, "window.__BOOT__", { Cookie: cookie, Accept: "text/html" });
await bench("Anonymous repository API", api, 302, "");
await bench("Public health", "/healthz", 200, '"ok":true');
await setMaintenanceMode(db, { enabled: true, reason: "Fixture maintenance", actor: "bench" }, now);
await bench("Closed maintenance", api, 503, '"maintenance":true', { Cookie: cookie, Accept: "application/json" });
db.raw.close();
