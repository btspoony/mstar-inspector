import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Layout } from "../../src/spa/Layout";
import { buildWorkspaceSwitcherModel } from "../../src/spa/shell";
import { WorkspaceSwitcher, switchWorkspace } from "../../src/spa/components/WorkspaceSwitcher";
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
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps/thing/insights?tab=insights"]);
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

  test("a path with no workspace segment navigates to the picked workspace's repository overview", () => {
    const rec = withBrowser("/dashboard", "", () => {
      expect(switchWorkspace("ws_7d41", "repos")).toBe(true);
    });
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/repos"]);
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
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps")?.currentRef).toBe("ws_acme");
  });

  test("marks the row an ID-addressed path names (the stable ref is the same workspace)", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/ws_acme/apps");
    expect(model?.currentRef).toBe("ws_acme");
    expect(model?.options.map((option) => option.ref)).toEqual(["ws_acme", "ws_7d41"]);
  });

  test("a path naming a slug the operator has since changed shows no current row — never the first option", () => {
    const renamed: SpaBoot = {
      ...boot,
      memberships: [
        { id: "ws_acme", slug: "acme-labs", name: "Acme", role: "owner", plan: "Free" },
        boot.memberships![1]!,
      ],
    };
    const model = buildWorkspaceSwitcherModel(renamed, "/dashboard/acme/apps");
    expect(model?.currentRef).toBeNull();
    expect(model?.options.map((option) => option.ref)).toEqual(["ws_acme", "ws_7d41"]);
    expect(buildWorkspaceSwitcherModel(renamed, "/dashboard/ws_acme/apps")?.currentRef).toBe("ws_acme");
  });

  test("a path with no workspace segment is a navigator, not a rewriter", () => {
    for (const pathname of ["/dashboard", "/dashboard/apps", "/index.html"]) {
      const model = buildWorkspaceSwitcherModel(boot, pathname);
      expect(model?.target, pathname).toBe("repos");
      expect(model?.currentRef, pathname).toBeNull();
    }
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps")?.target).toBe("replace");
  });

  test("an unrouted path navigates instead of rewriting into a second 404", () => {
    expect(buildWorkspaceSwitcherModel(boot, "/dashboard/acme/nope")?.target).toBe("repos");
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
    expect(html).toContain('data-slot="dropdown-menu-trigger"');
    expect(html).toContain("Acme");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<a ");
  });

  test("the plan chip is a saas surface: rendered there, absent in self-hosted", () => {
    expect(renderSwitcher({ ...boot, deploymentMode: "saas" }, "/dashboard/acme/apps")).toContain("Free");
    const selfHosted = renderSwitcher({ ...boot, deploymentMode: "self-hosted" }, "/dashboard/acme/apps");
    expect(selfHosted).toContain('aria-label="Workspace"');
    expect(selfHosted).not.toContain("Free");
  });

  test("a navigator names no workspace on the trigger — the label and no plan chip stand in", () => {
    const html = renderSwitcher(boot, "/dashboard");
    expect(html).toContain('aria-label="Workspace"');
    expect(html).not.toContain("Acme");
    expect(html).not.toContain("Free");
  });

  test("a path naming an unlisted ref names NO workspace — never a stand-in", () => {
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/gone/apps");
    expect(model?.currentRef).toBeNull();
    const html = renderToStaticMarkup(createElement(WorkspaceSwitcher, { model, boot }));
    expect(html).toContain('aria-label="Workspace"');
    expect(html).not.toContain("Acme");
    expect(html).toContain(">Workspace<");
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
    const sidebarHeader = html.slice(
      html.indexOf('data-slot="sidebar-header"'),
      html.indexOf('data-slot="sidebar-content"'),
    );
    expect(sidebarHeader).toContain("Morning Star Inspector");
    expect(sidebarHeader).not.toContain('aria-label="Workspace"');
  });
});

describe("workspace switcher — the plan chip follows the URL", () => {
  test("switching to a workspace with another plan shows that workspace's plan", () => {
    expect(renderSwitcher(boot, "/dashboard/acme/apps")).toContain("Free");
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/acme/apps");
    expect(model?.currentRef).toBe("ws_acme");

    const rec = withBrowser("/dashboard/acme/apps", "", () => {
      switchWorkspace("ws_7d41", model!.target);
    });
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/apps"]);

    const html = renderSwitcher(boot, "/dashboard/ws_7d41/apps");
    expect(html).toContain("Unlimited");
    expect(html).not.toContain("Free");
  });

  test("entering a workspace from the root path shows that workspace's plan", () => {
    expect(renderSwitcher(boot, "/dashboard")).not.toContain("Free");
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard");
    expect(model?.target).toBe("repos");

    const rec = withBrowser("/dashboard", "", () => {
      switchWorkspace("ws_7d41", model!.target);
    });
    expect(rec.pushed).toEqual(["/dashboard/ws_7d41/repos"]);

    const html = renderSwitcher(boot, "/dashboard/ws_7d41/apps");
    expect(html).toContain("Unlimited");
    expect(html).not.toContain("Free");
  });
});
