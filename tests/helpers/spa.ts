/**
 * Shared SPA dispatch test helpers (plan 29 T7).
 *
 * Worker tests that exercise HTML navigation against spa-dispatch need a
 * stub ASSETS binding that serves a marker-bearing index.html. Four files
 * duplicated the same INDEX_HTML / spaEnv / htmlGet trio — this module is
 * the single copy.
 */
import type { Fetcher } from "@cloudflare/workers-types";
import { SPA_BOOT_MARKER } from "../../src/spa/boot";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";

export { SPA_BOOT_MARKER };

export const SPA_INDEX_HTML = `<!doctype html><html><head>${SPA_BOOT_MARKER}</head><body>spa</body></html>`;

export function spaAssets(indexHtml = SPA_INDEX_HTML): Fetcher {
  return {
    fetch: async (input: Request | URL | string) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/index.html") return new Response("missing", { status: 404 });
      return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher;
}

export function withSpaAssets<T extends object>(env: T, indexHtml = SPA_INDEX_HTML): T & { ASSETS: Fetcher } {
  return { ...env, ASSETS: spaAssets(indexHtml) };
}

export function htmlGetRequest(path: string, extra?: Record<string, string>): Request {
  return new Request(`https://worker.local${path}`, {
    headers: { Accept: "text/html", ...extra },
  });
}

export async function htmlGet(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(htmlGetRequest(path, cookie ? { Cookie: cookie } : {}), env);
}
