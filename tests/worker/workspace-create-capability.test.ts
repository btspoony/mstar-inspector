import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { SpaBoot } from "../../src/spa/boot";
import { createMigratedTestD1 } from "../store/helpers";
import { htmlGetRequest, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const LOGIN = "founder";

function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no boot in shell");
  return JSON.parse(json) as SpaBoot;
}

async function bootFor(mode: "saas" | "self-hosted", freeMember: boolean): Promise<SpaBoot> {
  const db = createMigratedTestD1();
  const userId = crypto.randomUUID();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(userId, LOGIN, new Date().toISOString());
  if (freeMember) {
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'owner', ?)",
      )
      .run(userId, new Date().toISOString());
  }
  const env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: mode,
    DB: db,
  } as unknown as Env;
  const session = await createSessionValue(LOGIN, null, SESSION_SECRET);
  const res = await worker.fetch(
    htmlGetRequest("/dashboard/default/apps", { Cookie: `${SESSION_COOKIE}=${session}` }),
    withSpaAssets(env),
  );
  expect(res.status).toBe(200);
  return bootOf(await res.text());
}

describe("boot create-workspace capability", () => {
  test("saas + free slot taken → blocked with the free_slot reason", async () => {
    const boot = await bootFor("saas", true);
    expect(boot.canCreateWorkspace).toBe(false);
    expect(boot.createWorkspaceBlockedReason).toBe("free_slot");
  });

  test("saas + free slot free → allowed, no reason", async () => {
    const boot = await bootFor("saas", false);
    expect(boot.canCreateWorkspace).toBe(true);
    expect(boot.createWorkspaceBlockedReason).toBeNull();
  });

  test("self-hosted + free membership → still allowed (every workspace resolves unlimited)", async () => {
    const boot = await bootFor("self-hosted", true);
    expect(boot.canCreateWorkspace).toBe(true);
    expect(boot.createWorkspaceBlockedReason).toBeNull();
  });

  test("the plan chip's data rides each membership row, in both modes", async () => {
    expect((await bootFor("saas", true)).memberships?.map((row) => row.plan)).toEqual(["Free"]);
    expect((await bootFor("self-hosted", true)).memberships?.map((row) => row.plan)).toEqual([
      "Unlimited",
    ]);
  });
});
