/**
 * Shared SPA dispatch test helpers.
 *
 * Worker tests that exercise HTML navigation against spa-dispatch need a
 * stub ASSETS binding that serves a marker-bearing index.html. Four files
 * duplicated the same INDEX_HTML / spaEnv / htmlGet trio — this module is
 * the single copy.
 */
import { readFileSync } from "node:fs";
import type { Fetcher } from "@cloudflare/workers-types";
import { SPA_BOOT_MARKER } from "../../src/spa/boot";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";

export { SPA_BOOT_MARKER };

/**
 * The REAL shell document, not a hand-written mirror: the Worker now rewrites
 * its `<html lang>` and `<title>` anchors, so a stub without them would fail
 * every HTML navigation for a reason the shipped document does not have. The
 * boot marker it carries is the one the injection spends.
 */
export const SPA_INDEX_HTML = readFileSync(new URL("../../src/spa/index.html", import.meta.url), "utf8");

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
