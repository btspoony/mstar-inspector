/**
 * Entry visibility for the platform console (plan 116 Task 7, spec §5).
 *
 * The boot carries ONE server-derived boolean: allowlist membership AND the
 * `saas` deployment shape. The shell reads that field only — a `self-hosted`
 * deployment mounts no console, so even a listed login gets no entry.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { SpaBoot } from "../../src/spa/boot";
import { buildSidebarModel } from "../../src/spa/shell";
import { createMigratedTestD1 } from "../store/helpers";
import { htmlGetRequest, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const LOGIN = "operator";
const PAGE = "/dashboard/default/apps";

/** Read the injected boot out of a shell document. */
function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no boot in shell");
  return JSON.parse(json) as SpaBoot;
}

/** The served shell's boot for `LOGIN` in `mode`, with `operators` as the allowlist. */
async function bootFor(mode: "saas" | "self-hosted", operators: string): Promise<SpaBoot> {
  const db = createMigratedTestD1();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), LOGIN, new Date().toISOString());
  const env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: mode,
    PLATFORM_OPERATORS: operators,
    DB: db,
  } as unknown as Env;
  const session = await createSessionValue(LOGIN, null, SESSION_SECRET);
  const res = await worker.fetch(
    htmlGetRequest(PAGE, { Cookie: `${SESSION_COOKIE}=${session}` }),
    withSpaAssets(env),
  );
  expect(res.status).toBe(200);
  return bootOf(await res.text());
}

describe("platform-operations entry", () => {
  test("an operator on a saas deployment sees the sidebar footer link", async () => {
    const boot = await bootFor("saas", LOGIN);
    expect(boot.isOperator).toBe(true);
    expect(buildSidebarModel(boot, PAGE).operatorLink).toEqual({
      href: "/_internal_admin",
      label: "Platform operations",
    });
  });

  test("a non-operator on a saas deployment sees no link", async () => {
    const boot = await bootFor("saas", "someone-else");
    expect(boot.isOperator).toBe(false);
    expect(buildSidebarModel(boot, PAGE).operatorLink).toBeUndefined();
  });

  test("an allowlisted login on a self-hosted deployment sees no link", async () => {
    const boot = await bootFor("self-hosted", LOGIN);
    expect(boot.isOperator).toBe(false);
    expect(buildSidebarModel(boot, PAGE).operatorLink).toBeUndefined();
  });
});
