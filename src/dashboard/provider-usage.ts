/**
 * Per-key usage probing for the App settings provider list.
 *
 * The settings save route verifies a key once; this module answers the other
 * question — "is this key still accepted, and how much of its allowance is
 * left" — by reading the vendor's own quota/billing endpoint with that key.
 * It mirrors `provider-verify.ts`: an injected fetch, the same 10 s budget, a
 * closed outcome vocabulary (`ok | absent | unauthorized | error`), and no
 * import from pipeline/review code. Every request is a GET; nothing here may
 * reach an inference endpoint.
 *
 * Two limit shapes, because the wire has two:
 *   - `window`  — a metered allowance (used fraction, optional counts/reset)
 *   - `balance` — a bare remaining amount (credits/USD); forcing a balance into
 *                 a percentage would fabricate a total the vendor never stated
 * A missing or unusable counter DROPS its limit instead of rendering 0 %, and
 * a rejected credential is `unauthorized`, never a healthy bar.
 *
 * Catalog id → family. An unmapped id is `absent` + `no-probe` and NEVER a
 * guessed endpoint: the probe set is exactly ten families over fifteen catalog
 * ids, listed below as twelve rows because the Z.AI/Zhipuai and MiniMax
 * intl/CN families split by host.
 *
 * | catalog ids                                                        | endpoint (auth)                                                        | limits |
 * |--------------------------------------------------------------------|------------------------------------------------------------------------|--------|
 * | commandcode, commandcode-anthropic                                 | GET …/alpha/whoami then …/alpha/billing/credits (Bearer)               | fiveHour/weekly windows + credit balance (org pool when whoami names one) |
 * | opencode-go                                                        | GET https://opencode.ai/zen/go/v1/usage (Bearer)                       | usage.rolling / usage.weekly |
 * | zai, zai-coding-plan                                               | GET https://api.z.ai/api/monitor/usage/quota/limit (key verbatim)      | hour/week-unit limits |
 * | zhipuai, zhipuai-coding-plan                                       | GET https://open.bigmodel.cn/api/monitor/usage/quota/limit (verbatim)  | hour/week-unit limits |
 * | minimax-coding-plan                                                | GET https://api.minimax.io/v1/token_plan/remains (Bearer)              | model_remains interval + weekly |
 * | minimax-cn-coding-plan                                             | GET https://api.minimaxi.com/v1/token_plan/remains (Bearer)            | model_remains interval + weekly |
 * | cline-pass                                                         | GET https://api.cline.bot/api/v1/users/me/plan/usage-limits (Bearer + desktop headers) | limits[] 5h/weekly/monthly |
 * | synthetic                                                          | GET https://api.synthetic.new/v2/quotas (Bearer)                       | rolling 5h requests + weekly USD |
 * | umans                                                              | GET https://api.code.umans.ai/v1/usage (Bearer)                        | rolling request window + concurrency |
 * | hyper                                                              | GET https://hyper.charm.land/credits (Bearer)                          | credit balance |
 * | kimi-for-coding                                                    | GET https://api.kimi.com/coding/v1/usages (Bearer)                     | aggregate weekly + limits[] by span |
 * | cursor                                                             | GET https://api2.cursor.sh/auth/usage (Bearer)                         | one window per bucket (requests, or USD for spend buckets) |
 *
 * Failure reasons are structured and never a raw vendor string. `absent` also
 * carries its cause: `no-probe` (unmapped id) vs `reported-nothing` (the vendor
 * answered 404 — the probe ran, the account has nothing to meter).
 */

import { VERIFY_TIMEOUT_MS, VERIFY_USER_AGENT, type VerifyFetch } from "./provider-verify";

/** Probe outcome vocabulary (closed: callers render exactly these four faces). */
export type UsageStatus = "ok" | "absent" | "unauthorized" | "error";

/** One normalized limit. Window and balance limits share the wire shape so the
 *  dialog has one list to render. */
export type UsageLimit = {
  /** Stable per family, e.g. `commandcode:session`, `hyper:balance`. */
  id: string;
  kind: "window" | "balance";
  /** Window only: share of the window consumed, 0..1. */
  usedFraction?: number;
  /** Balance amount, or a window's remaining count when the vendor states it. */
  remaining?: number;
  limit?: number;
  unit: "percent" | "requests" | "credits" | "usd" | "tokens";
  /** Epoch milliseconds. */
  resetsAt?: number;
  /** One account-wide pool behind several stored keys. */
  shared?: boolean;
};

/** Result of one probe. `reason` is diagnostic only, never rendered verbatim. */
export type UsageSnapshot = {
  status: UsageStatus;
  fetchedAt: number;
  limits: UsageLimit[];
  reason?: string;
  absentCause?: "no-probe" | "reported-nothing";
};

/** Probe deps (injected for tests): outbound fetch + timeout override. */
export type UsageDeps = {
  fetch: VerifyFetch;
  /** Budget for the whole probe; defaults to VERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A span under a day is the session window; longer spans are the weekly pool. */
const SESSION_MAX_MS = DAY_MS;

// --- shared normalizers (pure; no clock, network or key state) ---

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Numbers arrive as numbers or numeric strings depending on the endpoint. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Used percentage (0..100, may exceed) → used fraction. A negative count is not
 * "0 % used" — it is a payload we cannot interpret, so it yields `undefined`
 * and the caller drops that limit instead of printing a fake bar.
 */
export function fractionFromUsed(usedPercent: number): number | undefined {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  return Math.min(1, usedPercent / 100);
}

/** Used/limit counter pair → used fraction; `undefined` when unusable. */
export function fractionFromCounts(used: number | undefined, limit: number | undefined): number | undefined {
  // A negative used count (remaining above the limit) is not "0 % used": drop
  // the window instead of rendering a fake empty bar.
  if (used === undefined || limit === undefined || limit <= 0 || used < 0) return undefined;
  return Math.min(1, used / limit);
}

/**
 * Lenient absolute reset-time normalizer across the aliases vendors return:
 * epoch seconds, epoch milliseconds, an ISO string, or a numeric string of
 * either epoch form. An unparseable value is `undefined`.
 */
export function resetFrom(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    // Epoch milliseconds passed 1e12 in 2001; anything below that is seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const iso = Date.parse(value);
    if (Number.isFinite(iso)) return iso > 0 ? iso : undefined;
    return resetFrom(toNumber(value));
  }
  return undefined;
}

/** Relative-delay alias (milliseconds from now) → absolute epoch milliseconds. */
function resetAfterMs(ms: number | undefined): number | undefined {
  return ms === undefined || ms <= 0 ? undefined : Date.now() + ms;
}

/** Reset time across one row's alias keys. */
function resetOf(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = resetFrom(row[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** The first alias that reads as a number; unreadable values fall through. */
function firstNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = toNumber(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Span classification: under a day is the session window, longer is the week. */
function windowIdForSpan(spanMs: number): "session" | "week" {
  return spanMs < SESSION_MAX_MS ? "session" : "week";
}

/** Duration + unit pair (hours/days/weeks/minutes) → span in milliseconds. */
function spanFromDuration(duration: number | undefined, unit: string): number | undefined {
  if (duration === undefined || duration <= 0 || unit.length === 0) return undefined;
  const upper = unit.toUpperCase();
  if (upper.includes("MINUTE")) return duration * 60_000;
  if (upper.includes("HOUR")) return duration * HOUR_MS;
  if (upper.includes("DAY")) return duration * DAY_MS;
  if (upper.includes("WEEK")) return duration * WEEK_MS;
  if (upper.includes("SECOND")) return duration * 1000;
  return undefined;
}

// --- limit builders ---

function windowLimit(args: {
  id: string;
  usedFraction: number;
  unit: UsageLimit["unit"];
  resetsAt?: number;
  limit?: number;
  remaining?: number;
  /** Only where the vendor states one account-wide pool behind every key. */
  shared?: boolean;
}): UsageLimit {
  // Absent fields are omitted, not emitted as `undefined` keys.
  return {
    id: args.id,
    kind: "window",
    usedFraction: args.usedFraction,
    unit: args.unit,
    ...(args.shared === true ? { shared: true } : {}),
    ...(args.resetsAt !== undefined ? { resetsAt: args.resetsAt } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.remaining !== undefined ? { remaining: args.remaining } : {}),
  };
}

/** Keep the most-binding limit per id: several model buckets share one plan pool. */
function keepTighter(limits: Map<string, UsageLimit>, next: UsageLimit): void {
  const current = limits.get(next.id);
  if (current === undefined || (next.usedFraction ?? 0) > (current.usedFraction ?? 0)) {
    limits.set(next.id, next);
  }
}

// --- one classified GET ---

/** One probe's view of the transport plus its shared budget. */
type ProbeInput = { fetch: VerifyFetch; deadline: number };

/** The failure classes a read can produce (never `ok`). */
type QuotaReadFailure = Exclude<UsageStatus, "ok">;

/** A parsed 2xx body, or the classified reason the read produced nothing. */
type QuotaRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: QuotaReadFailure; reason: string };

/** The origin a URL names; `undefined` when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * GET `url` and classify the response into the shared vocabulary, so every
 * family means the same thing by 401/403, 404, transport failure and an
 * unparseable body. Never throws; never logs the key. The credential only ever
 * travels to `url`'s origin: a 3xx is never followed and a 2xx that reports a
 * different final origin is refused.
 */
async function readQuotaJson(
  input: ProbeInput,
  url: string,
  headers: Record<string, string>,
): Promise<QuotaRead> {
  try {
    // One budget per probe: Command Code's two sequential GETs share it.
    const budgetMs = Math.max(1, input.deadline - Date.now());
    const response = await input.fetch(url, {
      headers: { accept: "application/json", "user-agent": VERIFY_USER_AGENT, ...headers },
      // A redirect is never followed: `manual` hands any 3xx to the classifier
      // below instead of replaying the Authorization header at another origin.
      redirect: "manual",
      signal: AbortSignal.timeout(budgetMs),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: "unauthorized", reason: `http ${response.status}` };
    }
    // The vendor answered "nothing here": the probe ran, the account has no
    // plan/quota row to meter.
    if (response.status === 404) return { ok: false, status: "absent", reason: "http 404" };
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: "error", reason: `http ${response.status}` };
    }
    // Defense in depth for redirects a transparent proxy still performs: a 2xx
    // whose FINAL URL is on another origin never has its body read. An empty
    // `response.url` means the platform reported none (a synthetic response),
    // which is not evidence of a redirect.
    if (response.url !== "" && originOf(response.url) !== originOf(url)) {
      return { ok: false, status: "error", reason: "redirected off origin" };
    }
    const body: unknown = await response.json();
    const record = asRecord(body);
    if (record === undefined) return { ok: false, status: "error", reason: "non-object body" };
    return { ok: true, body: record };
  } catch {
    return { ok: false, status: "error", reason: "request failed" };
  }
}

function failureSnapshot(read: Extract<QuotaRead, { ok: false }>, fetchedAt: number): UsageSnapshot {
  return {
    status: read.status,
    fetchedAt,
    limits: [],
    reason: read.reason,
    ...(read.status === "absent" ? { absentCause: "reported-nothing" as const } : {}),
  };
}

/**
 * Build the snapshot from a classified read. An extractor returns either the
 * limits or a reason string; an empty result is a parse failure, never an
 * `ok` with zero bars.
 */
function snapshotFromRead(
  read: QuotaRead,
  extract: (body: Record<string, unknown>) => UsageLimit[] | string,
): UsageSnapshot {
  const fetchedAt = Date.now();
  if (!read.ok) return failureSnapshot(read, fetchedAt);
  const extracted = extract(read.body);
  if (typeof extracted === "string") return { status: "error", fetchedAt, limits: [], reason: extracted };
  if (extracted.length === 0) {
    return { status: "error", fetchedAt, limits: [], reason: "unrecognized usage payload" };
  }
  return { status: "ok", fetchedAt, limits: extracted };
}

/**
 * A 2xx whose BODY rejects the credential. Vendors that gate the route at the
 * application layer answer 200 and put the verdict in the payload; that verdict
 * is deterministic about the KEY, so it renders as `unauthorized` ("this key was
 * rejected") instead of `error` ("could not read"). Each family passes its own
 * documented code mapping; `undefined` means the body raised no such verdict and
 * the caller continues with normal extraction.
 */
function bodyKeyRejection(
  read: QuotaRead,
  rejectionReason: (body: Record<string, unknown>) => string | undefined,
): UsageSnapshot | undefined {
  if (!read.ok) return undefined;
  const reason = rejectionReason(read.body);
  return reason === undefined ? undefined : { status: "unauthorized", fetchedAt: Date.now(), limits: [], reason };
}

/** One family's probe: GET its endpoint(s), normalize to limits. Never throws
 *  by contract (an escaping throw is caught by probeProviderUsage). */
type UsageProbe = (input: ProbeInput, key: string) => Promise<UsageSnapshot>;

// --- family: commandcode (credits + windows) ---

const COMMANDCODE_ORIGIN = "https://api.commandcode.ai";
const COMMANDCODE_WINDOWS = [
  { key: "fiveHour", id: "session" },
  { key: "weekly", id: "week" },
] as const;

/**
 * One credit component: `undefined` when the field is ABSENT, `null` when it is
 * present but not a finite non-negative number. The distinction matters — an
 * absent component contributes nothing, while an unreadable one makes the
 * account total unknowable.
 */
function creditComponent(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const amount = toNumber(value);
  return amount === undefined || amount < 0 ? null : amount;
}

/**
 * Command Code's inference base is `/provider`, while the account routes sit at
 * the host root — so the origin is a constant, never derived from a base URL.
 * `/alpha/whoami` names the org whose credit pool the CLI reads; without one
 * the personal credits route is the pool.
 */
const commandCodeUsage: UsageProbe = async (input, key) => {
  const auth = { authorization: `Bearer ${key}` };
  const whoamiRead = await readQuotaJson(input, `${COMMANDCODE_ORIGIN}/alpha/whoami`, auth);
  if (!whoamiRead.ok) return failureSnapshot(whoamiRead, Date.now());
  const whoami = asRecord(whoamiRead.body.data) ?? whoamiRead.body;
  const user = asRecord(whoami.user);
  const userId = typeof user?.id === "string" && user.id.length > 0 ? user.id : undefined;
  if (userId === undefined) {
    return { status: "error", fetchedAt: Date.now(), limits: [], reason: "whoami carried no user id" };
  }
  const org = asRecord(whoami.org);
  const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : undefined;
  const creditsUrl =
    `${COMMANDCODE_ORIGIN}/alpha/billing/credits` + (orgId ? `?orgId=${encodeURIComponent(orgId)}` : "");
  const creditsRead = await readQuotaJson(input, creditsUrl, auth);
  return snapshotFromRead(creditsRead, (raw) => {
    // Account routes answer `{ data: … }`; accept an unwrapped body too.
    const body = asRecord(raw.data) ?? raw;
    const limits: UsageLimit[] = [];
    const windowLimits = asRecord(body.windowLimits);
    for (const spec of COMMANDCODE_WINDOWS) {
      const row = asRecord(windowLimits?.[spec.key]);
      if (row === undefined) continue;
      const usedFraction = fractionFromCounts(toNumber(row.used), toNumber(row.cap));
      if (usedFraction === undefined) continue;
      limits.push(
        windowLimit({
          id: `commandcode:${spec.id}`,
          usedFraction,
          unit: "credits",
          resetsAt: resetOf(row, ["resetAt", "reset_at", "resetsAt"]),
          limit: toNumber(row.cap),
        }),
      );
    }
    const credits = asRecord(body.credits);
    if (credits !== undefined) {
      const components = [
        creditComponent(credits.monthlyCredits),
        creditComponent(credits.purchasedCredits),
        creditComponent(credits.freeCredits),
      ];
      // A present-but-unreadable component makes the TOTAL unknowable: summing
      // only the readable ones would publish a partial balance as the account's
      // credits, so the balance limit is dropped whole rather than zero-filling
      // the gap. An absent component legitimately contributes nothing.
      if (components.every((component) => component !== null)) {
        const readable = components.filter((component): component is number => component !== undefined);
        // A pay-as-you-go account has no windowLimits at all: one balance
        // limit, never a fabricated 0 % window.
        if (readable.length > 0) {
          limits.push({
            id: "commandcode:balance",
            kind: "balance",
            remaining: readable.reduce((sum, component) => sum + component, 0),
            unit: "credits",
            shared: true,
          });
        }
      }
    }
    return limits;
  });
};

// --- family: opencode-go ---

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_WINDOWS = [
  { key: "rolling", id: "session" },
  { key: "weekly", id: "week" },
] as const;
// The monthly window anchors on the subscription anniversary, not a 30-day
// span, so it is not a usable week window and is deliberately dropped.

/** `percent` is USED percent; `status: "rate-limited"` outranks it. */
const opencodeGoUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, OPENCODE_GO_USAGE_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const usage = asRecord(body.usage);
    if (usage === undefined) return "no usage object";
    const limits: UsageLimit[] = [];
    for (const spec of OPENCODE_GO_WINDOWS) {
      const row = asRecord(usage[spec.key]);
      if (row === undefined) continue;
      const rateLimited = row.status === "rate-limited";
      const usedFraction = rateLimited ? 1 : fractionFromUsed(toNumber(row.percent) ?? Number.NaN);
      if (usedFraction === undefined) continue;
      limits.push(
        windowLimit({
          id: `opencode-go:${spec.id}`,
          usedFraction,
          unit: "percent",
          resetsAt: resetOf(row, ["resetsAt", "resets_at"]),
        }),
      );
    }
    return limits;
  });
};

// --- family: zai / zhipuai ---

const ZAI_HOST = "https://api.z.ai";
const ZHIPU_HOST = "https://open.bigmodel.cn";
const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
/** Z.AI `unit` enum: 3 = hours, 6 = weeks. Day/month buckets are not windows. */
const ZAI_UNIT_HOURS = 3;
const ZAI_UNIT_WEEKS = 6;

function zaiLimitUnit(type: unknown): UsageLimit["unit"] | undefined {
  if (type === "TOKENS_LIMIT") return "tokens";
  if (type === "CREDIT_LIMIT") return "credits";
  if (type === "TIME_LIMIT") return "requests";
  return undefined;
}

/**
 * Z.AI's documented authentication-failure body code (the bigmodel error table:
 * 401 — token expired or incorrect / "Authorization Token illegal"). Any other
 * non-success code is account or service state — e.g. 500 for "the user has no
 * coding plan" — and stays `error`.
 */
const ZAI_AUTH_FAILURE_CODE = 401;

/**
 * GLM coding-plan quota. The key rides `Authorization` verbatim (no Bearer
 * prefix). `percentage` is a server-rounded USED percent, so the exact counter
 * pair wins when both absolutes are present. The route answers HTTP 200 for an
 * application-level failure, so a body carrying the documented auth code 401 is
 * the CREDENTIAL's verdict (`unauthorized`); every other non-success body is
 * `error` with its code in the diagnostic reason.
 */
function zaiUsage(host: string): UsageProbe {
  return async (input, key) => {
    const read = await readQuotaJson(input, `${host}${ZAI_QUOTA_PATH}`, {
      authorization: key,
      "content-type": "application/json",
    });
    const rejection = bodyKeyRejection(read, (body) =>
      body.success !== true && toNumber(body.code) === ZAI_AUTH_FAILURE_CODE
        ? `zai rejected the key (${ZAI_AUTH_FAILURE_CODE})`
        : undefined,
    );
    if (rejection !== undefined) return rejection;
    return snapshotFromRead(read, (body) => {
      if (body.success !== true) {
        const code = toNumber(body.code);
        return `usage request rejected${code === undefined ? "" : ` (${code})`}`;
      }
      const data = asRecord(body.data) ?? {};
      const rows = Array.isArray(data.limits) ? data.limits : [];
      const limits = new Map<string, UsageLimit>();
      for (const raw of rows) {
        const row = asRecord(raw);
        if (row === undefined) continue;
        const unit = toNumber(row.unit);
        const count = toNumber(row.number) ?? 1;
        const windowId =
          unit === ZAI_UNIT_HOURS
            ? windowIdForSpan(count * HOUR_MS)
            : unit === ZAI_UNIT_WEEKS
              ? "week"
              : undefined;
        if (windowId === undefined) continue;
        const limitUnit = zaiLimitUnit(row.type);
        if (limitUnit === undefined) continue;
        const spent = toNumber(row.currentValue);
        const total = toNumber(row.usage);
        // A present-but-invalid counter pair drops the row; only a MISSING
        // counter may fall back to the rounded percentage.
        const usedFraction =
          spent !== undefined ? fractionFromCounts(spent, total) : fractionFromUsed(toNumber(row.percentage) ?? Number.NaN);
        if (usedFraction === undefined) continue;
        keepTighter(
          limits,
          windowLimit({
            id: `zai:${windowId}`,
            usedFraction,
            unit: limitUnit,
            resetsAt: resetOf(row, ["nextResetTime", "next_reset_time"]),
            limit: total,
            remaining: toNumber(row.remaining),
          }),
        );
      }
      return [...limits.values()];
    });
  };
}

// --- family: minimax-code ---

const MINIMAX_INTL_HOST = "https://api.minimax.io";
const MINIMAX_CN_HOST = "https://api.minimaxi.com";
const MINIMAX_REMAINS_PATH = "/v1/token_plan/remains";
/** `current_*_status` enum: 2 = exhausted, 3 = unlimited. */
const MINIMAX_STATUS_EXHAUSTED = 2;
const MINIMAX_STATUS_UNLIMITED = 3;
/**
 * `base_resp.status_code` values that mean the KEY was rejected, per
 * platform.minimax.io's error table: 1004 (not authorized — the token does not
 * match the group, or the key is inactive) and 2049 (invalid API key). Any other
 * non-zero code is a service-side failure and stays `error`.
 */
const MINIMAX_AUTH_STATUS_CODES: readonly number[] = [1004, 2049];

/**
 * One bucket's window fraction. The endpoint's own status outranks any stale
 * percentage; a present-but-invalid used count drops the window instead of
 * falling through to the remaining-percent alias.
 */
function minimaxFraction(row: Record<string, unknown>, scope: "interval" | "weekly"): number | undefined {
  if (toNumber(row[`current_${scope}_status`]) === MINIMAX_STATUS_EXHAUSTED) return 1;
  const total = toNumber(row[`current_${scope}_total_count`]);
  const used = toNumber(row[`current_${scope}_usage_count`]);
  if (used !== undefined) return fractionFromCounts(used, total);
  // Missing usage counter: derive from the remaining percentage (100 - p is
  // the used percent), then from a remaining count.
  const remainingPercent = toNumber(row[`current_${scope}_remaining_percent`]);
  if (remainingPercent !== undefined) return fractionFromUsed(100 - remainingPercent);
  const remaining = toNumber(row[`current_${scope}_remaining_count`]);
  return remaining !== undefined ? fractionFromCounts(total !== undefined ? total - remaining : undefined, total) : undefined;
}

/** A bucket outside the current plan reports both windows unlimited with zero
 *  totals; keeping it would render a pristine quota that does not exist. */
function isUnavailableMinimaxPlan(row: Record<string, unknown>): boolean {
  return (
    toNumber(row.current_interval_total_count) === 0 &&
    toNumber(row.current_weekly_total_count) === 0 &&
    toNumber(row.current_interval_status) === MINIMAX_STATUS_UNLIMITED &&
    toNumber(row.current_weekly_status) === MINIMAX_STATUS_UNLIMITED
  );
}

/** MiniMax Token Plan. The vendor answers HTTP 200 for a rejected credential,
 *  so `base_resp.status_code` is the real success signal: the documented auth
 *  codes report `unauthorized`, every other non-zero code `error`. */
function minimaxUsage(host: string): UsageProbe {
  return async (input, key) => {
    const read = await readQuotaJson(input, `${host}${MINIMAX_REMAINS_PATH}`, {
      authorization: `Bearer ${key}`,
    });
    const rejection = bodyKeyRejection(read, (body) => {
      const statusCode = toNumber(asRecord(body.base_resp)?.status_code);
      return statusCode !== undefined && MINIMAX_AUTH_STATUS_CODES.includes(statusCode)
        ? `minimax rejected the key (${statusCode})`
        : undefined;
    });
    if (rejection !== undefined) return rejection;
    return snapshotFromRead(read, (body) => {
      const baseResp = asRecord(body.base_resp);
      const statusCode = toNumber(baseResp?.status_code);
      if (statusCode !== undefined && statusCode !== 0) return `usage request rejected (${statusCode})`;
      const rows = Array.isArray(body.model_remains) ? body.model_remains : [];
      const limits = new Map<string, UsageLimit>();
      for (const raw of rows) {
        const row = asRecord(raw);
        const modelName = typeof row?.model_name === "string" ? row.model_name.trim() : "";
        if (row === undefined || modelName.length === 0) continue;
        if (isUnavailableMinimaxPlan(row)) continue;
        const start = resetFrom(row.start_time);
        const end = resetFrom(row.end_time);
        const intervalSpan = start !== undefined && end !== undefined ? end - start : undefined;
        const intervalId = intervalSpan === undefined ? "session" : windowIdForSpan(intervalSpan);
        const intervalFraction = minimaxFraction(row, "interval");
        if (intervalFraction !== undefined) {
          keepTighter(
            limits,
            windowLimit({
              id: `minimax:${intervalId}`,
              usedFraction: intervalFraction,
              unit: "percent",
              resetsAt: end ?? resetAfterMs(toNumber(row.remains_time)),
            }),
          );
        }
        const weeklyFraction = minimaxFraction(row, "weekly");
        if (weeklyFraction !== undefined) {
          keepTighter(
            limits,
            windowLimit({
              id: "minimax:week",
              usedFraction: weeklyFraction,
              unit: "percent",
              resetsAt: resetFrom(row.weekly_end_time) ?? resetAfterMs(toNumber(row.weekly_remains_time)),
            }),
          );
        }
      }
      return [...limits.values()];
    });
  };
}

// --- family: cline-pass ---

const CLINE_USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";
const CLINE_CLIENT_VERSION = "3.5.54";
// shortcut: version pinned from magpie 3.5.54; bump it if the endpoint starts version-gating
/** The desktop client headers the route is gated on (vendor constants, not credentials). */
const CLINE_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json",
  "http-referer": "https://cline.bot",
  "x-title": "Cline",
  "x-is-multiroot": "false",
  "x-client-type": "cline-desktop",
  "x-client-version": CLINE_CLIENT_VERSION,
  "user-agent": `Cline/${CLINE_CLIENT_VERSION}`,
};
const CLINE_WINDOWS: Readonly<Record<string, "session" | "week" | "month">> = {
  five_hour: "session",
  weekly: "week",
  monthly: "month",
};

/** ClinePass plan limits: `limits[]` carries `type`, `percentUsed` (USED) and
 *  an ISO `resetsAt`. The 30-day row is still a real window and keeps its own
 *  id rather than being relabelled as a week. */
const clineUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, CLINE_USAGE_URL, {
    ...CLINE_HEADERS,
    authorization: `Bearer ${key}`,
  });
  return snapshotFromRead(read, (body) => {
    // Cline wraps every answer in `{ success, error, data }`.
    if (body.success === false) return "usage request rejected";
    const data = asRecord(body.data) ?? body;
    const rows = Array.isArray(data.limits) ? data.limits : [];
    const limits = new Map<string, UsageLimit>();
    for (const raw of rows) {
      const row = asRecord(raw);
      if (row === undefined) continue;
      const windowId = typeof row.type === "string" ? CLINE_WINDOWS[row.type] : undefined;
      if (windowId === undefined) continue;
      const usedFraction = fractionFromUsed(toNumber(row.percentUsed) ?? Number.NaN);
      if (usedFraction === undefined) continue;
      keepTighter(
        limits,
        windowLimit({
          id: `cline-pass:${windowId}`,
          usedFraction,
          unit: "percent",
          resetsAt: resetOf(row, ["resetsAt", "resets_at"]),
        }),
      );
    }
    return [...limits.values()];
  });
};

// --- family: synthetic ---

const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

/** Dollar-form credit amount (`"$12.34"` or a number) → number. */
function parseCreditAmount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/^\$/, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Synthetic's two pools are account-wide: every stored key reports the same
 *  numbers, so each limit is `shared`. */
const syntheticUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, SYNTHETIC_QUOTAS_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const limits: UsageLimit[] = [];
    const fiveHour = asRecord(body.rollingFiveHourLimit);
    if (fiveHour !== undefined) {
      const remaining = toNumber(fiveHour.remaining);
      const max = toNumber(fiveHour.max);
      const usedFraction = remaining !== undefined && max !== undefined ? fractionFromCounts(max - remaining, max) : undefined;
      if (usedFraction !== undefined) {
        limits.push(
          windowLimit({
            id: "synthetic:session",
            usedFraction,
            unit: "requests",
            resetsAt: resetOf(fiveHour, ["nextTickAt", "next_tick_at"]),
            limit: max,
            remaining,
            shared: true,
          }),
        );
      }
    }
    const weekly = asRecord(body.weeklyTokenLimit);
    if (weekly !== undefined) {
      const remaining = parseCreditAmount(weekly.remainingCredits);
      const max = parseCreditAmount(weekly.maxCredits);
      const percentRemaining = toNumber(weekly.percentRemaining);
      // `percentRemaining` is REMAINING percent; 100 - p is the used percent.
      // Only a missing percentage falls back to the credit counters.
      const usedFraction =
        percentRemaining !== undefined
          ? fractionFromUsed(100 - percentRemaining)
          : remaining !== undefined && max !== undefined
            ? fractionFromCounts(max - remaining, max)
            : undefined;
      if (usedFraction !== undefined) {
        limits.push(
          windowLimit({
            id: "synthetic:week",
            usedFraction,
            unit: "usd",
            resetsAt: resetOf(weekly, ["nextRegenAt", "next_regen_at"]),
            limit: max,
            remaining,
            shared: true,
          }),
        );
      }
    }
    return limits;
  });
};

// --- family: umans ---

const UMANS_USAGE_URL = "https://api.code.umans.ai/v1/usage";

/** Umans: one rolling request window plus the concurrency ceiling. The
 *  weighted counters are the authoritative utilization (raw counts include
 *  burst traffic); the burst `hard_cap` row is not rendered here. */
const umansUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, UMANS_USAGE_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const limits: UsageLimit[] = [];
    const requestLimits = asRecord(asRecord(body.limits)?.requests);
    const usage = asRecord(body.usage) ?? {};
    const window = asRecord(body.window) ?? {};
    const weightedUsed = toNumber(usage.weighted_in_window);
    const rawUsed = toNumber(usage.requests_in_window);
    const used = weightedUsed ?? rawUsed;
    const limit = toNumber(requestLimits?.limit);
    const usedFraction = fractionFromCounts(used, limit);
    if (usedFraction !== undefined) {
      limits.push(
        windowLimit({
          id: "umans:session",
          usedFraction,
          unit: "requests",
          resetsAt: resetOf(window, ["resets_at", "resetsAt"]),
          limit,
          remaining: toNumber(weightedUsed !== undefined ? usage.weighted_remaining_requests : usage.remaining_requests),
        }),
      );
    }
    const concurrencyUsed = toNumber(usage.concurrent_sessions);
    const concurrencyLimit = toNumber(asRecord(asRecord(body.limits)?.concurrency)?.limit);
    const concurrencyFraction = fractionFromCounts(concurrencyUsed, concurrencyLimit);
    if (concurrencyFraction !== undefined) {
      limits.push(
        windowLimit({
          id: "umans:concurrency",
          usedFraction: concurrencyFraction,
          unit: "requests",
          limit: concurrencyLimit,
        }),
      );
    }
    return limits;
  });
};

// --- family: charm-hyper ---

const HYPER_CREDITS_URL = "https://hyper.charm.land/credits";

/** Prepaid credits: `/credits` answers `{balance}` and nothing else (no
 *  allowance, no reset), so the limit is remaining-only by construction and
 *  account-wide across keys. */
const hyperUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, HYPER_CREDITS_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const balance = toNumber(body.balance);
    if (balance === undefined) return "no credit balance";
    return [{ id: "hyper:balance", kind: "balance", remaining: balance, unit: "credits", shared: true }];
  });
};

// --- family: kimi-for-coding ---

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

/** Kimi numbers arrive as strings. A missing `used` derives one from
 *  `limit - remaining`; a present-but-negative count drops the window. */
function kimiFraction(row: Record<string, unknown>): number | undefined {
  const limit = toNumber(row.limit);
  const used = toNumber(row.used);
  if (used !== undefined) return fractionFromCounts(used, limit);
  const remaining = toNumber(row.remaining);
  return remaining !== undefined && limit !== undefined
    ? fractionFromCounts(limit - remaining, limit)
    : undefined;
}

/** `GET /coding/v1/usages`: the aggregate `usage` object is the weekly window,
 *  each `limits[]` row is a window classified by its reported span. */
const kimiUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, KIMI_USAGE_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const limits = new Map<string, UsageLimit>();
    const usage = asRecord(body.usage);
    if (usage !== undefined) {
      const usedFraction = kimiFraction(usage);
      if (usedFraction !== undefined) {
        limits.set(
          "kimi:week",
          windowLimit({
            id: "kimi:week",
            usedFraction,
            unit: "requests",
            resetsAt: resetOf(usage, ["resetTime", "reset_time", "resetAt", "reset_at"]),
            limit: toNumber(usage.limit),
          }),
        );
      }
    }
    const rows = Array.isArray(body.limits) ? body.limits : [];
    for (const raw of rows) {
      const row = asRecord(raw);
      if (row === undefined) continue;
      const window = asRecord(row.window) ?? {};
      const detail = asRecord(row.detail) ?? row;
      const span = spanFromDuration(
        toNumber(window.duration),
        String(window.time_unit ?? window.timeUnit ?? ""),
      );
      if (span === undefined) continue;
      const usedFraction = kimiFraction(detail);
      if (usedFraction === undefined) continue;
      keepTighter(
        limits,
        windowLimit({
          id: `kimi:${windowIdForSpan(span)}`,
          usedFraction,
          unit: "requests",
          resetsAt: resetOf(detail, ["resetTime", "reset_time", "resetAt", "reset_at"]),
          limit: toNumber(detail.limit),
        }),
      );
    }
    return [...limits.values()];
  });
};

// --- family: cursor ---

const CURSOR_USAGE_URL = "https://api2.cursor.sh/auth/usage";

/**
 * The account's reset instant from the payload's own aliases: an explicit cycle
 * end wins, otherwise one month after a cycle start. Unreadable aliases fall
 * through, so a garbled end never hides a usable start.
 */
function cursorResetsAt(payload: Record<string, unknown>): number | undefined {
  const end = resetOf(payload, ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"]);
  if (end !== undefined) return end;
  const start = resetOf(payload, ["startOfMonth", "billingCycleStart", "startOfBillingCycle"]);
  if (start === undefined) return undefined;
  const date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.getTime();
}

/** Bucket name → its counters' unit: the spend buckets report dollars. */
function cursorUnit(bucket: string): "usd" | "requests" {
  const name = bucket.toLowerCase();
  return name === "planusage" || name.includes("billing") || name.includes("usd") || name.includes("stripe")
    ? "usd"
    : "requests";
}

/**
 * Cursor's request-count / spend buckets: the payload's top-level entries ARE
 * the buckets, each carrying a used counter and — on a capped plan — a cap.
 * Only a bucket with BOTH readable numbers becomes a bar: an uncapped bucket
 * has no fraction to draw, and a garbled counter is dropped rather than zeroed.
 * The reset instant is payload-wide (the vendor states one cycle for the
 * account), so every bucket shares it when present.
 */
const cursorUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, CURSOR_USAGE_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const resetsAt = cursorResetsAt(body);
    const limits: UsageLimit[] = [];
    for (const [bucket, raw] of Object.entries(body)) {
      const row = asRecord(raw);
      if (row === undefined) continue;
      const used = firstNumber(row, ["numRequests", "used", "amountUsed", "usdUsed"]);
      const cap = firstNumber(row, ["maxRequestUsage", "limit", "amountLimit", "usdLimit"]);
      if (used === undefined || cap === undefined) continue;
      const usedFraction = fractionFromCounts(used, cap);
      if (usedFraction === undefined) continue;
      const unit = cursorUnit(bucket);
      limits.push(
        windowLimit({
          id: `cursor:${unit}:${bucket.toLowerCase().trim()}`,
          usedFraction,
          unit,
          limit: cap,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        }),
      );
    }
    return limits;
  });
};

// --- catalog id → family ---

/**
 * The probe table, keyed by catalog id. Every id here is a row in
 * `PROVIDER_CATALOG` (parity is asserted by the suite); an id absent from this
 * table has no usage endpoint and is never probed. The ids are the catalog's
 * own names — the reference implementations' aliases (charm-hyper,
 * minimax-code, zhipu-coding-plan, kimi-code) are not this product's ids.
 *
 * Each entry also carries the vendor hosts its probe reaches, derived from the
 * SAME endpoint constants the probe calls (and asserted so by the suite), so
 * the set can never drift from where the credential actually travels: a stored
 * declaration may only point at one of them.
 */
type UsageProbeEntry = {
  probe: UsageProbe;
  hosts: readonly string[];
};

/**
 * A URL's host — the unit a declaration's base URL is compared by. `null` when
 * the value does not parse, so an unreadable endpoint fails closed. One helper
 * serves both sides of that comparison: the probe table's advertised hosts here
 * and the route's stored declaration, which must agree by construction.
 */
export function endpointHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The distinct hosts a family's own endpoint constants name. */
function hostsOf(...urls: string[]): readonly string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = endpointHost(url);
    if (host !== null) hosts.add(host);
  }
  return [...hosts];
}

const USAGE_PROBES: Readonly<Record<string, UsageProbeEntry>> = Object.freeze({
  commandcode: { probe: commandCodeUsage, hosts: hostsOf(COMMANDCODE_ORIGIN) },
  "commandcode-anthropic": { probe: commandCodeUsage, hosts: hostsOf(COMMANDCODE_ORIGIN) },
  "opencode-go": { probe: opencodeGoUsage, hosts: hostsOf(OPENCODE_GO_USAGE_URL) },
  zai: { probe: zaiUsage(ZAI_HOST), hosts: hostsOf(ZAI_HOST) },
  "zai-coding-plan": { probe: zaiUsage(ZAI_HOST), hosts: hostsOf(ZAI_HOST) },
  zhipuai: { probe: zaiUsage(ZHIPU_HOST), hosts: hostsOf(ZHIPU_HOST) },
  "zhipuai-coding-plan": { probe: zaiUsage(ZHIPU_HOST), hosts: hostsOf(ZHIPU_HOST) },
  "minimax-coding-plan": { probe: minimaxUsage(MINIMAX_INTL_HOST), hosts: hostsOf(MINIMAX_INTL_HOST) },
  "minimax-cn-coding-plan": { probe: minimaxUsage(MINIMAX_CN_HOST), hosts: hostsOf(MINIMAX_CN_HOST) },
  "cline-pass": { probe: clineUsage, hosts: hostsOf(CLINE_USAGE_URL) },
  synthetic: { probe: syntheticUsage, hosts: hostsOf(SYNTHETIC_QUOTAS_URL) },
  umans: { probe: umansUsage, hosts: hostsOf(UMANS_USAGE_URL) },
  hyper: { probe: hyperUsage, hosts: hostsOf(HYPER_CREDITS_URL) },
  "kimi-for-coding": { probe: kimiUsage, hosts: hostsOf(KIMI_USAGE_URL) },
  cursor: { probe: cursorUsage, hosts: hostsOf(CURSOR_USAGE_URL) },
});

/**
 * Whether this provider has a usage endpoint. Own-property check: a plain
 * index would answer `constructor` with a function and hand it back as a probe.
 */
export function hasUsageProbe(provider: string): boolean {
  return Object.hasOwn(USAGE_PROBES, provider);
}

/**
 * The vendor hosts a provider's probe reaches, or `null` when the provider has
 * no probe. A stored declaration whose base URL points anywhere else is not
 * this probe's credential — the route refuses it before any request.
 */
export function usageProbeHosts(provider: string): readonly string[] | null {
  return Object.hasOwn(USAGE_PROBES, provider) ? USAGE_PROBES[provider]!.hosts : null;
}

/**
 * Probe one provider key's usage. An unmapped provider is `absent` + `no-probe`
 * (no outbound request at all); a probe that somehow throws becomes `error`, so
 * callers never handle an exception. The plaintext key only ever reaches the
 * request's Authorization header.
 */
export async function probeProviderUsage(
  deps: UsageDeps,
  provider: string,
  key: string,
): Promise<UsageSnapshot> {
  const startedAt = Date.now();
  if (!hasUsageProbe(provider)) {
    return {
      status: "absent",
      fetchedAt: startedAt,
      limits: [],
      reason: `no usage probe for ${provider}`,
      absentCause: "no-probe",
    };
  }
  const probe = USAGE_PROBES[provider]!.probe;
  try {
    return await probe({ fetch: deps.fetch, deadline: startedAt + (deps.timeoutMs ?? VERIFY_TIMEOUT_MS) }, key);
  } catch {
    return { status: "error", fetchedAt: Date.now(), limits: [], reason: "usage probe failed" };
  }
}
