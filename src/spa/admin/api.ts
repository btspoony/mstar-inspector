/**
 * The console's data layer: one base path, the reads and writes the four
 * screens use, and the loading/error state machine they share.
 *
 * Reads PARSE into typed rows instead of asserting the API's shape (the
 * `pages/data.ts` precedent): a renamed server field must fail the read
 * visibly, never render a blank cell in an operator's table.
 *
 * Writes return no body. A 2xx means the server accepted the change the caller
 * asked for, and the caller applies that value itself — parsing the echo would
 * turn a malformed (but successful) response into a false failure report.
 * Refusals keep the server's own `{ error }` text, so the console never invents
 * a second wording for a rule it does not own.
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

/** A refused console write: the status and the server's own message. */
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
 * One write. `redirect: "manual"` keeps a login redirect from reading as
 * success: the console renders a failure instead of confirming a write that
 * went to an HTML login page.
 */
async function write(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<void> {
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
}

export function setFlag(key: string, enabled: boolean): Promise<void> {
  return write("PATCH", "/flags", { key, enabled });
}

export function setPlan(workspaceId: string, planId: string): Promise<void> {
  return write("PATCH", `/workspaces/${encodeURIComponent(workspaceId)}/plan`, { planId });
}

export type GrantInput = {
  workspaceId: string;
  operatorLogin: string;
  reason: string;
  ttlHours: number;
};

export function createGrant(input: GrantInput): Promise<void> {
  return write("POST", "/support-grants", input);
}

export function revokeGrant(id: string): Promise<void> {
  return write("DELETE", `/support-grants/${encodeURIComponent(id)}`);
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
