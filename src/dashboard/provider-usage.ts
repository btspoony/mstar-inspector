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
 * guessed endpoint: the probe set is exactly ten families over fourteen catalog
 * ids, listed below as twelve rows — the Z.AI and Zhipuai id pairs share one
 * row each, the MiniMax intl/CN pair splits into two. A declaration stored
 * under a per-protocol id the catalog collapsed resolves to its provider's row
 * before the lookup.
 *
 * | catalog ids                                                        | endpoint (auth)                                                        | limits |
 * |--------------------------------------------------------------------|------------------------------------------------------------------------|--------|
 * | commandcode                                                        | GET …/alpha/whoami then …/alpha/billing/credits (Bearer)               | fiveHour/weekly windows + `month` pool (monthlyCredits) carrying `extraRemaining` (purchased+free), or a bare balance when the account has no monthly pool |
 * | opencode-go                                                        | GET https://opencode.ai/zen/go/v1/usage (Bearer)                       | usage.rolling / usage.weekly / usage.monthly |
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

import { LEGACY_PROVIDER_IDS } from "../contracts/provider-catalog.generated";
import { VERIFY_TIMEOUT_MS, VERIFY_USER_AGENT, type VerifyFetch } from "./provider-verify";

/** Probe outcome vocabulary (closed: callers render exactly these four faces). */
export type UsageStatus = "ok" | "absent" | "unauthorized" | "error";

/** One normalized limit. Window and balance limits share the wire shape so the
 *  dialog has one list to render. */
export type UsageLimit = {
  id: string;
  kind: "window" | "balance";
  usedFraction?: number;
  remaining?: number;
  extraRemaining?: number;
  limit?: number;
  unit: "percent" | "requests" | "credits" | "usd" | "tokens";
  resetsAt?: number;
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
  timeoutMs?: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const SESSION_MAX_MS = DAY_MS;


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

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
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const iso = Date.parse(value);
    if (Number.isFinite(iso)) return iso > 0 ? iso : undefined;
    return resetFrom(toNumber(value));
  }
  return undefined;
}

function resetAfterMs(ms: number | undefined): number | undefined {
  return ms === undefined || ms <= 0 ? undefined : Date.now() + ms;
}

function resetOf(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = resetFrom(row[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function firstNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = toNumber(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function windowIdForSpan(spanMs: number): "session" | "week" {
  return spanMs < SESSION_MAX_MS ? "session" : "week";
}

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


function windowLimit(args: {
  id: string;
  usedFraction: number;
  unit: UsageLimit["unit"];
  resetsAt?: number;
  limit?: number;
  remaining?: number;
  shared?: boolean;
}): UsageLimit {
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

function keepTighter(limits: Map<string, UsageLimit>, next: UsageLimit): void {
  const current = limits.get(next.id);
  if (current === undefined || (next.usedFraction ?? 0) > (current.usedFraction ?? 0)) {
    limits.set(next.id, next);
  }
}


type ProbeInput = { fetch: VerifyFetch; deadline: number };

type QuotaReadFailure = Exclude<UsageStatus, "ok">;

type QuotaRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: QuotaReadFailure; reason: string };

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

async function readQuotaJson(
  input: ProbeInput,
  url: string,
  headers: Record<string, string>,
): Promise<QuotaRead> {
  try {
    const budgetMs = Math.max(1, input.deadline - Date.now());
    const response = await input.fetch(url, {
      headers: { accept: "application/json", "user-agent": VERIFY_USER_AGENT, ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(budgetMs),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: "unauthorized", reason: `http ${response.status}` };
    }
    if (response.status === 404) return { ok: false, status: "absent", reason: "http 404" };
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: "error", reason: `http ${response.status}` };
    }
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

function bodyKeyRejection(
  read: QuotaRead,
  rejectionReason: (body: Record<string, unknown>) => string | undefined,
): UsageSnapshot | undefined {
  if (!read.ok) return undefined;
  const reason = rejectionReason(read.body);
  return reason === undefined ? undefined : { status: "unauthorized", fetchedAt: Date.now(), limits: [], reason };
}

type UsageProbe = (input: ProbeInput, key: string) => Promise<UsageSnapshot>;


const COMMANDCODE_ORIGIN = "https://api.commandcode.ai";
const COMMANDCODE_WINDOWS = [
  { key: "fiveHour", id: "session" },
  { key: "weekly", id: "week" },
] as const;

function creditComponent(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const amount = toNumber(value);
  return amount === undefined || amount < 0 ? null : amount;
}

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
      const monthly = creditComponent(credits.monthlyCredits);
      const purchased = creditComponent(credits.purchasedCredits);
      const free = creditComponent(credits.freeCredits);
      const onDemand = purchased === null || free === null ? undefined : (purchased ?? 0) + (free ?? 0);
      const extra = onDemand !== undefined && onDemand > 0 ? onDemand : undefined;
      if (typeof monthly === "number") {
        limits.push({
          id: "commandcode:month",
          kind: "balance",
          remaining: monthly,
          ...(extra !== undefined ? { extraRemaining: extra } : {}),
          unit: "credits",
          shared: true,
        });
      } else if (extra !== undefined) {
        limits.push({ id: "commandcode:balance", kind: "balance", remaining: extra, unit: "credits", shared: true });
      }
    }
    return limits;
  });
};


const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_WINDOWS = [
  { key: "rolling", id: "session" },
  { key: "weekly", id: "week" },
  { key: "monthly", id: "month" },
] as const;

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


const ZAI_HOST = "https://api.z.ai";
const ZHIPU_HOST = "https://open.bigmodel.cn";
const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const ZAI_UNIT_HOURS = 3;
const ZAI_UNIT_WEEKS = 6;

function zaiLimitUnit(type: unknown): UsageLimit["unit"] | undefined {
  if (type === "TOKENS_LIMIT") return "tokens";
  if (type === "CREDIT_LIMIT") return "credits";
  if (type === "TIME_LIMIT") return "requests";
  return undefined;
}

const ZAI_AUTH_FAILURE_CODE = 401;

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


const MINIMAX_INTL_HOST = "https://api.minimax.io";
const MINIMAX_CN_HOST = "https://api.minimaxi.com";
const MINIMAX_REMAINS_PATH = "/v1/token_plan/remains";
const MINIMAX_STATUS_EXHAUSTED = 2;
const MINIMAX_STATUS_UNLIMITED = 3;
const MINIMAX_AUTH_STATUS_CODES: readonly number[] = [1004, 2049];

function minimaxFraction(row: Record<string, unknown>, scope: "interval" | "weekly"): number | undefined {
  if (toNumber(row[`current_${scope}_status`]) === MINIMAX_STATUS_EXHAUSTED) return 1;
  const total = toNumber(row[`current_${scope}_total_count`]);
  const used = toNumber(row[`current_${scope}_usage_count`]);
  if (used !== undefined) return fractionFromCounts(used, total);
  const remainingPercent = toNumber(row[`current_${scope}_remaining_percent`]);
  if (remainingPercent !== undefined) return fractionFromUsed(100 - remainingPercent);
  const remaining = toNumber(row[`current_${scope}_remaining_count`]);
  return remaining !== undefined ? fractionFromCounts(total !== undefined ? total - remaining : undefined, total) : undefined;
}

function isUnavailableMinimaxPlan(row: Record<string, unknown>): boolean {
  return (
    toNumber(row.current_interval_total_count) === 0 &&
    toNumber(row.current_weekly_total_count) === 0 &&
    toNumber(row.current_interval_status) === MINIMAX_STATUS_UNLIMITED &&
    toNumber(row.current_weekly_status) === MINIMAX_STATUS_UNLIMITED
  );
}

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


const CLINE_USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";
const CLINE_CLIENT_VERSION = "3.5.54";
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

const clineUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, CLINE_USAGE_URL, {
    ...CLINE_HEADERS,
    authorization: `Bearer ${key}`,
  });
  return snapshotFromRead(read, (body) => {
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


const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

function parseCreditAmount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/^\$/, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

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


const UMANS_USAGE_URL = "https://api.code.umans.ai/v1/usage";

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


const HYPER_CREDITS_URL = "https://hyper.charm.land/credits";

const hyperUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, HYPER_CREDITS_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const balance = toNumber(body.balance);
    if (balance === undefined) return "no credit balance";
    return [{ id: "hyper:balance", kind: "balance", remaining: balance, unit: "credits", shared: true }];
  });
};


const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

function kimiFraction(row: Record<string, unknown>): number | undefined {
  const limit = toNumber(row.limit);
  const used = toNumber(row.used);
  if (used !== undefined) return fractionFromCounts(used, limit);
  const remaining = toNumber(row.remaining);
  return remaining !== undefined && limit !== undefined
    ? fractionFromCounts(limit - remaining, limit)
    : undefined;
}

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


const CURSOR_USAGE_URL = "https://api2.cursor.sh/auth/usage";

function cursorResetsAt(payload: Record<string, unknown>): number | undefined {
  const end = resetOf(payload, ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"]);
  if (end !== undefined) return end;
  const start = resetOf(payload, ["startOfMonth", "billingCycleStart", "startOfBillingCycle"]);
  if (start === undefined) return undefined;
  const date = new Date(start);
  const targetMonth = date.getUTCMonth() + 1;
  date.setUTCMonth(targetMonth);
  if (date.getUTCMonth() !== targetMonth % 12) date.setUTCDate(0);
  return date.getTime();
}

function cursorUnit(bucket: string): "usd" | "requests" {
  const name = bucket.toLowerCase();
  return name === "planusage" || name.includes("billing") || name.includes("usd") || name.includes("stripe")
    ? "usd"
    : "requests";
}

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

function probeIdOf(provider: string): string {
  return Object.hasOwn(LEGACY_PROVIDER_IDS, provider) ? LEGACY_PROVIDER_IDS[provider]! : provider;
}

/**
 * Whether this provider has a usage endpoint. Own-property check: a plain
 * index would answer `constructor` with a function and hand it back as a probe.
 */
export function hasUsageProbe(provider: string): boolean {
  return Object.hasOwn(USAGE_PROBES, probeIdOf(provider));
}

/**
 * The vendor hosts a provider's probe reaches, or `null` when the provider has
 * no probe. A stored declaration whose base URL points anywhere else is not
 * this probe's credential — the route refuses it before any request.
 */
export function usageProbeHosts(provider: string): readonly string[] | null {
  const probeId = probeIdOf(provider);
  return Object.hasOwn(USAGE_PROBES, probeId) ? USAGE_PROBES[probeId]!.hosts : null;
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
  const probeId = probeIdOf(provider);
  if (!Object.hasOwn(USAGE_PROBES, probeId)) {
    return {
      status: "absent",
      fetchedAt: startedAt,
      limits: [],
      reason: `no usage probe for ${provider}`,
      absentCause: "no-probe",
    };
  }
  const probe = USAGE_PROBES[probeId]!.probe;
  try {
    return await probe({ fetch: deps.fetch, deadline: startedAt + (deps.timeoutMs ?? VERIFY_TIMEOUT_MS) }, key);
  } catch {
    return { status: "error", fetchedAt: Date.now(), limits: [], reason: "usage probe failed" };
  }
}
