/**
 * A shared bot stays configurable by its OWNING workspace (contract § 8.2).
 *
 * The certification here is the predicate, not five handlers: a bot-scope write
 * asks `canWriteBotScope`, which now answers "is this the bot's owning
 * workspace" — scope decides who may USE the bot, never who may configure it.
 * Every seam is driven twice on the SAME shared bot: once by the owning
 * workspace's manager (admitted — the write path runs and answers for its own
 * reasons) and once by a workspace that reaches the bot only through a live
 * target (the keyed bot-read-only 403, zero writes).
 *
 * The second half pins the payload facts the bot page renders the share switch
 * from: `official_workspace` (the bot's workspace is the platform's designated
 * one) and `can_configure_bot` (this caller's workspace owns the bot).
 */
import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "bot", "write", "scope", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const OFFICIAL = "default";
const OTHER = "ws-other";
const HOME_BOT = 8201;
const OTHER_BOT = 8202;
const READ_ONLY_KEY = "settings.error.botReadOnly";

let db: TestD1;

function envFor(): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DEPLOYMENT_MODE: "self-hosted",
    DB: db,
  } as unknown as Env;
}

function insertUser(login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, "2026-01-01T00:00:00.000Z");
}

function seedMembership(workspaceId: string, login: string, role: string): void {
  db.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, id, ?, '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = ?",
    )
    .run(workspaceId, role, login);
}

function seedOwnedBot(botId: string, githubAppId: number, workspaceId: string): void {
  seedBot(db, botId, githubAppId);
  db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)").run(botId, workspaceId);
}

/** `default` is the official workspace and owns the SHARED `bot-home`. */
function world(): void {
  db = createMigratedTestD1();
  insertUser("dana");
  insertUser("mallory");
  insertUser("erin");
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)")
    .run(OTHER, OTHER, OTHER, "2026-01-01T00:00:00.000Z");
  seedMembership(OFFICIAL, "dana", "owner");
  seedMembership(OFFICIAL, "mallory", "member");
  seedMembership(OTHER, "erin", "owner");
  db.raw
    .prepare(
      "INSERT INTO review_runtime_settings (key, value, updated_at, updated_by) VALUES ('platform.official_workspace_id', ?, '2026-01-01T00:00:00.000Z', 'fixture')",
    )
    .run(OFFICIAL);
  seedOwnedBot("bot-home", HOME_BOT, OFFICIAL);
  seedOwnedBot("bot-other", OTHER_BOT, OTHER);
  // The share itself, plus the consuming workspace's one live target on it.
  db.raw
    .prepare("UPDATE review_bots SET scope = 'shared', shared_at = '2026-01-05T00:00:00.000Z' WHERE id = 'bot-home'")
    .run();
  seedTarget(db, "bot-home", { workspaceId: OTHER, repoOwner: "acme", repoName: "widgets" });
}

async function request(
  ref: string,
  path: string,
  login: string,
  form?: Record<string, string>,
): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/" + ref + path, {
      method: "POST",
      headers: { Cookie: SESSION_COOKIE + "=" + session },
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
    }),
    envFor(),
  );
}

async function getSettings(ref: string, login: string, githubAppId: number): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/" + ref + "/api/apps/" + githubAppId + "/settings", {
      headers: { Cookie: SESSION_COOKIE + "=" + session, Accept: "application/json" },
    }),
    envFor(),
  );
}

/** The five seams that call `canWriteBotScope`, each with a body its own route accepts. */
const SEAMS: ReadonlyArray<{ name: string; path: string; form?: Record<string, string> }> = [
  { name: "lifecycle", path: "/apps/" + HOME_BOT + "/disable" },
  { name: "metadata refresh", path: "/api/apps/" + HOME_BOT + "/refresh-metadata" },
  { name: "key verify", path: "/api/apps/" + HOME_BOT + "/keys/verify", form: { provider: "", key: "" } },
  {
    name: "settings op",
    path: "/apps/" + HOME_BOT + "/settings",
    form: { op: "save-sandbox-image", sandbox_image_id: "omp" },
  },
  {
    name: "key delete",
    path: "/apps/" + HOME_BOT + "/settings/key/delete",
    form: { provider: "anthropic", key_id: "nope" },
  },
];

function storedScope(): string {
  return (db.raw.query("SELECT scope FROM review_bots WHERE id = 'bot-home'").get() as { scope: string }).scope;
}

describe("the bot-scope write predicate: owning workspace in, consumer out", () => {
  test("every seam admits the shared bot's owning workspace", async () => {
    world();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("no external call in this test");
    }) as unknown as typeof fetch);
    try {
      for (const seam of SEAMS) {
        const res = await request(OFFICIAL, seam.path, "dana", seam.form);
        const body = await res.text();
        expect(res.status, seam.name).not.toBe(403);
        expect(body.includes(READ_ONLY_KEY), seam.name).toBe(false);
      }
    } finally {
      fetchSpy.mockRestore();
    }
    // The settings seam's write landed: the sandbox image is the bot's.
    expect(
      (db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = 'bot-home'").get() as {
        sandbox_image_id: string;
      }).sandbox_image_id,
    ).toBe("omp");
  });

  test("every seam refuses the workspace that only holds a target on it, with zero writes", async () => {
    world();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("a bot-scope refusal must never reach GitHub");
    }) as unknown as typeof fetch);
    try {
      for (const seam of SEAMS) {
        const res = await request(OTHER, seam.path, "erin", seam.form);
        expect(res.status, seam.name).toBe(403);
        expect((await res.json()) as { key: unknown }, seam.name).toMatchObject({ key: READ_ONLY_KEY });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(storedScope()).toBe("shared");
    expect(
      (db.raw.query("SELECT status FROM review_bots WHERE id = 'bot-home'").get() as { status: string }).status,
    ).toBe("active");
  });
});

describe("the bot settings payload's share facts", () => {
  /** Every settings read here fails its lazy GitHub refresh on purpose. */
  async function readFacts(ref: string, login: string, githubAppId: number): Promise<Record<string, unknown>> {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("no external call in this test");
    }) as unknown as typeof fetch);
    try {
      const res = await getSettings(ref, login, githubAppId);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    } finally {
      fetchSpy.mockRestore();
    }
  }

  test("the official workspace that owns the shared bot may configure it and may re-share", async () => {
    world();
    const body = await readFacts(OFFICIAL, "dana", HOME_BOT);
    expect(body.can_manage).toBe(true);
    expect(body.official_workspace).toBe(true);
    expect(body.can_configure_bot).toBe(true);
    expect((body.app as { scope: unknown }).scope).toBe("shared");
  });

  test("a consumer sees the same bot as usable but not configurable", async () => {
    world();
    const body = await readFacts(OTHER, "erin", HOME_BOT);
    // The bot's workspace IS the official one — but it is not THIS workspace,
    // so its own fact stays true while the caller's authority does not.
    expect(body.official_workspace).toBe(true);
    expect(body.can_configure_bot).toBe(false);
  });

  test("a non-official workspace's own bot is configurable and not shareable", async () => {
    world();
    const body = await readFacts(OTHER, "erin", OTHER_BOT);
    expect(body.official_workspace).toBe(false);
    expect(body.can_configure_bot).toBe(true);
  });

  test("a plain member's identity face carries neither fact", async () => {
    world();
    const body = await readFacts(OFFICIAL, "mallory", HOME_BOT);
    expect(body.can_manage).toBe(false);
    expect(body).not.toHaveProperty("official_workspace");
    expect(body).not.toHaveProperty("can_configure_bot");
  });
});
