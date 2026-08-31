/**
 * Review Health insights panel UI tests (plan 22 Task 3, spec § M4b +
 * § DESIGN.md 意图): GET /dashboard/insights renders the member-visible
 * HTML face of the SAME store aggregation as the JSON API — window/repo
 * summary card (reviews total + verdict distribution), findings by
 * severity bars, findings by category, weekly trend, and the recurring-top
 * list (title + count + repos — the fingerprint technical id NEVER
 * renders). The mount-level membership guard is the same as every other
 * /dashboard route; the query-param contract (window parse + clamp echo,
 * repo filter) mirrors the T2 JSON route. Token discipline: the page
 * reuses the existing Level 1 class set (.status/.note/.meta/.keys/.id/
 * .enabled rhythm) — no new CSS classes, no new DESIGN tokens.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { reviewedAt, mondayOf } from "../../src/dashboard/insights-dates";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";

type InsightsFixtureFinding = {
  id: string;
  severity: string;
  category: string | null;
  title: string;
  fingerprint: string | null;
};

/** Raw-insert one review + its findings (explicit reviewed_at / verdict). */
function seedInsightsReview(
  db: TestD1,
  opts: {
    id: string;
    owner: string;
    repo: string;
    pr_number: number;
    reviewedAt: string;
    verdict: string;
    findings: InsightsFixtureFinding[];
  },
): void {
  db.raw
    .query(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope)
       VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', '{}')`,
    )
    .run(opts.id, opts.owner, opts.repo, opts.pr_number, opts.reviewedAt, opts.verdict);
  const insertFinding = db.raw.query(
    `INSERT INTO findings (id, review_id, severity, category, title, body, fingerprint)
     VALUES (?, ?, ?, ?, ?, 'b', ?)`,
  );
  for (const f of opts.findings) {
    insertFinding.run(f.id, opts.id, f.severity, f.category, f.title, f.fingerprint);
  }
}

function makeEnv(db: unknown, overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: "123",
    PRIVATE_KEY: "private-key",
    WEBHOOK_SECRET: "s3cret-webhook-secret",
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
    ...overrides,
  } as Env;
}

function seedMember(db: TestD1, login: string, role: "admin" | "member"): void {
  db.raw
    .query("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)")
    .run(crypto.randomUUID(), login, role, new Date().toISOString());
}

/**
 * A member-seeded, insights-fixture D1 env (mirror of the T2 fixture):
 *   - r-a acme/widgets PR 1, 25d ago, verdict "comment": must-fix/logic fp-x,
 *     nit/NULL-category fp-y
 *   - r-b acme/widgets PR 2, 15d ago, verdict "approve": must-fix/logic fp-x
 *     (shares fp-x with r-a → recurrence, count 2)
 *   - r-c globex/gadgets PR 3, 5d ago, verdict "request changes":
 *     should-fix/security fp-z (single occurrence → never recurs)
 *   - r-d acme/widgets PR 4, 60d ago, verdict "approve", no findings —
 *     inside a 90-day window, outside the default 30
 */
function insightsFixtureEnv(): Env {
  const db = createMigratedTestD1();
  seedMember(db, "octocat", "admin");
  seedMember(db, "mallory", "member");
  seedInsightsReview(db, {
    id: "r-a",
    owner: "acme",
    repo: "widgets",
    pr_number: 1,
    reviewedAt: reviewedAt(25),
    verdict: "comment",
    findings: [
      { id: "f-a1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: "fp-x" },
      { id: "f-a2", severity: "nit", category: null, title: "Trailing space", fingerprint: "fp-y" },
    ],
  });
  seedInsightsReview(db, {
    id: "r-b",
    owner: "acme",
    repo: "widgets",
    pr_number: 2,
    reviewedAt: reviewedAt(15),
    verdict: "approve",
    findings: [
      { id: "f-b1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: "fp-x" },
    ],
  });
  seedInsightsReview(db, {
    id: "r-c",
    owner: "globex",
    repo: "gadgets",
    pr_number: 3,
    reviewedAt: reviewedAt(5),
    verdict: "request changes",
    findings: [
      { id: "f-c1", severity: "should-fix", category: "security", title: "Injection", fingerprint: "fp-z" },
    ],
  });
  seedInsightsReview(db, {
    id: "r-d",
    owner: "acme",
    repo: "widgets",
    pr_number: 4,
    reviewedAt: reviewedAt(60),
    verdict: "approve",
    findings: [],
  });
  return makeEnv(db);
}

const sessionCookie = async (login: string) =>
  `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;

async function get(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(new Request(`https://worker.local${path}`, { headers: { Cookie: cookie } }), env);
}

/**
 * The existing Level 1 class set in src/dashboard/views.ts (STYLE block +
 * page markup) — the token-discipline regression: the insights page must
 * not introduce any class name outside this set (DESIGN.md is the SSOT;
 * new tokens go through the mstar-design-md flow, not a page-local class).
 */
const EXISTING_CLASSES: Record<string, true> = {
  user: true,
  sections: true,
  enabled: true,
  status: true,
  note: true,
  banner: true,
  warn: true,
  primary: true,
  danger: true,
  secondary: true,
  cancel: true,
  checkbox: true,
  id: true,
  field: true,
  members: true,
  meta: true,
  you: true,
  apps: true,
  controls: true,
  empty: true,
  keys: true,
};

describe("GET /dashboard/insights (plan 22 Task 3, HTML panel)", () => {
  test("renders the panel: nav link, summary card, severity bars, categories, trend, recurring", async () => {
    const res = await get("/dashboard/insights", await sessionCookie("octocat"), insightsFixtureEnv());
    expect(res.status).toBe(200);
    const body = await res.text();

    // AL-22-1: the shellHeader carries an unconditional Insights link.
    expect(body).toContain('<a href="/dashboard/insights">Insights</a>');

    // Summary card: window label + reviews total + verdict distribution.
    expect(body).toContain("Window: last 30 days");
    expect(body).toContain("Reviews: <span class=\"id\">3</span>");
    expect(body).toContain("Verdicts: approve <span class=\"id\">1</span> · comment <span class=\"id\">1</span> · request changes <span class=\"id\">1</span>");

    // Findings by severity: three bars with counts (must-fix 2 tops the bar).
    expect(body).toContain("<strong>must-fix</strong>");
    expect(body).toContain("<span class=\"id\">2</span> findings");
    expect(body).toContain("<strong>nit</strong>");
    expect(body).toContain("<strong>should-fix</strong>");
    expect(body).toContain("width:100%"); // top bucket = full bar
    expect(body).toContain("width:50%"); // nit = 1/2 of must-fix

    // Findings by category: logic 2, uncategorized 1, security 1.
    expect(body).toContain("<strong>logic</strong>");
    expect(body).toContain("<strong>uncategorized</strong>");
    expect(body).toContain("<strong>security</strong>");

    // Weekly trend: three Monday-anchored week rows with review/finding counts.
    const weekA = mondayOf(reviewedAt(25));
    const weekB = mondayOf(reviewedAt(15));
    const weekC = mondayOf(reviewedAt(5));
    expect(new Set([weekA, weekB, weekC]).size).toBe(3);
    expect(body).toContain(`<strong>${weekA}</strong>`);
    expect(body).toContain(`<strong>${weekB}</strong>`);
    expect(body).toContain(`<strong>${weekC}</strong>`);
    expect(body).toContain("review · <span class=\"id\">2</span> finding"); // weekA: 1 review, 2 findings
    expect(body).toContain("review · <span class=\"id\">1</span> finding"); // weekB/weekC

    // Recurring top: exactly ONE row — title + count + repos, never the
    // fingerprint technical id.
    const recurringSection = body.split("<h2>Recurring findings</h2>")[1]?.split("</section>")[0] ?? "";
    expect(recurringSection.match(/<li>/g)).toHaveLength(1);
    expect(recurringSection).toContain("<strong>Null deref risk</strong>");
    expect(recurringSection).toContain("<span class=\"id\">2</span> reviews");
    expect(recurringSection).toContain("acme/widgets");
    expect(body).not.toContain("fp-x");
    expect(body).not.toContain("fp-y");
    expect(body).not.toContain("fp-z");
  });

  test("empty state (zero reviews in window): note on the summary card, data cards omitted", async () => {
    const res = await get("/dashboard/insights?window=0", await sessionCookie("octocat"), insightsFixtureEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Reviews: <span class=\"id\">0</span>");
    expect(body).toContain("No reviews in this window.");
    // The four data cards are omitted entirely — no empty lists.
    expect(body).not.toContain("Findings by severity");
    expect(body).not.toContain("Findings by category");
    expect(body).not.toContain("Weekly trend");
    expect(body).not.toContain("Recurring findings");
  });

  test("recurring empty state: reviews exist but no recurrence (repo filter)", async () => {
    const res = await get("/dashboard/insights?repo=globex/gadgets", await sessionCookie("octocat"), insightsFixtureEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    // The repo filter is echoed on the summary card; the single review has
    // no recurrence, so the recurring card shows its own empty line.
    expect(body).toContain("repo globex/gadgets");
    expect(body).toContain("Reviews: <span class=\"id\">1</span>");
    expect(body).toContain("No recurring findings in this window.");
    expect(body).not.toContain("fp-z");
  });

  test("window clamp echo: window=400 renders the effective 90-day window (r-d enters)", async () => {
    const res = await get("/dashboard/insights?window=400", await sessionCookie("octocat"), insightsFixtureEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Window: last 90 days");
    expect(body).toContain("Reviews: <span class=\"id\">4</span>"); // r-d (60d) now fits
  });

  test("malformed params → 400 error page (same contract as the JSON API)", async () => {
    const cookie = await sessionCookie("octocat");
    for (const query of ["window=abc", "window=-5", "window=30.5", "repo=oops", "repo=owner/repo/extra"]) {
      const res = await get(`/dashboard/insights?${query}`, cookie, insightsFixtureEnv());
      expect(res.status, `?${query}`).toBe(400);
      const body = await res.text();
      // W-B: the 400 is a plain bad-request notice — NEVER the OAuth
      // errorPage ("Sign-in failed" / "Sign-in error" copy is for the
      // login flow; the visitor here IS authenticated).
      expect(body, `?${query}`).toContain("banner");
      expect(body, `?${query}`).not.toContain("Sign-in failed");
      expect(body, `?${query}`).not.toContain("Sign-in error");
      expect(body, `?${query}`).not.toContain("No session was created");
    }
  });

  test("user-controlled strings are escaped: title_sample and repo never render raw", async () => {
    const db = createMigratedTestD1();
    seedMember(db, "octocat", "admin");
    // Two reviews sharing one fingerprint → the malicious title lands in the
    // recurring top (count >= 2 DISTINCT reviews), where it must be escaped.
    seedInsightsReview(db, {
      id: "r-e1",
      owner: "acme&co",
      repo: "widgets",
      pr_number: 9,
      reviewedAt: reviewedAt(2),
      verdict: "comment",
      findings: [
        { id: "f-e1", severity: "must-fix", category: "logic", title: "<img src=x onerror=alert(1)>", fingerprint: "fp-e" },
      ],
    });
    seedInsightsReview(db, {
      id: "r-e2",
      owner: "acme&co",
      repo: "widgets",
      pr_number: 10,
      reviewedAt: reviewedAt(1),
      verdict: "comment",
      findings: [
        { id: "f-e2", severity: "must-fix", category: "logic", title: "<img src=x onerror=alert(1)>", fingerprint: "fp-e" },
      ],
    });
    const res = await get("/dashboard/insights", await sessionCookie("octocat"), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Title escaped in the recurring row; repo escaped in the recurring row.
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("acme&amp;co/widgets");
    expect(body).not.toContain("acme&co/widgets");
    // The fingerprint technical id still never renders.
    expect(body).not.toContain("fp-e");
  });

  test("token discipline: no new CSS class names beyond the existing Level 1 set", async () => {
    const res = await get("/dashboard/insights", await sessionCookie("octocat"), insightsFixtureEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    const classes = new Set<string>();
    for (const m of body.matchAll(/class="([^"]+)"/g)) {
      for (const token of m[1]!.split(/\s+/)) {
        if (token) classes.add(token);
      }
    }
    for (const token of classes) {
      expect(EXISTING_CLASSES[token], `unexpected class name: ${token}`).toBe(true);
    }
  });
});
