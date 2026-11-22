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
