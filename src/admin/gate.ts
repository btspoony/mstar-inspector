/**
 * The per-request operator gate for `/_internal_admin`.
 *
 * The namespace answers only a caller that holds a valid signed session, has a
 * `users` row, and is on the `PLATFORM_OPERATORS` allowlist. Every other caller
 * — no cookie, forged signature, removed account, ordinary member — gets the
 * framework 404: not a 403, not a redirect (a redirect would confirm the path
 * exists), and no body detail.
 *
 * Each admin handler calls this itself. It is deliberately NOT mounted as
 * middleware, so a handler added later cannot inherit authorization from a
 * parent. The `self-hosted` refusal is stronger than this gate and happens at
 * registration (`src/worker/index.ts`): no admin route exists there at all.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { isPlatformOperator } from "../dashboard/index";
import { SESSION_COOKIE, readSessionValue } from "../dashboard/session";
import { getUserByLogin, type DashboardD1 } from "../dashboard/users";
import type { Env } from "../worker/env";

export type AdminContext = Context<{ Bindings: Env }>;

/**
 * The signed-in operator's login, or null when the caller must see the
 * indistinguishable 404. Fail-closed on infrastructure: an unbound store or
 * session secret answers null rather than a distinguishable error, because the
 * surface must not describe itself.
 */
export async function operatorLogin(c: AdminContext): Promise<string | null> {
  const secret = c.env.DASHBOARD_SESSION_SECRET;
  const db = (c.env as Env & { DB?: DashboardD1 }).DB;
  if (!secret || !db) return null;
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secret);
  if (!session) return null;
  if ((await getUserByLogin(db, session.login)) === null) return null;
  return isPlatformOperator(c.env, session.login) ? session.login : null;
}
