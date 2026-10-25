/**
 * Effective server flags (`server_flags`, migration 0033).
 *
 * Read pattern (spec §3.1, architect verdict 2026-10-25): ONE prepared point
 * read per decision site. No cache, no KV, no request-scoped memo — every
 * consumer reads its flag once per request, and the read rides a path that
 * already spends several D1 statements, so a PK lookup is marginal. A memo
 * becomes required only if a future consumer reads the same flag twice in one
 * request; cross-request caching stays forbidden.
 *
 * An ABSENT row reads as ENABLED: the platform's shipped behaviour is the
 * default, and a flag nobody has toggled cannot break a live consumer.
 */
import type { DashboardD1 } from "../dashboard/users";

/** The flags the console exposes; the API refuses any other key. */
export const SERVER_FLAG_KEYS = [
  "review_global",
  "signup_open",
  "workspace_creation_open",
] as const;

export type ServerFlagKey = (typeof SERVER_FLAG_KEYS)[number];

export function isServerFlagKey(value: unknown): value is ServerFlagKey {
  return typeof value === "string" && (SERVER_FLAG_KEYS as readonly string[]).includes(value);
}

/** The flag's effective value at this decision site. Absent row → enabled. */
export async function isFlagEnabled(db: DashboardD1, key: ServerFlagKey): Promise<boolean> {
  const row = await db
    .prepare("SELECT enabled FROM server_flags WHERE key = ?")
    .bind(key)
    .first<{ enabled: number }>();
  return row === null ? true : row.enabled === 1;
}

/** Every known flag with its effective value — one statement, absent → enabled. */
export async function listFlags(db: DashboardD1): Promise<Array<{ key: ServerFlagKey; enabled: boolean }>> {
  const rows = await db
    .prepare("SELECT key, enabled FROM server_flags")
    .all<{ key: string; enabled: number }>();
  const stored = new Map(rows.results.map((row) => [row.key, row.enabled === 1]));
  return SERVER_FLAG_KEYS.map((key) => ({ key, enabled: stored.get(key) ?? true }));
}
