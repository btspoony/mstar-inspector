/**
 * Locale resolution + the mstar_locale cookie (plan 29 T2).
 *
 * Decision chain (spec §3, architect-locked — NO locale middleware):
 *   1. cookie `mstar_locale` — valid ids only (`en` | `zh_CN`); any other
 *      value is ignored, never an error.
 *   2. `Accept-Language` — only the FIRST listed tag is inspected: a
 *      case-insensitive `zh` prefix → zh_CN. No q-value parsing: browsers
 *      order tags by stated preference, so honoring any later `zh;q=…`
 *      tag would mis-locale an en-primary bilingual browser
 *      (e.g. `en-US,zh-CN;q=0.8` correctly stays English).
 *   3. fallback → en.
 *
 * `resolveLocale(request)` is a pure function with exactly two call sites
 * (SPA entry + legacy app). The cookie serializer mirrors the session.ts
 * attribute set (HttpOnly; Secure; SameSite=Lax) but scopes Path to
 * /dashboard — the locale preference only needs to ride dashboard pages.
 */
export const LOCALE_COOKIE = "mstar_locale";

export const LOCALES = ["en", "zh_CN"] as const;

export type Locale = (typeof LOCALES)[number];

/** Preference cookie lifetime: 1 year — outlives the 7d session cookie. */
export const LOCALE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh_CN";
}

/** Minimal Cookie-header parser (name=value pairs, first `=` wins). */
function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function resolveLocale(request: Request): Locale {
  const cookie = parseCookieHeader(request.headers.get("Cookie"))[LOCALE_COOKIE];
  if (isLocale(cookie)) return cookie;
  const acceptLanguage = request.headers.get("Accept-Language");
  if (acceptLanguage) {
    const primary = acceptLanguage.split(",")[0]?.trim().toLowerCase() ?? "";
    if (primary.startsWith("zh")) return "zh_CN";
  }
  return "en";
}

/**
 * Set-Cookie value for the locale preference. Attribute set mirrors
 * session.ts serializeCookie (HttpOnly; Secure; SameSite=Lax) with
 * Path=/dashboard — the toggle only renders inside the dashboard shell.
 */
export function serializeLocaleCookie(locale: Locale, maxAgeSec = LOCALE_MAX_AGE_SEC): string {
  return `${LOCALE_COOKIE}=${locale}; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=${maxAgeSec}`;
}
