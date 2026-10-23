/**
 * `DEPLOYMENT_MODE` — the deployment-shape switch (2026-10).
 *
 * It decides ONE product question: does a deployment with no accounts yet
 * tell its first signer-in that this sign-in created the first account? The
 * matrix is `self-hosted` / `saas` / invalid × empty and populated `users`,
 * driven through the two REAL read faces over the worker mount: the OAuth
 * callback (which observes the empty table) and the SPA boot (which renders
 * the guidance).
 *
 * The failure rule is the point of the switch: unset, empty and typo'd values
 * throw with the named error and answer 500 — never a fallback, never a
 * guidance page. `deploymentModeOf` is the single resolver, so the unit cases
 * pin the message and the surface cases pin that both faces carry it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { deploymentModeOf, type Env } from "../../src/worker/env";
import {
  FIRST_INSTANCE_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createFirstInstanceValue,
  createSessionValue,
  createStateValue,
} from "../../src/dashboard/session";
import type { SpaBoot } from "../../src/spa/boot";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const CLIENT_ID = "oauth-client-id";
const CLIENT_SECRET = "oauth-client-secret";

const INVALID_MODE_MESSAGE = 'DEPLOYMENT_MODE must be "self-hosted" or "saas", received';

/** A migrated store with NO accounts — the empty-instance fixture. */
function emptyInstance(): TestD1 {
  return createMigratedTestD1();
}

/** The same store with one existing account (the "populated table" row of the matrix). */
function populatedInstance(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), "veteran", new Date().toISOString());
  return db;
}

function envFor(
  db: TestD1,
  mode: string | undefined,
  tenant: { operators?: string } = {},
): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
    ...(mode === undefined ? {} : { DEPLOYMENT_MODE: mode }),
    ...(tenant.operators === undefined ? {} : { PLATFORM_OPERATORS: tenant.operators }),
  } as unknown as Env;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** GitHub identity stub: token exchange then `/user` for the given login. */
function stubGitHubIdentity(login: string): void {
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    if (target === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "gho_test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (target === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login, name: null }), { status: 200 });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  }) as unknown as typeof fetch;
}

/** Run the real OAuth callback for `login` and answer with the response. */
async function oauthCallback(login: string, env: Env): Promise<Response> {
  stubGitHubIdentity(login);
  const state = await createStateValue(SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local/dashboard/oauth/callback?code=x&state=${state}`, {
      headers: { Cookie: `${OAUTH_STATE_COOKIE}=${state}` },
    }),
    env,
  );
}

/** The marker value the callback minted, or null when it set none. */
function firstInstanceMarker(res: Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${FIRST_INSTANCE_COOKIE}=`) && !value.includes("Max-Age=0"));
  return cookie === null || cookie === undefined ? null : cookie.split(";")[0]!.slice(FIRST_INSTANCE_COOKIE.length + 1);
}

/** Read the injected boot out of a shell document. */
function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no boot in shell");
  return JSON.parse(json) as SpaBoot;
}

/** Does this response clear the first-instance marker? */
function spendsMarker(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some((value) => value.startsWith(`${FIRST_INSTANCE_COOKIE}=`) && value.includes("Max-Age=0"));
}

/** GET a shell path with the given cookies, assets bound. */
async function shell(path: string, env: Env, cookies: string[]): Promise<Response> {
  return worker.fetch(shellRequest(path, cookies, "GET"), withSpaAssets(env));
}

function shellRequest(path: string, cookies: string[], method: "GET" | "HEAD"): Request {
  return new Request(`https://worker.local${path}`, {
    method,
    headers: { Accept: "text/html", ...(cookies.length === 0 ? {} : { Cookie: cookies.join("; ") }) },
  });
}

describe("deploymentModeOf", () => {
  test("accepts exactly self-hosted and saas", () => {
    expect(deploymentModeOf("self-hosted")).toBe("self-hosted");
    expect(deploymentModeOf("saas")).toBe("saas");
  });

  test("unset and empty are invalid — there is no default", () => {
    expect(() => deploymentModeOf(undefined)).toThrow(`${INVALID_MODE_MESSAGE} unset`);
    expect(() => deploymentModeOf("")).toThrow(`${INVALID_MODE_MESSAGE} ""`);
  });

  test("a near-miss typo is not a mode", () => {
    for (const value of ["Self-Hosted", "selfhosted", "SaaS", "self_hosted", " saas "]) {
      expect(() => deploymentModeOf(value)).toThrow(INVALID_MODE_MESSAGE);
    }
  });
});

describe("OAuth callback face — empty instance", () => {
  test("self-hosted: the first account is marked, and it lands on workspace creation", async () => {
    const db = emptyInstance();
    const res = await oauthCallback("founder", envFor(db, "self-hosted"));
    expect(res.status).toBe(302);
    // Sign-in joins no workspace, so the landing is the creation surface.
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(firstInstanceMarker(res)).not.toBeNull();
    // The sign-in itself wrote the account.
    expect(db.raw.query("SELECT github_login FROM users").all()).toEqual([{ github_login: "founder" }]);
  });

  test("saas: no instance story — the marker is never minted", async () => {
    const db = emptyInstance();
    const res = await oauthCallback("founder", envFor(db, "saas"));
    expect(res.status).toBe(302);
    expect(firstInstanceMarker(res)).toBeNull();
    expect(db.raw.query("SELECT github_login FROM users").all()).toEqual([{ github_login: "founder" }]);
  });
});

describe("OAuth callback face — populated instance", () => {
  for (const mode of ["self-hosted", "saas"] as const) {
    test(`${mode}: an existing table never shows the empty-instance story`, async () => {
      const db = populatedInstance();
      const res = await oauthCallback("newcomer", envFor(db, mode));
      expect(res.status).toBe(302);
      expect(firstInstanceMarker(res)).toBeNull();
    });
  }
});

describe("OAuth callback face — invalid mode is a named 500", () => {
  const cases: Array<[label: string, mode: string | undefined, received: string]> = [
    ["unset", undefined, "unset"],
    ["empty", "", '""'],
    ["typo", "selfhosted", '"selfhosted"'],
  ];
  for (const [label, mode, received] of cases) {
    test(`${label}: 500 with the named error, zero writes, no session`, async () => {
      const db = emptyInstance();
      const res = await oauthCallback("founder", envFor(db, mode));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe(`${INVALID_MODE_MESSAGE} ${received}`);
      // Fail loud BEFORE any write: no account, no session cookie.
      expect(db.raw.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    });
  }
});

describe("SPA boot face — the marker drives the guidance", () => {
  // A seeded account: the shell re-reads the users row (QC W-001), so a
  // session whose login has no row is the removed-member 302 instead.
  const LOGIN = "veteran";

  async function signedInShell(db: TestD1, mode: string | undefined, marker: string | null) {
    const session = await createSessionValue(LOGIN, null, SESSION_SECRET);
    const cookies = [`${SESSION_COOKIE}=${session}`, ...(marker === null ? [] : [`${FIRST_INSTANCE_COOKIE}=${marker}`])];
    return shell("/dashboard", envFor(db, mode), cookies);
  }

  test("self-hosted + marker → the boot carries emptyInstance and the marker is spent", async () => {
    const db = populatedInstance();
    const marker = await createFirstInstanceValue(LOGIN, SESSION_SECRET);
    const res = await signedInShell(db, "self-hosted", marker);
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).emptyInstance).toBe(true);
    // One-shot: a statement about the sign-in, never a session property.
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${FIRST_INSTANCE_COOKIE}=`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  test("saas + marker → no guidance (a mode flip cannot resurrect it)", async () => {
    const db = populatedInstance();
    const marker = await createFirstInstanceValue(LOGIN, SESSION_SECRET);
    const res = await signedInShell(db, "saas", marker);
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).emptyInstance).toBeUndefined();
  });

  test("a marker minted for another login is refused", async () => {
    const db = populatedInstance();
    const marker = await createFirstInstanceValue("somebody-else", SESSION_SECRET);
    const res = await signedInShell(db, "self-hosted", marker);
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).emptyInstance).toBeUndefined();
  });

  test("a tampered signature is refused", async () => {
    const db = populatedInstance();
    const marker = await createFirstInstanceValue(LOGIN, SESSION_SECRET);
    const [body, sig] = marker.split(".");
    // Same reasoning as tests/worker/dashboard.test.ts: the final base64url
    // char of a 32-byte HMAC carries padding bits, so a last-char flip can
    // decode to the identical bytes. Replace the whole signature.
    const res = await signedInShell(
      db,
      "self-hosted",
      `${body}.${"A".repeat(sig!.length)}`,
    );
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).emptyInstance).toBeUndefined();
  });

  test("an expired marker is refused", async () => {
    const db = populatedInstance();
    // Minted 200 s ago: past FIRST_INSTANCE_MAX_AGE_SEC (120 s).
    const marker = await createFirstInstanceValue(LOGIN, SESSION_SECRET, Date.now() - 200_000);
    const res = await signedInShell(db, "self-hosted", marker);
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).emptyInstance).toBeUndefined();
  });

  test("a session cookie value is not a marker (same secret, different purpose)", async () => {
    const db = populatedInstance();
    const session = await createSessionValue(LOGIN, null, SESSION_SECRET);
    const res = await signedInShell(db, "self-hosted", session);
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).emptyInstance).toBeUndefined();
  });

  test("the marker is spent on the no-session redirect branch too", async () => {
    const marker = await createFirstInstanceValue(LOGIN, SESSION_SECRET);
    // No session cookie → the login redirect, which still must not leave the
    // marker alive for the shell the next request loads.
    const res = await shell("/dashboard", envFor(populatedInstance(), "self-hosted"), [
      `${FIRST_INSTANCE_COOKIE}=${marker}`,
    ]);
    expect(res.status).toBe(302);
    expect(spendsMarker(res)).toBe(true);
  });

  // A self-hosted deployer is usually an operator or already has a workspace,
  // so the FIRST request after the callback is the `/dashboard` 302 and the
  // shell is the SECOND one. Only the response that delivers the boot may
  // spend the marker — otherwise the 302 eats the guidance (AC2's headline).
  function strictInstance(role: "member" | "operator"): TestD1 {
    const db = populatedInstance();
    const { id } = db.raw.query("SELECT id FROM users WHERE github_login = ?").get(LOGIN) as { id: string };
    const now = new Date().toISOString();
    if (role === "member") {
      db.raw
        .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'member', ?)")
        .run(id, now);
    } else {
      // A live grant on the migration-seeded `default` workspace: the operator
      // landing, which redirects through the support classifier.
      db.raw
        .prepare(
          `INSERT INTO support_grants (id, workspace_id, operator_login, reason, granted_by, created_at, expires_at)
           VALUES (?, 'default', ?, 'first login', 'deployer', ?, ?)`,
        )
        .run(crypto.randomUUID(), LOGIN, now, new Date(Date.now() + 60_000).toISOString());
    }
    return db;
  }

  for (const role of ["member", "operator"] as const) {
    test(`a /dashboard 302 (${role}) does not spend the marker; the shell that follows shows it`, async () => {
      const env = envFor(strictInstance(role), "self-hosted", {
        ...(role === "operator" ? { operators: LOGIN } : {}),
      });
      const cookies = [
        `${SESSION_COOKIE}=${await createSessionValue(LOGIN, null, SESSION_SECRET)}`,
        `${FIRST_INSTANCE_COOKIE}=${await createFirstInstanceValue(LOGIN, SESSION_SECRET)}`,
      ];

      const landed = await shell("/dashboard", env, cookies);
      expect(landed.status).toBe(302);
      expect(landed.headers.get("Location")).toBe("/dashboard/default/apps");
      expect(spendsMarker(landed)).toBe(false);

      // The browser follows that 302; this response renders the first-login
      // screen, so this is the one that carries — and spends — the marker.
      const rendered = await shell("/dashboard/default/apps", env, cookies);
      expect(rendered.status).toBe(200);
      expect(bootOf(await rendered.text()).emptyInstance).toBe(true);
      expect(spendsMarker(rendered)).toBe(true);
    });
  }

  test("a HEAD shell request does not spend the marker", async () => {
    const env = envFor(populatedInstance(), "self-hosted");
    const cookies = [
      `${SESSION_COOKIE}=${await createSessionValue(LOGIN, null, SESSION_SECRET)}`,
      `${FIRST_INSTANCE_COOKIE}=${await createFirstInstanceValue(LOGIN, SESSION_SECRET)}`,
    ];

    // HEAD carries no document, so it has no boot to deliver the guidance in;
    // spending the marker there would lose it for the GET that follows.
    const head = await worker.fetch(shellRequest("/dashboard", cookies, "HEAD"), withSpaAssets(env));
    expect(head.status).toBe(200);
    expect(spendsMarker(head)).toBe(false);

    const get = await shell("/dashboard", env, cookies);
    expect(bootOf(await get.text()).emptyInstance).toBe(true);
    expect(spendsMarker(get)).toBe(true);
  });

  test("no marker → no guidance, on either mode", async () => {
    for (const mode of ["self-hosted", "saas"] as const) {
      const res = await signedInShell(populatedInstance(), mode, null);
      expect(res.status).toBe(200);
      expect(bootOf(await res.text()).emptyInstance).toBeUndefined();
    }
  });
});

describe("SPA boot face — invalid mode is a named 500", () => {
  test("no shell, no guidance page: the named error is the whole response", async () => {
    const db = populatedInstance();
    const session = await createSessionValue("founder", null, SESSION_SECRET);
    for (const [mode, received] of [
      [undefined, "unset"],
      ["", '""'],
      ["production", '"production"'],
    ] as const) {
      const res = await shell("/dashboard", envFor(db, mode), [`${SESSION_COOKIE}=${session}`]);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe(`${INVALID_MODE_MESSAGE} ${received}`);
    }
  });

  test("the login page fails the same way — validation precedes every screen", async () => {
    const res = await shell("/dashboard/login", envFor(emptyInstance(), undefined), []);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(`${INVALID_MODE_MESSAGE} unset`);
  });
});

describe("empty instance end to end — the sign-in that created the account", () => {
  /**
   * The two halves of the empty-instance matrix above are asserted separately
   * (the callback mints the marker on an empty table; the shell renders it from
   * a marker). This walks the real pair: the callback's cookies are followed
   * through its redirects to the shell document, so the marker minted at the
   * LAST empty moment has to survive the 302 and be honoured after the account
   * exists — the headline of the feature.
   */
  async function landingShell(res: Response, env: Env): Promise<{ status: number; html: string }> {
    const cookies = res.headers.getSetCookie().map((value) => value.split(";")[0]!);
    let target = res.headers.get("Location");
    if (target === null) throw new Error("callback did not land anywhere");
    for (let hop = 0; hop < 4; hop += 1) {
      const next = await shell(target, env, cookies);
      if (next.status !== 302) return { status: next.status, html: await next.text() };
      target = next.headers.get("Location");
      if (target === null) throw new Error("302 without a Location");
    }
    throw new Error("redirect loop after the callback");
  }

  for (const [mode, showsGuidance] of [
    ["self-hosted", true],
    ["saas", false],
  ] as const) {
    test(`${mode}: an empty users table → ${showsGuidance ? "guidance" : "no guidance"}`, async () => {
      const db = emptyInstance();
      const env = envFor(db, mode);
      const landed = await landingShell(await oauthCallback("founder", env), env);
      expect(landed.status).toBe(200);
      expect(bootOf(landed.html).emptyInstance).toBe(showsGuidance ? true : undefined);
      // The sign-in itself wrote the only account, so this asserted the
      // guidance against a table that is no longer empty.
      expect(db.raw.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    });
  }
});

describe("SPA creation page copy", () => {
  test("the guidance line exists in both locales", async () => {
    const { t } = await import("../../src/i18n");
    expect(t("en", "workspace.emptyInstance")).toContain("no accounts yet");
    expect(t("zh_CN", "workspace.emptyInstance")).toContain("还没有任何账号");
  });
});
