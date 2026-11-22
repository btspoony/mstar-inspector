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
