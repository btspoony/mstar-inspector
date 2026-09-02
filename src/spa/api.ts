/**
 * Same-origin JSON fetch for SPA pages (plan 29 T4).
 *
 * `redirect: "manual"` so a 302 to login is visible (the session cookie is
 * HttpOnly; the client cannot detect expiry except through the API).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("Location");
    if (location) window.location.replace(location);
    throw new ApiError(res.status, "");
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return await res.json();
}

/** POST an existing pinned HTML form path; 4xx stays in-SPA so we can refetch. */
export async function postForm(url: string, body: Record<string, string>): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("Location");
    if (location) window.location.replace(location);
    throw new ApiError(res.status, "");
  }
  return { status: res.status };
}

