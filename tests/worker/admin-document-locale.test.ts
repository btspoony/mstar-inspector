import { describe, expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { LOCALE_COOKIE } from "../../src/i18n/resolve";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "admin", "document", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";

const ADMIN_HTML = `<!doctype html><html lang="en"><head><title>Morning Star — Platform operations</title><!--SPA_BOOT--></head><body>admin console</body></html>`;

function adminAssets(): Fetcher {
  return {
    fetch: async (input: Request | URL | string) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname !== "/admin.html") return new Response("missing", { status: 404 });
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher;
}

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    )
    .run(crypto.randomUUID(), OPERATOR, new Date().toISOString());
  return db;
}

function envFor(): Env {
  return {
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: seededDb(),
    ASSETS: adminAssets(),
  } as unknown as Env;
}

function bootOf(html: string): Record<string, unknown> {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no boot in the admin document");
  return JSON.parse(json) as Record<string, unknown>;
}

async function getDocument(env: Env, cookie?: string): Promise<string> {
  const session = `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}`;
  const res = await worker.fetch(
    new Request("https://worker.local/_internal_admin", {
      headers: { Accept: "text/html", Cookie: cookie ? `${session}; ${cookie}` : session },
    }),
    env,
  );
  expect(res.status).toBe(200);
  return res.text();
}

describe("the admin document locale substitution", () => {
  test("a zh_CN cookie serves lang=zh-CN with the Chinese title and boot", async () => {
    const html = await getDocument(envFor(), `${LOCALE_COOKIE}=zh_CN`);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("<title>Morning Star — 平台运营</title>");
    expect(bootOf(html).locale).toBe("zh_CN");
  });

  test("no cookie serves lang=en with the English title and boot", async () => {
    const html = await getDocument(envFor());
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Morning Star — Platform operations</title>");
    expect(bootOf(html).locale).toBe("en");
  });
});
