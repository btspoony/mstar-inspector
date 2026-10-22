/**
 * Workspace switcher (plan 98 T3) — the URL-only navigation contract.
 *
 * Picking another workspace must rewrite ONLY the workspace segment of the
 * current path and hand the new URL to the router. Executed proof, not source
 * shapes: one `pushState`, one synthetic `popstate`, zero requests, and no
 * write to the address bar, the cookie jar or the document.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWorkspaceSwitcherModel } from "../../src/spa/shell";
import { WorkspaceSwitcher, switchWorkspace } from "../../src/spa/components/WorkspaceSwitcher";
import type { SpaBoot } from "../../src/spa/boot";

const boot: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  role: "admin",
  workspaceRef: "acme",
  memberships: [
    { ref: "acme", name: "Acme", role: "owner" },
    { ref: "ws_7d41", name: "Side project", role: "member" },
  ],
};

type Recorder = {
  pushed: string[];
  events: string[];
  requests: unknown[];
  cookieWrites: string[];
  locationWrites: string[];
};

/** Install the browser faces `navigate` + the switcher touch, recording each. */
function withBrowser(pathname: string, search: string, run: () => void): Recorder {
  const rec: Recorder = { pushed: [], events: [], requests: [], cookieWrites: [], locationWrites: [] };
  const scope = globalThis as Record<string, unknown>;
  const savedFetch = globalThis.fetch;
  const saved = {
    window: scope.window,
    document: scope.document,
    PopStateEvent: scope.PopStateEvent,
  };
  const location: Record<string, unknown> = { pathname, search, assign: () => rec.locationWrites.push("assign"), replace: () => rec.locationWrites.push("replace") };
  Object.defineProperty(location, "href", {
    set: () => rec.locationWrites.push("href"),
    get: () => `${pathname}${search}`,
  });
  globalThis.fetch = (async (input: unknown) => {
    rec.requests.push(input);
    return new Response("{}");
  }) as typeof fetch;
  scope.window = {
    location,
    history: { pushState: (_state: unknown, _title: string, url: string) => rec.pushed.push(url) },
    dispatchEvent: (event: { type: string }) => {
      rec.events.push(event.type);
      return true;
    },
  };
  scope.PopStateEvent = class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
  scope.document = Object.defineProperty({}, "cookie", {
    get: () => "",
    set: (value: string) => rec.cookieWrites.push(value),
  });
  try {
    run();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete scope[key];
      else scope[key] = value;
    }
  }
  return rec;
}

describe("workspace switcher — URL-only switch", () => {
  test("rewrites only the workspace segment and re-renders from the path", () => {
    let result = false;
    const rec = withBrowser("/dashboard/acme/apps/thing/insights", "?tab=insights", () => {
      result = switchWorkspace("ws_7d41");
    });
    expect(result).toBe(true);
    // Only the ref moved: same page, same query.
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps/thing/insights?tab=insights"]);
    // The router re-renders off the synthetic popstate it listens for.
    expect(rec.events).toEqual(["popstate"]);
  });

  test("issues no request, no reload and no session/cookie write", () => {
    const rec = withBrowser("/dashboard/acme/members", "", () => {
      switchWorkspace("ws_7d41");
    });
    expect(rec.pushed).toHaveLength(1);
    expect(rec.requests).toEqual([]);
    expect(rec.locationWrites).toEqual([]);
    expect(rec.cookieWrites).toEqual([]);
  });

  test("a path with no workspace segment switches nothing", () => {
    const rec = withBrowser("/dashboard/apps", "", () => {
      expect(switchWorkspace("ws_7d41")).toBe(false);
    });
    expect(rec.pushed).toEqual([]);
    expect(rec.events).toEqual([]);
  });
});

describe("workspace switcher — the control's list", () => {
  test("one membership is not a choice: no control at all", () => {
    expect(buildWorkspaceSwitcherModel({ ...boot, memberships: [boot.memberships![0]!] }, "/dashboard/acme/apps")).toBeNull();
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps")).not.toBeNull();
  });

  test("marks the workspace the path names, else the boot ref", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_7d41/members");
    expect(model?.currentRef).toBe("ws_7d41");
    expect(model?.options).toEqual([
      { ref: "acme", name: "Acme" },
      { ref: "ws_7d41", name: "Side project" },
    ]);
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/apps")?.currentRef).toBe("acme");
  });
});

describe("workspace switcher — rendered surface", () => {
  test("renders nothing for a login with one membership", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, { model: buildWorkspaceSwitcherModel({ ...boot, memberships: [boot.memberships![0]!] }, "/dashboard/acme/apps") }),
    );
    expect(html).toBe("");
  });

  test("renders one labelled control listing the memberships (no href, so no navigation to bypass)", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, { model: buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps") }),
    );
    expect(html).toContain('aria-label="Workspace"');
    // The control is a Radix select trigger, never an anchor/form target.
    expect(html).toContain("data-slot=\"select-trigger\"");
    expect(html).not.toContain("<form");
  });

  test("the shell mounts it beside the sidebar wordmark", () => {
    const sidebar = readFileSync(join(import.meta.dir, "../../src/spa/components/AppSidebar.tsx"), "utf8");
    expect(sidebar).toContain("<WorkspaceSwitcher model={switcher} />");
    const layout = readFileSync(join(import.meta.dir, "../../src/spa/Layout.tsx"), "utf8");
    expect(layout).toContain("buildWorkspaceSwitcherModel(boot, pathname)");
    expect(layout).toContain("switcher={switcher}");
  });
});
