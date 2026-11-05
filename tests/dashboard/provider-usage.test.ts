/**
 * Per-key usage probe tests: the nine families' payload normalization, the
 * shared failure vocabulary, the catalog-id table, and the "never invent a
 * limit" rules (negative counters drop, balance-only stays balance-only).
 *
 * Every family is fixture-backed: a canned body on the family's own endpoint,
 * then an exact assertion on the extracted limits (kind, unit, values, reset).
 * Classification is exercised through the public `probeProviderUsage`, so the
 * tests pin what a caller actually sees.
 */
import { describe, expect, test } from "bun:test";
import {
  fractionFromCounts,
  fractionFromUsed,
  hasUsageProbe,
  probeProviderUsage,
  resetFrom,
  usageProbeHosts,
  type UsageDeps,
} from "../../src/dashboard/provider-usage";

type FetchCall = { url: string; headers: Record<string, string>; redirect?: "follow" | "error" | "manual" };

/** Canned responses served in order; every call records its URL, headers and
 *  redirect mode (the credential-origin guard's transport input). */
function queueFetch(responses: Response[], calls: FetchCall[] = []): UsageDeps["fetch"] {
  return (async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${String(input)}`);
    return next;
  }) as UsageDeps["fetch"];
}

function stubFetch(response: Response, calls: FetchCall[] = []): UsageDeps["fetch"] {
  return queueFetch([response], calls);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- shared normalizers ---

describe("shared normalizers", () => {
  test("fractionFromUsed drops a negative count and clamps an over-100 percent", () => {
    expect(fractionFromUsed(32)).toBe(0.32);
    expect(fractionFromUsed(150)).toBe(1);
    expect(fractionFromUsed(-5)).toBeUndefined();
    expect(fractionFromUsed(Number.NaN)).toBeUndefined();
  });

  test("fractionFromCounts requires a positive limit and a non-negative used", () => {
    expect(fractionFromCounts(30, 100)).toBe(0.3);
    expect(fractionFromCounts(150, 100)).toBe(1);
    expect(fractionFromCounts(-5, 100)).toBeUndefined();
    expect(fractionFromCounts(30, 0)).toBeUndefined();
    expect(fractionFromCounts(undefined, 100)).toBeUndefined();
    expect(fractionFromCounts(30, undefined)).toBeUndefined();
  });

  test("resetFrom accepts ISO, epoch seconds, epoch ms and numeric strings", () => {
    expect(resetFrom("2026-11-05T10:00:00.000Z")).toBe(Date.parse("2026-11-05T10:00:00.000Z"));
    expect(resetFrom(1_760_000_000)).toBe(1_760_000_000_000);
    expect(resetFrom(1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(resetFrom("1760000000")).toBe(1_760_000_000_000);
    expect(resetFrom("not a time")).toBeUndefined();
    expect(resetFrom(null)).toBeUndefined();
  });
});

// --- probe table ---

describe("usage probe table", () => {
  const covered = [
    "commandcode",
    "commandcode-anthropic",
    "opencode-go",
    "zai",
    "zai-coding-plan",
    "zhipuai",
    "zhipuai-coding-plan",
    "minimax-coding-plan",
    "minimax-cn-coding-plan",
    "cline-pass",
    "synthetic",
    "umans",
    "hyper",
    "kimi-for-coding",
    "cursor",
  ];

  test("covers exactly the ten families' fifteen catalog ids", () => {
    expect(covered.filter((id) => hasUsageProbe(id))).toEqual(covered);
  });

  test("every other id has no probe (own-property lookup, no proto leak)", () => {
    for (const id of ["anthropic", "openai", "ollama-cloud", "moonshotai", "minimax", "constructor"]) {
      expect(hasUsageProbe(id)).toBe(false);
    }
  });

  test("every mapped id advertises exactly the hosts its probe calls; an unmapped id has none", async () => {
    // One entry per family: the endpoints its probe GETs, the canned answers
    // that let it run, and the catalog ids sharing it. The probe executes, so
    // the advertised set is checked against REAL call sites — never a second
    // hand-kept list that could drift from the request code.
    const families: Array<{ ids: string[]; urls: string[]; responses: () => Response[] }> = [
      {
        ids: ["commandcode", "commandcode-anthropic"],
        urls: ["https://api.commandcode.ai/alpha/whoami", "https://api.commandcode.ai/alpha/billing/credits"],
        responses: () => [json(200, { user: { id: "user-1" } }), json(200, {})],
      },
      { ids: ["opencode-go"], urls: ["https://opencode.ai/zen/go/v1/usage"], responses: () => [json(200, {})] },
      {
        ids: ["zai", "zai-coding-plan"],
        urls: ["https://api.z.ai/api/monitor/usage/quota/limit"],
        responses: () => [json(200, {})],
      },
      {
        ids: ["zhipuai", "zhipuai-coding-plan"],
        urls: ["https://open.bigmodel.cn/api/monitor/usage/quota/limit"],
        responses: () => [json(200, {})],
      },
      {
        ids: ["minimax-coding-plan"],
        urls: ["https://api.minimax.io/v1/token_plan/remains"],
        responses: () => [json(200, {})],
      },
      {
        ids: ["minimax-cn-coding-plan"],
        urls: ["https://api.minimaxi.com/v1/token_plan/remains"],
        responses: () => [json(200, {})],
      },
      {
        ids: ["cline-pass"],
        urls: ["https://api.cline.bot/api/v1/users/me/plan/usage-limits"],
        responses: () => [json(200, {})],
      },
      { ids: ["synthetic"], urls: ["https://api.synthetic.new/v2/quotas"], responses: () => [json(200, {})] },
      { ids: ["umans"], urls: ["https://api.code.umans.ai/v1/usage"], responses: () => [json(200, {})] },
      { ids: ["hyper"], urls: ["https://hyper.charm.land/credits"], responses: () => [json(200, {})] },
      {
        ids: ["kimi-for-coding"],
        urls: ["https://api.kimi.com/coding/v1/usages"],
        responses: () => [json(200, {})],
      },
      { ids: ["cursor"], urls: ["https://api2.cursor.sh/auth/usage"], responses: () => [json(200, {})] },
    ];

    // The table above must cover the whole probe set, not a subset.
    expect(families.flatMap((family) => family.ids).sort()).toEqual([...covered].sort());

    for (const family of families) {
      const expectedHosts = [...new Set(family.urls.map((url) => new URL(url).host))].sort();
      for (const id of family.ids) {
        const calls: FetchCall[] = [];
        await probeProviderUsage({ fetch: queueFetch(family.responses(), calls) }, id, "key-123");
        expect(calls.map((call) => call.url), id).toEqual([...family.urls]);
        expect([...(usageProbeHosts(id) ?? [])].sort(), id).toEqual(expectedHosts);
      }
    }
    expect(usageProbeHosts("anthropic")).toBeNull();
  });

  test("an unmapped provider is absent + no-probe with zero outbound requests", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage({ fetch: stubFetch(json(200, {}), calls) }, "anthropic", "sk-test");
    expect(snapshot).toMatchObject({ status: "absent", limits: [], absentCause: "no-probe" });
    expect(calls).toHaveLength(0);
  });
});

// --- shared failure vocabulary ---

describe("failure classification", () => {
  const cases: Array<{ name: string; response: Response | Error; status: string; cause?: string }> = [
    { name: "401 → unauthorized", response: json(401, {}), status: "unauthorized" },
    { name: "403 → unauthorized", response: json(403, {}), status: "unauthorized" },
    { name: "404 → absent (probe ran, account has no plan row)", response: json(404, {}), status: "absent", cause: "reported-nothing" },
    { name: "500 → error", response: json(500, { balance: 1 }), status: "error" },
    { name: "unparseable JSON → error", response: new Response("<html>gateway</html>", { status: 200 }), status: "error" },
    { name: "no recognizable limit → error", response: json(200, { unexpected: true }), status: "error" },
    { name: "transport failure → error", response: new Error("fetch failed"), status: "error" },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fetchImpl: UsageDeps["fetch"] =
        testCase.response instanceof Error
          ? (async () => {
              throw testCase.response;
            }) as unknown as UsageDeps["fetch"]
          : stubFetch(testCase.response);
      const snapshot = await probeProviderUsage({ fetch: fetchImpl }, "hyper", "key-123");
      expect(snapshot.status).toBe(testCase.status as never);
      expect(snapshot.limits).toEqual([]);
      if (testCase.cause !== undefined) expect(snapshot.absentCause).toBe(testCase.cause as never);
      else expect(snapshot.absentCause).toBeUndefined();
    });
  }
});

// --- bounded transport ---
//
// These two cases pin the platform clock ON PURPOSE: the production bound is
// `AbortSignal.timeout` around a real fetch, and fake timers do not drive that
// signal, so the only faithful reproduction is a real (single-digit-ms) wait.

/**
 * Answers only when the caller's budget aborts the wait — the behavior a real
 * fetch has under `AbortSignal.timeout`, so a hung vendor cannot hang a probe.
 */
function hungFetch(calls: FetchCall[] = []): UsageDeps["fetch"] {
  return ((input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    return promise;
  }) as UsageDeps["fetch"];
}

/** Resolves `body` after `ms`. `honorAbort: false` models a vendor whose answer
 *  arrives late anyway — only the read's own budget can cut that wait short. */
function timedJson(
  body: unknown,
  ms: number,
  opts: { honorAbort?: boolean; calls?: FetchCall[] } = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    opts.calls?.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const timer = setTimeout(() => resolve(json(200, body)), ms);
    if (opts.honorAbort !== false) {
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    }
    return await promise;
  };
}

describe("bounded transport", () => {
  test("a vendor that never answers resolves to an error snapshot within the probe's budget", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage({ fetch: hungFetch(calls), timeoutMs: 5 }, "hyper", "key-123");
    expect(snapshot.status).toBe("error");
    expect(snapshot.limits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("Command Code's two GETs share ONE budget — a slow whoami leaves no fresh window for credits", async () => {
    const calls: FetchCall[] = [];
    // whoami answers LATE (past the shared deadline) and ignores the abort
    // signal; the credits read then has ~1 ms left while its answer needs 5 ms.
    // An implementation that reset the budget per request would accept it.
    const fetchImpl: UsageDeps["fetch"] = (async (input, init) =>
      calls.length === 0
        ? timedJson({ user: { id: "user-1" } }, 25, { honorAbort: false, calls })(input, init)
        : timedJson({ data: { credits: { monthlyCredits: 10 } } }, 5, { calls })(input, init)) as UsageDeps["fetch"];
    const snapshot = await probeProviderUsage({ fetch: fetchImpl, timeoutMs: 10 }, "commandcode", "cc-key");
    expect(snapshot.status).toBe("error");
    // whoami + one credits attempt, never a retry that spends a second budget.
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.commandcode.ai/alpha/whoami",
      "https://api.commandcode.ai/alpha/billing/credits",
    ]);
  });
});

// --- credential origin ---

describe("credential origin", () => {
  /** A 2xx whose reported FINAL URL is `url` — what a real fetch always reports. */
  function responseFrom(url: string, body: unknown): Response {
    const response = json(200, body);
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  test("a 30x is classified as error and the credential is never replayed", async () => {
    const calls: FetchCall[] = [];
    const redirect = new Response(null, { status: 302, headers: { Location: "https://evil.example/usage" } });
    const snapshot = await probeProviderUsage({ fetch: stubFetch(redirect, calls) }, "hyper", "key-123");
    expect(snapshot.status).toBe("error");
    expect(snapshot.reason).toBe("http 302");
    expect(snapshot.limits).toEqual([]);
    // The transport is told NOT to follow, so no request reaches the target.
    expect(calls[0]!.redirect).toBe("manual");
  });

  test("Command Code's first GET redirecting stops the second request", async () => {
    const calls: FetchCall[] = [];
    const redirect = new Response(null, { status: 307, headers: { Location: "https://evil.example/whoami" } });
    const snapshot = await probeProviderUsage({ fetch: stubFetch(redirect, calls) }, "commandcode", "cc-key");
    expect(snapshot.status).toBe("error");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe("manual");
  });

  test("a 2xx that arrived from another origin is refused before its body is read", async () => {
    const snapshot = await probeProviderUsage(
      { fetch: stubFetch(responseFrom("https://evil.example/usage", { balance: 5 })) },
      "hyper",
      "key-123",
    );
    expect(snapshot.status).toBe("error");
    expect(snapshot.reason).toBe("redirected off origin");
    expect(snapshot.limits).toEqual([]);
  });

  test("a 2xx from the requested origin still parses", async () => {
    const snapshot = await probeProviderUsage(
      { fetch: stubFetch(responseFrom("https://hyper.charm.land/credits", { balance: 5 })) },
      "hyper",
      "key-123",
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      { id: "hyper:balance", kind: "balance", remaining: 5, unit: "credits", shared: true },
    ]);
  });
});

// --- family: commandcode ---

describe("commandcode", () => {
  const whoami = json(200, { user: { id: "user-1" }, org: { id: "org-9" } });
  const credits = json(200, {
    data: {
      credits: { monthlyCredits: 100, purchasedCredits: 20, freeCredits: 5 },
      windowLimits: {
        fiveHour: { used: 30, cap: 100, resetAt: 1_760_000_000 },
        weekly: { used: 250, cap: 500, resetAt: 1_760_604_800 },
      },
    },
  });

  test("reads whoami then the org credit pool: windows + balance", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      { fetch: queueFetch([whoami, credits], calls) },
      "commandcode-anthropic",
      "cc-key",
    );
    expect(calls[0]!.url).toBe("https://api.commandcode.ai/alpha/whoami");
    expect(calls[0]!.headers.authorization).toBe("Bearer cc-key");
    expect(calls[1]!.url).toBe("https://api.commandcode.ai/alpha/billing/credits?orgId=org-9");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      {
        id: "commandcode:session",
        kind: "window",
        usedFraction: 0.3,
        unit: "credits",
        resetsAt: 1_760_000_000_000,
        limit: 100,
      },
      {
        id: "commandcode:week",
        kind: "window",
        usedFraction: 0.5,
        unit: "credits",
        resetsAt: 1_760_604_800_000,
        limit: 500,
      },
      { id: "commandcode:balance", kind: "balance", remaining: 125, unit: "credits", shared: true },
    ]);
  });

  test("a balance-only (pay-as-you-go) account yields one balance limit, never a window", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      { fetch: queueFetch([json(200, { user: { id: "user-1" } }), json(200, { data: { credits: { monthlyCredits: 42 } } })], calls) },
      "commandcode",
      "cc-key",
    );
    expect(calls[1]!.url).toBe("https://api.commandcode.ai/alpha/billing/credits");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      { id: "commandcode:balance", kind: "balance", remaining: 42, unit: "credits", shared: true },
    ]);
  });

  test("a negative used count drops that window instead of rendering 0 %", async () => {
    const snapshot = await probeProviderUsage(
      {
        fetch: queueFetch([
          json(200, { user: { id: "user-1" } }),
          json(200, {
            data: {
              credits: { monthlyCredits: 10 },
              windowLimits: {
                fiveHour: { used: -5, cap: 100, resetAt: 1_760_000_000 },
                weekly: { used: 250, cap: 500, resetAt: 1_760_604_800 },
              },
            },
          }),
        ]),
      },
      "commandcode",
      "cc-key",
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.map((limit) => limit.id)).toEqual(["commandcode:week", "commandcode:balance"]);
  });

  test("a present-but-unreadable credit component drops the whole balance instead of zero-filling it", async () => {
    const snapshot = await probeProviderUsage(
      {
        fetch: queueFetch([
          json(200, { user: { id: "user-1" } }),
          json(200, { data: { credits: { monthlyCredits: 100, purchasedCredits: "not-a-number", freeCredits: 5 } } }),
        ]),
      },
      "commandcode",
      "cc-key",
    );
    // 105 would be a total the payload never stated: the balance is dropped.
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.status).toBe("error");

    // The drop is scoped to the balance limit — the account's windows still
    // render instead of the whole snapshot collapsing.
    const withWindows = await probeProviderUsage(
      {
        fetch: queueFetch([
          json(200, { user: { id: "user-1" } }),
          json(200, {
            data: {
              credits: { monthlyCredits: 100, purchasedCredits: "not-a-number" },
              windowLimits: { weekly: { used: 250, cap: 500 } },
            },
          }),
        ]),
      },
      "commandcode",
      "cc-key",
    );
    expect(withWindows.status).toBe("ok");
    expect(withWindows.limits.map((limit) => limit.id)).toEqual(["commandcode:week"]);
  });

  test("a rejected credential on whoami is unauthorized", async () => {
    const snapshot = await probeProviderUsage({ fetch: stubFetch(json(401, {})) }, "commandcode", "cc-key");
    expect(snapshot.status).toBe("unauthorized");
  });
});

// --- family: opencode-go ---

describe("opencode-go", () => {
  test("keeps the rolling and weekly windows and drops the monthly bucket", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            usage: {
              rolling: { percent: 32, status: "ok", resetsAt: "2026-11-05T10:00:00.000Z" },
              weekly: { percent: 80, status: "rate-limited", resetsAt: "2026-11-10T10:00:00.000Z" },
              monthly: { percent: 10, status: "ok", resetsAt: "2026-12-01T00:00:00.000Z" },
            },
          }),
          calls,
        ),
      },
      "opencode-go",
      "zen-key",
    );
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(calls[0]!.headers.authorization).toBe("Bearer zen-key");
    expect(snapshot.limits).toEqual([
      {
        id: "opencode-go:session",
        kind: "window",
        usedFraction: 0.32,
        unit: "percent",
        resetsAt: Date.parse("2026-11-05T10:00:00.000Z"),
      },
      {
        id: "opencode-go:week",
        kind: "window",
        usedFraction: 1,
        unit: "percent",
        resetsAt: Date.parse("2026-11-10T10:00:00.000Z"),
      },
    ]);
  });
});

// --- family: zai / zhipuai ---

describe("zai / zhipuai", () => {
  test("maps hour/week units to windows, sends the key verbatim, and drops the month bucket", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            success: true,
            data: {
              limits: [
                { type: "TIME_LIMIT", unit: 3, number: 5, currentValue: 120, usage: 600, remaining: 480, nextResetTime: 1_760_000_000 },
                { type: "TIME_LIMIT", unit: 6, number: 1, currentValue: 300, usage: 1000, nextResetTime: 1_760_604_800 },
                { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 5, usage: 10, nextResetTime: 1_762_000_000 },
              ],
            },
          }),
          calls,
        ),
      },
      "zai-coding-plan",
      "zai-key",
    );
    expect(calls[0]!.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(calls[0]!.headers.authorization).toBe("zai-key");
    expect(snapshot.limits).toEqual([
      {
        id: "zai:session",
        kind: "window",
        usedFraction: 0.2,
        unit: "requests",
        resetsAt: 1_760_000_000_000,
        limit: 600,
        remaining: 480,
      },
      {
        id: "zai:week",
        kind: "window",
        usedFraction: 0.3,
        unit: "requests",
        resetsAt: 1_760_604_800_000,
        limit: 1000,
      },
    ]);
  });

  test("zhipuai ids use the bigmodel host and fall back to the rounded percentage", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            success: true,
            data: {
              limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40, nextResetTime: 1_760_000_000 }],
            },
          }),
          calls,
        ),
      },
      "zhipuai",
      "zp-key",
    );
    expect(calls[0]!.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(snapshot.limits).toEqual([
      {
        id: "zai:session",
        kind: "window",
        usedFraction: 0.4,
        unit: "tokens",
        resetsAt: 1_760_000_000_000,
      },
    ]);
  });

  test("the documented auth failure (body code 401) is unauthorized; other non-success codes stay error", async () => {
    const rejected = await probeProviderUsage(
      { fetch: stubFetch(json(200, { success: false, code: 401, msg: "Authorization Token illegal" })) },
      "zai",
      "zai-key",
    );
    expect(rejected.status).toBe("unauthorized");
    expect(rejected.limits).toEqual([]);

    // 500 + "no coding plan" is ACCOUNT state, not a rejected credential.
    const noPlan = await probeProviderUsage(
      { fetch: stubFetch(json(200, { success: false, code: 500, msg: "no coding plan" })) },
      "zai",
      "zai-key",
    );
    expect(noPlan.status).toBe("error");
    expect(noPlan.reason).toContain("500");
  });
});

// --- family: minimax-code ---

describe("minimax-code", () => {
  const payload = json(200, {
    base_resp: { status_code: 0 },
    model_remains: [
      {
        model_name: "general",
        start_time: 1_760_000_000,
        end_time: 1_760_018_000,
        current_interval_remaining_percent: 25,
        current_interval_status: 1,
        current_weekly_remaining_percent: 60,
        weekly_end_time: 1_760_604_800,
        current_weekly_status: 1,
      },
      {
        // Not in the plan: both windows unlimited with zero totals.
        model_name: "video",
        current_interval_total_count: 0,
        current_weekly_total_count: 0,
        current_interval_status: 3,
        current_weekly_status: 3,
      },
    ],
  });

  test("interval + weekly windows from the remaining percentages; unavailable buckets skipped", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      { fetch: stubFetch(payload, calls) },
      "minimax-coding-plan",
      "mm-key",
    );
    expect(calls[0]!.url).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(calls[0]!.headers.authorization).toBe("Bearer mm-key");
    expect(snapshot.limits).toEqual([
      {
        id: "minimax:session",
        kind: "window",
        usedFraction: 0.75,
        unit: "percent",
        resetsAt: 1_760_018_000_000,
      },
      {
        id: "minimax:week",
        kind: "window",
        usedFraction: 0.4,
        unit: "percent",
        resetsAt: 1_760_604_800_000,
      },
    ]);
  });

  test("the CN id probes the CN host; an exhausted status outranks a stale percent", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            base_resp: { status_code: 0 },
            model_remains: [
              {
                model_name: "general",
                start_time: 1_760_000_000,
                end_time: 1_760_018_000,
                current_interval_remaining_percent: 90,
                current_interval_status: 2,
                current_weekly_remaining_percent: 60,
                weekly_end_time: 1_760_604_800,
                current_weekly_status: 1,
              },
            ],
          }),
          calls,
        ),
      },
      "minimax-cn-coding-plan",
      "mm-key",
    );
    expect(calls[0]!.url).toBe("https://api.minimaxi.com/v1/token_plan/remains");
    expect(snapshot.limits[0]).toMatchObject({ id: "minimax:session", usedFraction: 1 });
  });

  test("a documented auth status_code is unauthorized; any other non-zero code is an error", async () => {
    // platform.minimax.io documents 1004 (not authorized) and 2049 (invalid
    // API key) as the CREDENTIAL's verdict — the dialog must say "key rejected",
    // not "could not read".
    for (const statusCode of [1004, 2049]) {
      const rejected = await probeProviderUsage(
        { fetch: stubFetch(json(200, { base_resp: { status_code: statusCode }, model_remains: [] })) },
        "minimax-coding-plan",
        "mm-key",
      );
      expect(rejected.status, String(statusCode)).toBe("unauthorized");
      expect(rejected.limits).toEqual([]);
      expect(rejected.reason, String(statusCode)).toContain(String(statusCode));
    }
    // 1002 is a rate-limit code: a service failure, never a rejected key.
    const failed = await probeProviderUsage(
      { fetch: stubFetch(json(200, { base_resp: { status_code: 1002 }, model_remains: [] })) },
      "minimax-coding-plan",
      "mm-key",
    );
    expect(failed.status).toBe("error");
    expect(failed.reason).toContain("1002");
  });
});

// --- family: cline-pass ---

describe("cline-pass", () => {
  test("sends the desktop headers and keeps the 5h / weekly / monthly windows", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            success: true,
            data: {
              limits: [
                { type: "five_hour", percentUsed: 12, resetsAt: "2026-11-05T10:00:00.000Z" },
                { type: "weekly", percentUsed: 45, resetsAt: "2026-11-10T00:00:00.000Z" },
                { type: "monthly", percentUsed: 70, resetsAt: "2026-12-01T00:00:00.000Z" },
              ],
            },
          }),
          calls,
        ),
      },
      "cline-pass",
      "cline-key",
    );
    expect(calls[0]!.url).toBe("https://api.cline.bot/api/v1/users/me/plan/usage-limits");
    expect(calls[0]!.headers.authorization).toBe("Bearer cline-key");
    expect(calls[0]!.headers["x-client-type"]).toBe("cline-desktop");
    expect(calls[0]!.headers["user-agent"]).toBe("Cline/3.5.54");
    expect(snapshot.limits).toEqual([
      { id: "cline-pass:session", kind: "window", usedFraction: 0.12, unit: "percent", resetsAt: Date.parse("2026-11-05T10:00:00.000Z") },
      { id: "cline-pass:week", kind: "window", usedFraction: 0.45, unit: "percent", resetsAt: Date.parse("2026-11-10T00:00:00.000Z") },
      { id: "cline-pass:month", kind: "window", usedFraction: 0.7, unit: "percent", resetsAt: Date.parse("2026-12-01T00:00:00.000Z") },
    ]);
  });

  test("404 is absent (no ClinePass on this account), not a failed read", async () => {
    const snapshot = await probeProviderUsage({ fetch: stubFetch(json(404, {})) }, "cline-pass", "cline-key");
    expect(snapshot).toMatchObject({ status: "absent", absentCause: "reported-nothing" });
  });
});

// --- family: synthetic ---

describe("synthetic", () => {
  test("rolling 5h requests plus the weekly USD pool, both account-wide", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            rollingFiveHourLimit: { remaining: 60, max: 200, limited: false, nextTickAt: "2026-11-05T09:30:00.000Z" },
            weeklyTokenLimit: {
              remainingCredits: "$12.50",
              maxCredits: "$50.00",
              percentRemaining: 25,
              nextRegenAt: "2026-11-12T00:00:00.000Z",
            },
          }),
          calls,
        ),
      },
      "synthetic",
      "syn-key",
    );
    expect(calls[0]!.url).toBe("https://api.synthetic.new/v2/quotas");
    expect(calls[0]!.headers.authorization).toBe("Bearer syn-key");
    expect(snapshot.limits).toEqual([
      {
        id: "synthetic:session",
        kind: "window",
        usedFraction: 0.7,
        unit: "requests",
        shared: true,
        resetsAt: Date.parse("2026-11-05T09:30:00.000Z"),
        limit: 200,
        remaining: 60,
      },
      {
        id: "synthetic:week",
        kind: "window",
        usedFraction: 0.75,
        unit: "usd",
        shared: true,
        resetsAt: Date.parse("2026-11-12T00:00:00.000Z"),
        limit: 50,
        remaining: 12.5,
      },
    ]);
  });
});

// --- family: umans ---

describe("umans", () => {
  test("weighted request window plus the concurrency ceiling", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            limits: { requests: { limit: 1000, hard_cap: 1500, window_seconds: 18000 }, concurrency: { limit: 4 } },
            usage: {
              requests_in_window: 400,
              remaining_requests: 600,
              weighted_in_window: 250,
              weighted_remaining_requests: 750,
              concurrent_sessions: 2,
            },
            window: { resets_at: "2026-11-05T10:00:00.000Z" },
          }),
          calls,
        ),
      },
      "umans",
      "umans-key",
    );
    expect(calls[0]!.url).toBe("https://api.code.umans.ai/v1/usage");
    expect(snapshot.limits).toEqual([
      {
        id: "umans:session",
        kind: "window",
        usedFraction: 0.25,
        unit: "requests",
        resetsAt: Date.parse("2026-11-05T10:00:00.000Z"),
        limit: 1000,
        remaining: 750,
      },
      { id: "umans:concurrency", kind: "window", usedFraction: 0.5, unit: "requests", limit: 4 },
    ]);
  });
});

// --- family: charm-hyper ---

describe("hyper", () => {
  test("a balance-only account yields one credits balance, shared across keys", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage({ fetch: stubFetch(json(200, { balance: 95 }), calls) }, "hyper", "hyper-key");
    expect(calls[0]!.url).toBe("https://hyper.charm.land/credits");
    expect(calls[0]!.headers.authorization).toBe("Bearer hyper-key");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      { id: "hyper:balance", kind: "balance", remaining: 95, unit: "credits", shared: true },
    ]);
  });
});

// --- family: kimi-for-coding ---
describe("kimi-for-coding", () => {
  test("aggregate weekly window plus limits[] classified by span, tighter wins", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            usage: { limit: "1000", used: "250", resetTime: "2026-11-10T00:00:00.000Z" },
            limits: [
              { window: { duration: "300", time_unit: "minute" }, detail: { limit: "200", used: "50", resetTime: "2026-11-05T10:00:00.000Z" } },
              { window: { duration: "12", time_unit: "hour" }, detail: { limit: "500", remaining: "100", resetTime: "2026-11-06T00:00:00.000Z" } },
              { window: { duration: "1", time_unit: "month" }, detail: { limit: "900", used: "100" } },
            ],
          }),
          calls,
        ),
      },
      "kimi-for-coding",
      "kimi-key",
    );
    expect(calls[0]!.url).toBe("https://api.kimi.com/coding/v1/usages");
    expect(calls[0]!.headers.authorization).toBe("Bearer kimi-key");
    expect(snapshot.limits).toEqual([
      {
        id: "kimi:week",
        kind: "window",
        usedFraction: 0.25,
        unit: "requests",
        resetsAt: Date.parse("2026-11-10T00:00:00.000Z"),
        limit: 1000,
      },
      {
        // Both 5h and 12h rows classify as the session window; the tighter
        // (12h, remaining-derived 400/500) wins.
        id: "kimi:session",
        kind: "window",
        usedFraction: 0.8,
        unit: "requests",
        resetsAt: Date.parse("2026-11-06T00:00:00.000Z"),
        limit: 500,
      },
    ]);
  });
});

// --- family: cursor ---

describe("cursor", () => {
  test("one window per readable bucket: request counts and USD spend, payload-wide reset", async () => {
    const calls: FetchCall[] = [];
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            "gpt-4": { numRequests: 150, maxRequestUsage: 500 },
            planUsage: { used: 15.5, limit: 20 },
            "usd-custom": { amountUsed: 45, amountLimit: 50 },
            startOfMonth: "2026-07-01T00:00:00.000Z",
          }),
          calls,
        ),
      },
      "cursor",
      "cur-key",
    );
    expect(calls[0]!.url).toBe("https://api2.cursor.sh/auth/usage");
    expect(calls[0]!.headers.authorization).toBe("Bearer cur-key");
    // Every read asks for JSON, so an HTML error page is never parsed as usage.
    expect(calls[0]!.headers.accept).toBe("application/json");
    expect(snapshot.status).toBe("ok");
    // One month after `startOfMonth`, stated once for the whole account.
    const resetsAt = Date.UTC(2026, 7, 1);
    expect(snapshot.limits).toEqual([
      { id: "cursor:requests:gpt-4", kind: "window", usedFraction: 0.3, unit: "requests", limit: 500, resetsAt },
      { id: "cursor:usd:planusage", kind: "window", usedFraction: 0.775, unit: "usd", limit: 20, resetsAt },
      { id: "cursor:usd:usd-custom", kind: "window", usedFraction: 0.9, unit: "usd", limit: 50, resetsAt },
    ]);
  });

  test("an uncapped, empty or unreadable bucket yields no limit — never an uncapped bar", async () => {
    const snapshot = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            // Current plans report no legacy cap on the request bucket.
            "gpt-4": { numRequests: 12, maxRequestUsage: null },
            empty: {},
            garbled: { numRequests: "n/a", maxRequestUsage: 100 },
            sonnet: { used: 1, limit: 4 },
          }),
        ),
      },
      "cursor",
      "cur-key",
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      { id: "cursor:requests:sonnet", kind: "window", usedFraction: 0.25, unit: "requests", limit: 4 },
    ]);
  });

  test("a rejected credential is unauthorized; a 404 is absent", async () => {
    const rejected = await probeProviderUsage({ fetch: stubFetch(json(401, {})) }, "cursor", "cur-key");
    expect(rejected.status).toBe("unauthorized");
    expect(rejected.limits).toEqual([]);

    const missing = await probeProviderUsage({ fetch: stubFetch(json(404, {})) }, "cursor", "cur-key");
    expect(missing.status).toBe("absent");
    expect(missing.absentCause).toBe("reported-nothing");
    expect(missing.limits).toEqual([]);
  });
});

// --- shared flag scope ---

describe("shared flag scope", () => {
  test("a per-key family window carries no shared flag; Synthetic's two pools do", async () => {
    const umans = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, { limits: { requests: { limit: 100 } }, usage: { requests_in_window: 10 } }),
        ),
      },
      "umans",
      "umans-key",
    );
    expect(umans.limits).toHaveLength(1);
    expect("shared" in umans.limits[0]!).toBe(false);

    const synthetic = await probeProviderUsage(
      {
        fetch: stubFetch(
          json(200, {
            rollingFiveHourLimit: { remaining: 1, max: 2 },
            weeklyTokenLimit: { remainingCredits: "$1.00", maxCredits: "$4.00" },
          }),
        ),
      },
      "synthetic",
      "syn-key",
    );
    expect(synthetic.limits.map((limit) => limit.shared)).toEqual([true, true]);
  });
});
