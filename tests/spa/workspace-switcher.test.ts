/**
 * Workspace switcher (plan 98 T3) — the URL-only navigation contract.
 *
 * Picking another workspace must rewrite ONLY the workspace segment of the
 * current path and hand the new URL to the router. Executed proof, not source
 * shapes: one `pushState`, one synthetic `popstate`, zero requests, and no
 * write to the address bar, the cookie jar or the document.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "../../src/spa/components/ui/sidebar";
import { AppSidebar } from "../../src/spa/components/AppSidebar";
import { buildSidebarModel, buildWorkspaceSwitcherModel, renameWorkspaceMembership, storedSlugForRef } from "../../src/spa/shell";
import { WorkspaceSwitcher, switchWorkspace } from "../../src/spa/components/WorkspaceSwitcher";
import { commitWorkspaceRename } from "../../src/spa/pages/SettingsPage";
import type { SpaBoot } from "../../src/spa/boot";

const boot: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  role: "admin",
  workspaceRef: "acme",
  memberships: [
    // `acme` was renamed away from its id; `ws_7d41` still answers to both.
    { id: "ws_acme", slug: "acme", name: "Acme", role: "owner" },
    { id: "ws_7d41", slug: "ws_7d41", name: "Side project", role: "member" },
  ],
};

type Recorder = {
  pushed: string[];
  replaced: string[];
  events: string[];
  requests: unknown[];
  cookieWrites: string[];
  locationWrites: string[];
};

/** Install the browser faces `navigate` + the switcher touch, recording each. */
function withBrowser(pathname: string, search: string, run: () => void, hash = ""): Recorder {
  const rec: Recorder = { pushed: [], replaced: [], events: [], requests: [], cookieWrites: [], locationWrites: [] };
  const scope = globalThis as Record<string, unknown>;
  const savedFetch = globalThis.fetch;
  const saved = {
    window: scope.window,
    document: scope.document,
    PopStateEvent: scope.PopStateEvent,
  };
  const location: Record<string, unknown> = { pathname, search, hash, assign: () => rec.locationWrites.push("assign"), replace: () => rec.locationWrites.push("replace") };
  Object.defineProperty(location, "href", {
    set: () => rec.locationWrites.push("href"),
    get: () => `${pathname}${search}${hash}`,
  });
  globalThis.fetch = (async (input: unknown) => {
    rec.requests.push(input);
    return new Response("{}");
  }) as typeof fetch;
  scope.window = {
    location,
    history: {
      pushState: (_state: unknown, _title: string, url: string) => rec.pushed.push(url),
      replaceState: (_state: unknown, _title: string, url: string) => rec.replaced.push(url),
    },
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

  test("preserves the query and the hash along with the path", () => {
    const rec = withBrowser("/dashboard/acme/apps/thing", "?tab=insights", () => {
      switchWorkspace("ws_7d41");
    }, "#runs");
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps/thing?tab=insights#runs"]);
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

  test("marks the row a slug-addressed path names, and navigates to the slug", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_7d41/members");
    expect(model?.currentRef).toBe("ws_7d41");
    expect(model?.options).toEqual([
      { ref: "acme", name: "Acme" },
      { ref: "ws_7d41", name: "Side project" },
    ]);
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps")?.currentRef).toBe("acme");
  });

  test("marks the row an ID-addressed path names (the stable ref is the same workspace)", () => {
    // `ws_acme` is the stored id whose readable slug is `acme`: the path may
    // carry either, and both name the same row.
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_acme/apps");
    expect(model?.currentRef).toBe("acme");
    expect(model?.options.map((option) => option.ref)).toEqual(["acme", "ws_7d41"]);
  });

  test("after an in-page rename the stale boot no longer offers the retired slug", () => {
    // `boot` still lists `acme` — the document's snapshot never refreshes — so
    // the rename must patch the list the switcher reads. Without the patch the
    // option value stays `acme` and the new path names no current row.
    let live = boot.memberships;
    const rec = withBrowser("/dashboard/acme/apps", "", () => {
      commitWorkspaceRename("acme-labs", (ref, slug) => {
        live = renameWorkspaceMembership(live, ref, slug);
      });
    });
    // The page stays on its own path under the new ref, as a replace (the old
    // ref answers 404 — Back must not return to it).
    expect(rec.replaced).toEqual(["/dashboard/acme-labs/apps"]);
    expect(rec.pushed).toEqual([]);
    const model = buildWorkspaceSwitcherModel({ ...boot, memberships: live }, "/dashboard/acme-labs/apps");
    expect(model?.options.map((option) => option.ref)).toEqual(["acme-labs", "ws_7d41"]);
    expect(model?.currentRef).toBe("acme-labs");
    // The rename moved the readable ref only: the stable id is untouched.
    expect(live?.[0]).toEqual({ id: "ws_acme", slug: "acme-labs", name: "Acme", role: "owner" });
  });

  test("a path holding a just-renamed old slug shows no current row — never the first option", () => {
    // The workspace was renamed `acme` → `acme-labs`; a tab still on the old
    // slug names nothing this login lists, so no row may claim to be current.
    const renamed: SpaBoot = {
      ...boot,
      memberships: [{ id: "ws_acme", slug: "acme-labs", name: "Acme", role: "owner" }, boot.memberships![1]!],
    };
    const model = buildWorkspaceSwitcherModel(renamed, "/dashboard/acme/apps");
    expect(model?.currentRef).toBeNull();
    // The control still renders: the path is switchable, only the current row
    // is unknown.
    expect(model?.options.map((option) => option.ref)).toEqual(["acme-labs", "ws_7d41"]);
  });

  test("no control on a path with no workspace segment to rewrite", () => {
    // `/dashboard` is the post-login landing of a multi-workspace deployment: a
    // control there would render and no-op every choice.
    for (const pathname of ["/dashboard", "/dashboard/apps", "/dashboard/apps/thing", "/index.html"]) {
      expect(buildWorkspaceSwitcherModel(boot, pathname), pathname).toBeNull();
    }
  });

  test("no control where only one of the two path grammars holds", () => {
    // `workspaceRefOf` reads `apps|members|api` as the second segment; a path
    // outside that family has no workspace route to switch, so the control
    // must not render even though `replaceWorkspaceRef` could rewrite it.
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/nope")).toBeNull();
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps/thing")).not.toBeNull();
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

  test("a path naming an unlisted ref renders NO current row — never a stand-in value", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/gone/apps");
    expect(model?.currentRef).toBeNull();
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { model }));
    // Radix marks `data-placeholder` only for an empty value: its presence pins
    // the honest empty trigger. A first-membership fallback would have made the
    // trigger claim a workspace the URL does not name.
    expect(html).toContain("data-placeholder");
    // The normal case stays controlled on the row the path names.
    const named = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, { model: buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps") }),
    );
    expect(named).not.toContain("data-placeholder");
  });

  test("the option values are the stored slugs, so an id-addressed page switches to a readable ref", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_acme/apps");
    expect(model?.currentRef).toBe("acme");
    const record = withBrowser("/dashboard/ws_acme/apps", "", () => {
      switchWorkspace(model!.currentRef!);
    });
    expect(record.pushed).toEqual(["/dashboard/acme/apps"]);
  });

  test("the shell mounts it beside the sidebar wordmark", () => {
    const pathname = "/dashboard/acme/apps";
    const html = renderToStaticMarkup(
      createElement(
        SidebarProvider,
        { defaultOpen: true },
        createElement(AppSidebar, {
          model: buildSidebarModel(boot, pathname),
          switcher: buildWorkspaceSwitcherModel(boot, pathname),
        }),
      ),
    );
    // The wordmark link comes first, then the switcher trigger — and both sit
    // in the sidebar header, above the nav list (not inside it).
    const headerStart = html.indexOf('data-slot="sidebar-header"');
    const header = html.slice(headerStart, html.indexOf('data-slot="sidebar-content"'));
    expect(headerStart).toBeGreaterThan(-1);
    expect(header).toContain(`href="${buildSidebarModel(boot, pathname).brandHref}"`);
    expect(header).toContain('aria-label="Workspace"');
    expect(header.indexOf('aria-label="Workspace"')).toBeGreaterThan(header.indexOf("href="));
  });

  test("no switcher in the shell on a path with no workspace segment", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidebarProvider,
        { defaultOpen: true },
        createElement(AppSidebar, {
          model: buildSidebarModel(boot, "/dashboard"),
          switcher: buildWorkspaceSwitcherModel(boot, "/dashboard"),
        }),
      ),
    );
    expect(html).not.toContain('aria-label="Workspace"');
  });
});

describe("slug card value — the stored slug, not the path segment", () => {
  test("resolves the membership's stored slug through either identifier", () => {
    // `acme` is a readable slug whose id is `ws_acme`; `ws_7d41` was never
    // renamed, so both forms name the same stored value.
    expect(storedSlugForRef(boot, "ws_acme")).toBe("acme");
    expect(storedSlugForRef(boot, "acme")).toBe("acme");
    expect(storedSlugForRef(boot, "ws_7d41")).toBe("ws_7d41");
  });

  test("after this page's own rename the new segment is the stored value", () => {
    // The boot still carries the pre-rename row, so the new segment falls
    // through to the fallback — the value the field must show, not the old slug.
    expect(storedSlugForRef(boot, "acme-labs")).toBe("acme-labs");
  });

  test("no workspace segment → no value to show", () => {
    expect(storedSlugForRef(boot, null)).toBe("");
  });
});
