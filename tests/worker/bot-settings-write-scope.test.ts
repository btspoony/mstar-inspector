import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";

const SESSION_SECRET = ["test", "bot", "write", "scope", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const OFFICIAL = "default";
const OTHER = "ws-other";
const HOME_BOT = 8201;
// The seeded ROW id (bot-config routes bind this).
const HOME_BOT_ROW = "bot-home";
const OTHER_BOT_ROW = "bot-other";
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
  db.raw.prepare("INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(botId, workspaceId);
  // The scoped read keys on review_bots.workspace_id.
  db.raw.prepare("UPDATE review_bots SET workspace_id = ? WHERE id = ?").run(workspaceId, botId);
}

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

async function getSettings(ref: string, login: string, botId: string): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/" + ref + "/api/review-bots/" + botId + "/settings", {
      headers: { Cookie: SESSION_COOKIE + "=" + session, Accept: "application/json" },
    }),
    envFor(),
  );
}

const SEAMS: ReadonlyArray<{ name: string; path: string; form?: Record<string, string> }> = [
  { name: "lifecycle", path: "/apps/" + HOME_BOT + "/disable" },
  { name: "metadata refresh", path: "/api/apps/" + HOME_BOT + "/refresh-metadata" },
  { name: "key verify", path: "/api/review-bots/" + HOME_BOT_ROW + "/keys/verify", form: { provider: "", key: "" } },
  {
    name: "settings op",
    path: "/review-bots/" + HOME_BOT_ROW + "/settings",
    form: { op: "save-sandbox-image", sandbox_image_id: "omp" },
  },
  {
    name: "key delete",
    path: "/review-bots/" + HOME_BOT_ROW + "/settings/key/delete",
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
      (db.raw.query("SELECT status FROM github_apps WHERE id = 'bot-home'").get() as { status: string }).status,
    ).toBe("active");
  });
});

describe("the bot settings payload's share facts", () => {
  async function readFacts(ref: string, login: string, botId: string): Promise<Record<string, unknown>> {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("no external call in this test");
    }) as unknown as typeof fetch);
    try {
      const res = await getSettings(ref, login, botId);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    } finally {
      fetchSpy.mockRestore();
    }
  }

  test("the official workspace that owns the shared bot may configure it and may re-share", async () => {
    world();
    const body = await readFacts(OFFICIAL, "dana", HOME_BOT_ROW);
    expect(body.can_manage).toBe(true);
    expect(body.official_workspace).toBe(true);
    expect(body.can_configure_bot).toBe(true);
    expect((body.app as { scope: unknown }).scope).toBe("shared");
  });

  test("a consumer sees the same bot as usable but not configurable", async () => {
    world();
    const body = await readFacts(OTHER, "erin", HOME_BOT_ROW);
    expect(body.official_workspace).toBe(true);
    expect(body.can_configure_bot).toBe(false);
  });

  test("a non-official workspace's own bot is configurable and not shareable", async () => {
    world();
    const body = await readFacts(OTHER, "erin", OTHER_BOT_ROW);
    expect(body.official_workspace).toBe(false);
    expect(body.can_configure_bot).toBe(true);
  });

  test("a plain member's identity face carries neither fact", async () => {
    world();
    const body = await readFacts(OFFICIAL, "mallory", HOME_BOT_ROW);
    expect(body.can_manage).toBe(false);
    expect(body).not.toHaveProperty("official_workspace");
    expect(body).not.toHaveProperty("can_configure_bot");
  });
});

/**
 * F1-2: the EDITOR reads are the owner's. A manager of a workspace that only
 * consumes a shared bot must not receive provider ids, declared custom
 * providers (with live key ids), previews or key-usage probes — those read the
 * owner's credentials. The narrow `/bot` summary remains the consumer's face.
 */
describe("the bot editor's reads require the owning workspace", () => {
  type Read = { name: string; path: string; method: "GET" | "POST"; form?: Record<string, string> };

  const READS: Read[] = [
    { name: "model options", path: "/api/review-bots/" + HOME_BOT_ROW + "/models", method: "GET" },
    {
      name: "provider preview",
      path: "/api/review-bots/" + HOME_BOT_ROW + "/provider-models/preview?provider=anthropic",
      method: "GET",
    },
    {
      name: "key usage",
      path: "/api/review-bots/" + HOME_BOT_ROW + "/keys/usage",
      method: "POST",
      form: { provider: "zai", keyId: "0".repeat(16) },
    },
  ];

  async function read(ref: string, login: string, entry: Read): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local/dashboard/${ref}${entry.path}`, {
        method: entry.method,
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
        ...(entry.form === undefined ? {} : { body: new URLSearchParams(entry.form) }),
      }),
      envFor(),
    );
  }

  test("a consumer workspace's admin gets the read-only refusal from every editor read", async () => {
    world();
    for (const entry of READS) {
      const res = await read(OTHER, "erin", entry);
      expect(res.status, entry.name).toBe(403);
      expect(await res.json(), entry.name).toMatchObject({ key: READ_ONLY_KEY });
    }
  });

  test("the owning workspace's admin still gets the full shape", async () => {
    world();
    const models = await read(OFFICIAL, "dana", READS[0]!);
    expect(models.status).toBe(200);
    const body = (await models.json()) as { groups: unknown };
    expect(Array.isArray(body.groups)).toBe(true);
  });

  test("the owner preview answers 200 with the vocabulary it fetched for a declared provider", async () => {
    world();
    // A declaration with one stored key: the preview's own precondition.
    const store = createAppConfigStore(db, TEST_ENCRYPTION_KEY);
    await store.upsertCustomProvider(
      { botId: HOME_BOT_ROW, workspaceId: OFFICIAL, role: "owner" },
      HOME_BOT_ROW,
      {
        provider_id: "acme-proxy",
        base_url: "https://api.acme.test/v1",
        api: "openai-completions",
        model_ids: ["model-one"],
      },
      "sk-acme-owner-preview",
    );
    // The probe data is the route's ONE outbound read: the declared endpoint's
    // own model list, which keeps model-one and adds model-two.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ data: [{ id: "model-one" }, { id: "model-two" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    try {
      const preview = await worker.fetch(
        new Request(
          `https://worker.local/dashboard/${OFFICIAL}/api/review-bots/${HOME_BOT_ROW}/provider-models/preview?provider=acme-proxy`,
          { headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("dana", null, SESSION_SECRET)}` } },
        ),
        envFor(),
      );
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({
        ok: true,
        provider: "acme-proxy",
        current: 1,
        fetched: 2,
        kept: 1,
        added: 1,
        dropped: 0,
      });
      expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.acme.test/v1/models");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the owner's key-usage read answers 200 with the provider's snapshot", async () => {
    world();
    const store = createAppConfigStore(db, TEST_ENCRYPTION_KEY);
    const plainKey = "sk-zai-owner-usage";
    await store.addProviderKey(
      { botId: HOME_BOT_ROW, workspaceId: OFFICIAL, role: "owner" },
      HOME_BOT_ROW,
      "zai",
      plainKey,
    );
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plainKey));
    const keyId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, currentValue: 25, usage: 200, remaining: 175 }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    try {
      const usage = await read(OFFICIAL, "dana", {
        name: "key usage",
        path: "/api/review-bots/" + HOME_BOT_ROW + "/keys/usage",
        method: "POST",
        form: { provider: "zai", keyId },
      });
      expect(usage.status).toBe(200);
      expect(await usage.json()).toMatchObject({ ok: true, status: "ok" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
