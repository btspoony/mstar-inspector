/**
 * Workspace switcher (the workspace-identifier work, 2026-10; the control now
 * sits in the top bar) — the URL-only navigation contract and the control's
 * surface.
 *
 * Picking another workspace must rewrite ONLY the workspace segment of the
 * current path and hand the new URL to the router; a path that names no
 * workspace gets no rewrite, so there the control NAVIGATES to the picked
 * workspace's Apps page. Executed proof, not source shapes: one `pushState`,
 * one synthetic `popstate`, zero requests, and no write to the address bar, the
 * cookie jar or the document.
 *
 * The menu's portalled rows (the current-row mark, the disabled item's reason)
 * are unreachable from a static render; they are pinned on a mounted render in
 * `shell-visual.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Layout } from "../../src/spa/Layout";
import { buildWorkspaceSwitcherModel, renameWorkspaceMembership, storedSlugForRef } from "../../src/spa/shell";
import { WorkspaceSwitcher, switchWorkspace } from "../../src/spa/components/WorkspaceSwitcher";
import { commitWorkspaceRename } from "../../src/spa/pages/SettingsPage";
import type { SpaBoot } from "../../src/spa/boot";

const boot: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  workspaceRef: "acme",
  deploymentMode: "saas",
  canCreateWorkspace: true,
  createWorkspaceBlockedReason: null,
  memberships: [
    // `acme` was renamed away from its id; `ws_7d41` still answers to both.
    // Each row carries its own plan, so the chip can follow the URL.
    { id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" },
    { id: "ws_7d41", slug: "ws_7d41", name: "Side project", role: "member", plan: "Unlimited" },
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

  test("a path with no workspace segment navigates to the picked workspace's Apps page", () => {
    // The root workbench has no workspace segment to rewrite: the control is a
    // navigator, and the picked row opens a real page of that workspace.
    const rec = withBrowser("/dashboard", "", () => {
      expect(switchWorkspace("ws_7d41", "apps")).toBe(true);
    });
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps"]);
    expect(rec.events).toEqual(["popstate"]);
    expect(rec.requests).toEqual([]);
  });
});

describe("workspace switcher — the control's list", () => {
  test("one membership is still a list: the control renders", () => {
    const model = buildWorkspaceSwitcherModel({ ...boot, memberships: [boot.memberships![0]!] }, "/dashboard/acme/apps");
    expect(model?.options).toEqual([{ ref: "ws_acme", name: "Acme" }]);
    expect(model?.currentRef).toBe("ws_acme");
  });

  test("no membership at all is not a choice: no control", () => {
    expect(buildWorkspaceSwitcherModel({ ...boot, memberships: [] }, "/dashboard/acme/apps")).toBeNull();
    expect(buildWorkspaceSwitcherModel({ locale: "en", login: null, name: null }, "/dashboard")).toBeNull();
  });

  test("marks the row a slug-addressed path names, and navigates to the id", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_7d41/members");
    expect(model?.currentRef).toBe("ws_7d41");
    expect(model?.options).toEqual([
      { ref: "ws_acme", name: "Acme" },
      { ref: "ws_7d41", name: "Side project" },
    ]);
    // A legacy slug path still names its row; the emitted ref is the id.
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps")?.currentRef).toBe("ws_acme");
  });

  test("marks the row an ID-addressed path names (the stable ref is the same workspace)", () => {
    // `ws_acme` is the stored id whose readable slug is `acme`: the path may
    // carry either, and both name the same row.
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_acme/apps");
    expect(model?.currentRef).toBe("ws_acme");
    expect(model?.options.map((option) => option.ref)).toEqual(["ws_acme", "ws_7d41"]);
  });

  test("an in-page slug rename leaves the emitted refs on the stable id", () => {
    // The switcher addresses every row by its id, so a slug rename rewrites no
    // option value; the patched row is still the one a legacy slug names.
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
    expect(model?.options.map((option) => option.ref)).toEqual(["ws_acme", "ws_7d41"]);
    expect(model?.currentRef).toBe("ws_acme");
    // The rename moved the readable ref only: the stable id is untouched.
    expect(live?.[0]).toEqual({
      id: "ws_acme",
      slug: "acme-labs",
      name: "Acme",
      role: "owner",
      plan: "Free",
    });
  });

  test("a path holding a just-renamed old slug shows no current row — never the first option", () => {
    // The workspace was renamed `acme` → `acme-labs`; a tab still on the old
    // slug names nothing this login lists, so no row may claim to be current.
    const renamed: SpaBoot = {
      ...boot,
      memberships: [
        { id: "ws_acme", slug: "acme-labs", name: "Acme", role: "owner", plan: "Free" },
        boot.memberships![1]!,
      ],
    };
    const model = buildWorkspaceSwitcherModel(renamed, "/dashboard/acme/apps");
    expect(model?.currentRef).toBeNull();
    // The control still renders: the path is switchable, only the current row
    // is unknown.
    expect(model?.options.map((option) => option.ref)).toEqual(["ws_acme", "ws_7d41"]);
  });

  test("a path with no workspace segment is a navigator, not a rewriter", () => {
    // `/dashboard` is the post-login landing and `/index.html` the shell
    // document addressed directly: neither has a segment to rewrite, so a pick
    // must OPEN that workspace's Apps page.
    for (const pathname of ["/dashboard", "/dashboard/apps", "/index.html"]) {
      const model = buildWorkspaceSwitcherModel(boot, pathname);
      expect(model?.target, pathname).toBe("apps");
      // Nothing is current: the URL names no workspace.
      expect(model?.currentRef, pathname).toBeNull();
    }
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps")?.target).toBe("replace");
  });

  test("an unrouted path navigates instead of rewriting into a second 404", () => {
    // `workspaceRefOf` reads `apps|members|api` as the second segment; a path
    // outside that family names no workspace page, so the control opens a real
    // one. A routed workspace path keeps the in-place rewrite.
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/nope")?.target).toBe("apps");
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps/thing")?.target).toBe("replace");
  });
});

function renderSwitcher(boot: SpaBoot, pathname: string): string {
  return renderToStaticMarkup(
    createElement(WorkspaceSwitcher, { model: buildWorkspaceSwitcherModel(boot, pathname), boot }),
  );
}

describe("workspace switcher — rendered surface", () => {
  test("renders no control for a login with no membership", () => {
    expect(renderSwitcher({ ...boot, memberships: [] }, "/dashboard/acme/apps")).toBe("");
  });

  test("renders one labelled menu trigger naming the current workspace (no href, so no navigation to bypass)", () => {
    const html = renderSwitcher(boot, "/dashboard/acme/apps");
    expect(html).toContain('aria-label="Workspace"');
    // The control is a Radix dropdown trigger, never an anchor/form target.
    expect(html).toContain('data-slot="dropdown-menu-trigger"');
    expect(html).toContain("Acme");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<a ");
  });

  test("the plan chip is a saas surface: rendered there, absent in self-hosted", () => {
    // D15/D20: mode-gated only — the plan is member-visible data in `saas`
    // whatever the tier, and `self-hosted` has no tier to show. The rows carry
    // plans in both renders; only the mode decides whether one is shown.
    expect(renderSwitcher({ ...boot, deploymentMode: "saas" }, "/dashboard/acme/apps")).toContain("Free");
    const selfHosted = renderSwitcher({ ...boot, deploymentMode: "self-hosted" }, "/dashboard/acme/apps");
    expect(selfHosted).toContain('aria-label="Workspace"');
    expect(selfHosted).not.toContain("Free");
  });

  test("a navigator names no workspace on the trigger — the label and no plan chip stand in", () => {
    const html = renderSwitcher(boot, "/dashboard");
    expect(html).toContain('aria-label="Workspace"');
    expect(html).not.toContain("Acme");
    // The chip belongs to a workspace's name; with no current row there is
    // nothing for it to qualify.
    expect(html).not.toContain("Free");
  });

  test("a path naming an unlisted ref names NO workspace — never a stand-in", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/gone/apps");
    expect(model?.currentRef).toBeNull();
    // The trigger names no workspace the URL does not name; the control's own
    // label stands in. The menu marks no row (pinned on the mounted menu in
    // shell-visual.test.ts, where the portalled rows are reachable).
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { model, boot }));
    expect(html).toContain('aria-label="Workspace"');
    expect(html).not.toContain("Acme");
    expect(html).toContain(">Workspace<");
    // No plan chip either: it qualifies a name, and this path names none.
    expect(html).not.toContain("Free");
  });

  test("the option values are the stable ids, so a slug-addressed page switches to the id", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps");
    expect(model?.options.map((option) => option.ref)).toEqual(["ws_acme", "ws_7d41"]);
    const record = withBrowser("/dashboard/acme/apps", "", () => {
      switchWorkspace("ws_7d41", model!.target);
    });
    expect(record.pushed).toEqual(["/dashboard/ws_7d41/apps"]);
  });

  test("the shell mounts it in the TOP BAR, not the sidebar header", () => {
    const pathname = "/dashboard/acme/apps";
    const html = renderToStaticMarkup(
      createElement(Layout, { boot, pathname, flash: null, children: createElement("p", null, "page") }),
    );
    const headerStart = html.indexOf("<header");
    const header = html.slice(headerStart, html.indexOf("</header>"));
    expect(headerStart).toBeGreaterThan(-1);
    expect(header).toContain('aria-label="Workspace"');
    // The wordmark keeps the sidebar header to itself.
    const sidebarHeader = html.slice(
      html.indexOf('data-slot="sidebar-header"'),
      html.indexOf('data-slot="sidebar-content"'),
    );
    expect(sidebarHeader).toContain("Morning Star Inspector");
    expect(sidebarHeader).not.toContain('aria-label="Workspace"');
  });
});

/**
 * The chip used to read the boot's own workspace, which a switch never
 * refreshes — so moving out of a Free workspace kept claiming `Free` on every
 * page of the new one. Both entry paths a switch can take are pinned here: the
 * in-place rewrite of the current path, and entering a workspace from a path
 * that names none.
 */
describe("workspace switcher — the plan chip follows the URL", () => {
  test("switching to a workspace with another plan shows that workspace's plan", () => {
    expect(renderSwitcher(boot, "/dashboard/acme/apps")).toContain("Free");
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps");
    expect(model?.currentRef).toBe("ws_acme");

    const rec = withBrowser("/dashboard/acme/apps", "", () => {
      switchWorkspace("ws_7d41", model!.target);
    });
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps"]);

    // The router re-renders from that pathname with the SAME boot document:
    // the chip must read the row the URL now names.
    const html = renderSwitcher(boot, "/dashboard/ws_7d41/apps");
    expect(html).toContain("Unlimited");
    expect(html).not.toContain("Free");
  });

  test("entering a workspace from the root path shows that workspace's plan", () => {
    // The root workbench names no workspace, so there is no chip to carry
    // over: the pick opens a real workspace page, and the chip follows it.
    expect(renderSwitcher(boot, "/dashboard")).not.toContain("Free");
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard");
    expect(model?.target).toBe("apps");

    const rec = withBrowser("/dashboard", "", () => {
      switchWorkspace("ws_7d41", model!.target);
    });
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps"]);

    const html = renderSwitcher(boot, "/dashboard/ws_7d41/apps");
    expect(html).toContain("Unlimited");
    expect(html).not.toContain("Free");
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
