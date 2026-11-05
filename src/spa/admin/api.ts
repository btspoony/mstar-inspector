/**
 * The console's data layer: one base path, the reads and writes the four
 * screens use, and the loading/error state machine they share.
 *
 * Reads PARSE into typed rows instead of asserting the API's shape (the
 * `pages/data.ts` precedent): a renamed server field must fail the read
 * visibly, never render a blank cell in an operator's table.
 *
 * Writes answer the server's JSON body when it has one, `undefined`
 * otherwise. A 2xx means the server accepted the change the caller asked for:
 * the caller may adopt the echoed value (the runtime cap) or ignore it, and a
 * body that is not JSON is not a failed write — `JSON.parse` must never turn a
 * landed save into a false failure report. Refusals keep the server's own
 * `{ error }` text, so the console never invents a second wording for a rule it
 * does not own.
 */
import { useEffect, useState } from "react";
import { fetchJson } from "../api";

const BASE = "/_internal_admin/api";

export type FlagRow = { key: string; enabled: boolean };

/** One `GET /api/workspaces` row. */
export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  ownerLogin: string | null;
  memberCount: number;
  pendingInviteCount: number;
  planId: string;
  planName: string;
  /** The seat cap; NULL means unlimited and must never render as `0`. */
  includedMembers: number | null;
  createdAt: string;
};

/** One `GET /api/users` row; `isOperator` comes from the env allowlist, not a table. */
export type UserRow = {
  login: string;
  createdAt: string;
  workspaceCount: number;
  activeGrantCount: number;
  isOperator: boolean;
};

/** One open support window — the `support_grants` row's own column names. */
export type GrantRow = {
  id: string;
  workspace_id: string;
  operator_login: string;
  reason: string;
  granted_by: string;
  created_at: string;
  expires_at: string;
};

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

type Json = Record<string, unknown>;

function map(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null) throw new Error(`admin API: ${what} is not an object`);
  return value as Json;
}

function list(value: unknown, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`admin API: ${what} is not a list`);
  return value.map((row) => map(row, `${what} row`));
}

function text(row: Json, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`admin API: ${key} is not a string`);
  return value;
}

function maybeText(row: Json, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`admin API: ${key} is not a string`);
  return value;
}

function num(row: Json, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`admin API: ${key} is not a number`);
  return value;
}

/** A quota column where NULL is a real value (no cap), not a missing number. */
function maybeNum(row: Json, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`admin API: ${key} is not a number`);
  return value;
}

function bool(row: Json, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`admin API: ${key} is not a boolean`);
  return value;
}

export async function readFlags(): Promise<FlagRow[]> {
  const body = map(await fetchJson(`${BASE}/flags`), "flags response");
  return list(body.flags, "flags").map((row) => ({ key: text(row, "key"), enabled: bool(row, "enabled") }));
}

/** The §7.10 Check budgets as the operator API reports them. */
export type CheckBudgetConfig = {
  terminalizeMs: number;
  updateMs: number;
  terminalizeMin: number;
  terminalizeMax: number;
  updateMin: number;
  updateMax: number;
  /** A stored budget could not be read: both numbers are the documented defaults. */
  degraded: boolean;
  /** One side is derived from an absent row; it is not a configured value. */
  derived: boolean;
};

/** The §7.2 recheck backlog refill as the operator API reports it. */
export type RecheckBacklogFillConfig = {
  rows: number;
  min: number;
  max: number;
  /** The stored row could not be read: `rows` is the documented default. */
  degraded: boolean;
};

/** The runtime parameters (iteration spec §1.1, spec §7.10). */
export type RuntimeConfig = {
  concurrency: number;
  min: number;
  max: number;
  /** The stored cap could not be read: `concurrency` is the conservative fallback. */
  degraded: boolean;
  /**
   * The Check-budget surface; `null` when the server does not report it (an
   * older Worker behind a newer SPA bundle). The page then renders the
   * concurrency card exactly as before and hides the budget card — a missing
   * field is absence, not an unreadable setting.
   */
  checkBudgets: CheckBudgetConfig | null;
  /** The recheck-breadth surface; `null` when an older Worker omits it. */
  recheckBacklogFill: RecheckBacklogFillConfig | null;
};

function parseCheckBudgets(row: Json): CheckBudgetConfig | null {
  const raw = row.checkBudgets;
  if (raw === undefined) return null;
  const budgets = map(raw, "runtime checkBudgets");
  return {
    terminalizeMs: num(budgets, "terminalizeMs"),
    updateMs: num(budgets, "updateMs"),
    terminalizeMin: num(budgets, "terminalizeMin"),
    terminalizeMax: num(budgets, "terminalizeMax"),
    updateMin: num(budgets, "updateMin"),
    updateMax: num(budgets, "updateMax"),
    degraded: bool(budgets, "degraded"),
    // Tolerant read: the predecessor Worker serves this object without the
    // field, and that payload must keep the whole page rendering.
    derived: (budgets as Record<string, unknown>)["derived"] === true,
  };
}

function parseRecheckBacklogFill(row: Json): RecheckBacklogFillConfig | null {
  const raw = row.recheckBacklogFill;
  if (raw === undefined) return null;
  const fill = map(raw, "runtime recheckBacklogFill");
  return {
    rows: num(fill, "rows"),
    min: num(fill, "min"),
    max: num(fill, "max"),
    degraded: bool(fill, "degraded"),
  };
}

export async function readRuntime(): Promise<RuntimeConfig> {
  const body = map(await fetchJson(`${BASE}/runtime`), "runtime response");
  return {
    concurrency: num(body, "concurrency"),
    min: num(body, "min"),
    max: num(body, "max"),
    degraded: bool(body, "degraded"),
    checkBudgets: parseCheckBudgets(body),
    recheckBacklogFill: parseRecheckBacklogFill(body),
  };
}

/** The server's `{ concurrency }` answer; `null` when the body is not that shape. */
function storedConcurrency(answer: unknown): number | null {
  if (typeof answer !== "object" || answer === null || !("concurrency" in answer)) return null;
  return typeof answer.concurrency === "number" ? answer.concurrency : null;
}

/**
 * Save the system cap, answering the value the server stored. A 2xx whose body
 * is unreadable still landed the write, so the accepted request value stands in
 * for the missing echo instead of reporting the save as a failure.
 */
export async function setSystemConcurrency(concurrency: number): Promise<number> {
  return storedConcurrency(await write("PATCH", "/runtime", { concurrency })) ?? concurrency;
}

/**
 * Save both Check budgets, answering the pair the server stored. The range
 * fields ride the loaded config, not the echo (the echo is the stored pair
 * only); a 2xx with an unreadable body still landed, so the request value
 * stands in — the same rule as `setSystemConcurrency`.
 */
export async function setCheckBudgets(
  value: { terminalizeMs: number; updateMs: number },
  stored: CheckBudgetConfig,
): Promise<CheckBudgetConfig> {
  const answer = await write("PATCH", "/runtime", { checkBudgets: value });
  if (typeof answer === "object" && answer !== null && "checkBudgets" in answer) {
    const saved = answer.checkBudgets;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "terminalizeMs" in saved &&
      "updateMs" in saved
    ) {
      const { terminalizeMs, updateMs } = saved;
      if (typeof terminalizeMs === "number" && typeof updateMs === "number") {
        // Both rows were just written, so neither side is derived any more.
        return { ...stored, terminalizeMs, updateMs, degraded: false, derived: false };
      }
    }
  }
  return { ...stored, ...value, degraded: false };
}

/**
 * Save the recheck backlog refill, answering the stored value. A 2xx with an
 * unreadable body still landed, so the request value stands in.
 */
export async function setRecheckBacklogFill(
  rows: number,
  stored: RecheckBacklogFillConfig,
): Promise<RecheckBacklogFillConfig> {
  const answer = await write("PATCH", "/runtime", { recheckBacklogFill: rows });
  if (typeof answer === "object" && answer !== null && "recheckBacklogFill" in answer) {
    const saved = answer.recheckBacklogFill;
    if (typeof saved === "number") return { ...stored, rows: saved, degraded: false };
  }
  return { ...stored, rows, degraded: false };
}

export async function readWorkspaces(): Promise<WorkspaceRow[]> {
  const body = map(await fetchJson(`${BASE}/workspaces`), "workspaces response");
  return list(body.workspaces, "workspaces").map((row) => ({
    id: text(row, "id"),
    name: text(row, "name"),
    slug: text(row, "slug"),
    ownerLogin: maybeText(row, "ownerLogin"),
    memberCount: num(row, "memberCount"),
    pendingInviteCount: num(row, "pendingInviteCount"),
    planId: text(row, "planId"),
    planName: text(row, "planName"),
    includedMembers: maybeNum(row, "includedMembers"),
    createdAt: text(row, "createdAt"),
  }));
}

export async function readUsers(): Promise<UserRow[]> {
  const body = map(await fetchJson(`${BASE}/users`), "users response");
  return list(body.users, "users").map((row) => ({
    login: text(row, "login"),
    createdAt: text(row, "createdAt"),
    workspaceCount: num(row, "workspaceCount"),
    activeGrantCount: num(row, "activeGrantCount"),
    isOperator: bool(row, "isOperator"),
  }));
}

export async function readGrants(): Promise<GrantRow[]> {
  const body = map(await fetchJson(`${BASE}/support-grants`), "support grants response");
  return list(body.grants, "grants").map((row) => ({
    id: text(row, "id"),
    workspace_id: text(row, "workspace_id"),
    operator_login: text(row, "operator_login"),
    reason: text(row, "reason"),
    granted_by: text(row, "granted_by"),
    created_at: text(row, "created_at"),
    expires_at: text(row, "expires_at"),
  }));
}

/**
 * A refused console write: the status and the server's own message. Pages
 * render a localised generic failure as the primary notice and interpolate
 * `message` as secondary detail (`admin.refusalDetail`), never verbatim alone.
 */
export class AdminWriteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminWriteError";
    this.status = status;
  }
}

/** The server's `{ error }` body, else the raw body. */
function refusal(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      if (typeof parsed.error === "string") return parsed.error;
    }
  } catch {
    // Not JSON — the raw body is the message.
  }
  return raw;
}

/**
 * One write, answering the server's JSON body (or `undefined` when there is
 * none). `redirect: "manual"` keeps a login redirect from reading as
 * success: the console renders a failure instead of confirming a write that
 * went to an HTML login page.
 */
async function write(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "same-origin",
    redirect: "manual",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new AdminWriteError(res.status, refusal(await res.text()));
  // The write already landed: an unreadable body answers `undefined` rather
  // than reporting a failure the server never had.
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function setFlag(key: string, enabled: boolean): Promise<void> {
  await write("PATCH", "/flags", { key, enabled });
}

export async function setPlan(workspaceId: string, planId: string): Promise<void> {
  await write("PATCH", `/workspaces/${encodeURIComponent(workspaceId)}/plan`, { planId });
}

export async function setWorkspaceSlug(workspaceId: string, slug: string): Promise<void> {
  await write("PATCH", `/workspaces/${encodeURIComponent(workspaceId)}/slug`, { slug });
}

export type GrantInput = {
  workspaceId: string;
  operatorLogin: string;
  reason: string;
  ttlHours: number;
};

export async function createGrant(input: GrantInput): Promise<void> {
  await write("POST", "/support-grants", input);
}

export async function revokeGrant(id: string): Promise<void> {
  await write("DELETE", `/support-grants/${encodeURIComponent(id)}`);
}

/**
 * One read per screen, plus its retry/refresh and an in-place update.
 *
 * `read` must be a module-level function: a new closure each render would
 * re-run the effect on every render.
 */
export function useLoaded<T>(read: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    // Keep a loaded table on screen while re-reading; a first read has nothing to keep.
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    read().then(
      (data) => {
        if (live) setState({ status: "ready", data });
      },
      () => {
        if (live) setState({ status: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [read, attempt]);

  return {
    state,
    /** Re-read: the retry after a failed read, and the refresh after a server-generated row. */
    reload: () => setAttempt((count) => count + 1),
    /** Apply an accepted write without a second read. */
    update: (change: (data: T) => T) =>
      setState((previous) =>
        previous.status === "ready" ? { status: "ready", data: change(previous.data) } : previous,
      ),
  };
}
