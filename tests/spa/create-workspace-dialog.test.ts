import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { WorkspaceSwitcher } from "../../src/spa/components/WorkspaceSwitcher";
import { buildWorkspaceSwitcherModel } from "../../src/spa/shell";
import { installDom } from "./dom";

const boot: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  workspaceRef: "acme",
  deploymentMode: "saas",
  canCreateWorkspace: true,
  createWorkspaceBlockedReason: null,
  memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

type Post = { url: string; method: string; body: string };

const FREE_SLOT_REFUSAL =
  "This workspace was not created. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then create this one.";

async function openMenu(
  respond: (post: Post) => Response,
  overrides: Partial<SpaBoot> = {},
) {
  const { win, cleanup: closeDom } = installDom("http://localhost/dashboard/acme/apps");
  const posts: Post[] = [];
  const assigned: string[] = [];
  const savedFetch = globalThis.fetch;
  const savedAssign = win.location.assign.bind(win.location);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const post: Post = {
      url: String(input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    };
    posts.push(post);
    return respond(post);
  }) as typeof fetch;
  win.location.assign = (url: string | URL) => {
    assigned.push(String(url));
  };

  const live = { ...boot, ...overrides };
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      createElement(WorkspaceSwitcher, {
        model: buildWorkspaceSwitcherModel(live, "/dashboard/acme/apps"),
        boot: live,
      }),
    ),
  );
  const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]');
  await act(async () => {
    trigger?.dispatchEvent(
      new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
    );
  });
  const item = win.document.querySelector('[data-slot="dropdown-menu-item"]');
  return {
    win,
    posts,
    assigned,
    act,
    item,
    itemText: item?.textContent,
    clickNewWorkspace: async () => {
      if (win.document.querySelector('[data-slot="dropdown-menu-item"]') === null) {
        await act(async () => {
          trigger?.dispatchEvent(
            new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
          );
        });
      }
      const row = win.document.querySelector('[data-slot="dropdown-menu-item"]');
      await act(async () => {
        row?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
    },
    cancel: async () => {
      const target = [...win.document.querySelectorAll('[role="dialog"] button')].find(
        (button) => button.textContent === t("en", "common.cancel"),
      );
      await act(async () => {
        target?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
    },
    dialog: () => win.document.querySelector('[role="dialog"]'),
    submit: async (name: string) => {
      const input = win.document.querySelector("#create-workspace-name");
      const form = win.document.querySelector('[role="dialog"] form');
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, name);
        input?.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      await act(async () => {
        form?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      });
      await act(async () => {});
    },
    cleanup: async () => {
      globalThis.fetch = savedFetch;
      win.location.assign = savedAssign;
      await act(async () => root.unmount());
      closeDom();
    },
  };
}

function created(): Response {
  return new Response(
    JSON.stringify({ id: "ws_new", slug: "ws_new", name: "New one", role: "owner", homePath: "/dashboard/ws_new/repos" }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

describe("create from the switcher menu", () => {
  test("the item opens a dialog that posts one name field and lands on the new workspace's repository overview", async () => {
    const surface = await openMenu(() => created());
    try {
      expect(surface.dialog()).toBeNull();
      await surface.clickNewWorkspace();
      expect(surface.dialog()).not.toBeNull();
      expect(surface.dialog()?.textContent).toContain(t("en", "workspace.setupHeading"));
      expect(surface.dialog()?.querySelectorAll("input")).toHaveLength(1);

      await surface.submit("New one");

      expect(surface.posts).toHaveLength(1);
      expect(surface.posts[0]?.url).toBe("/dashboard/api/workspaces");
      expect(surface.posts[0]?.method).toBe("POST");
      expect(surface.posts[0]?.body).toBe("name=New+one");
      expect(surface.assigned).toEqual(["/dashboard/ws_new/repos"]);
    } finally {
      await surface.cleanup();
    }
  });

  test("a 409 free-slot refusal renders the shell's own reason copy, not the English body", async () => {
    const surface = await openMenu(() => new Response(FREE_SLOT_REFUSAL, { status: 409 }));
    try {
      await surface.clickNewWorkspace();
      await surface.submit("Second one");

      expect(surface.posts).toHaveLength(1);
      expect(surface.dialog()).not.toBeNull();
      const copy = t("en", "nav.newWorkspaceBlockedFreeSlot");
      expect(surface.dialog()?.querySelector('[role="alert"]')?.textContent).toBe(copy);
      expect(surface.dialog()?.textContent).not.toContain(FREE_SLOT_REFUSAL);
      expect(surface.assigned).toEqual([]);
    } finally {
      await surface.cleanup();
    }
  });

  test("a zh-CN shell states the free-slot refusal in Chinese", async () => {
    const surface = await openMenu(() => new Response(FREE_SLOT_REFUSAL, { status: 409 }), {
      locale: "zh_CN",
    });
    try {
      await surface.clickNewWorkspace();
      await surface.submit("Second one");

      const copy = t("zh_CN", "nav.newWorkspaceBlockedFreeSlot");
      expect(copy).not.toBe(t("en", "nav.newWorkspaceBlockedFreeSlot"));
      expect(surface.dialog()?.querySelector('[role="alert"]')?.textContent).toBe(copy);
      expect(surface.dialog()?.textContent).not.toContain(FREE_SLOT_REFUSAL);
    } finally {
      await surface.cleanup();
    }
  });

  test("a creation-closed 409 reads as the closed-creation reason copy", async () => {
    const closed =
      "This workspace was not created. Workspace creation is closed on this platform right now.";
    const surface = await openMenu(() => new Response(closed, { status: 409 }), { locale: "zh_CN" });
    try {
      await surface.clickNewWorkspace();
      await surface.submit("First one");

      expect(surface.dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
        t("zh_CN", "nav.newWorkspaceBlockedFlag"),
      );
    } finally {
      await surface.cleanup();
    }
  });

  test("an unrecognised 409 body still renders verbatim — the server's words are the copy", async () => {
    const surface = await openMenu(() => new Response("Some other refusal.", { status: 409 }), {
      locale: "zh_CN",
    });
    try {
      await surface.clickNewWorkspace();
      await surface.submit("Second one");

      expect(surface.dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Some other refusal.");
    } finally {
      await surface.cleanup();
    }
  });

  test("a non-409 body never renders verbatim — it reads as the localized failure copy", async () => {
    for (const [status, body] of [
      [400, "name must be 2-80 characters"],
      [500, "D1_ERROR: database is locked"],
      [200, "<!doctype html><title>Sign in</title>"],
    ] as const) {
      const surface = await openMenu(() => new Response(body, { status }), { locale: "zh_CN" });
      try {
        await surface.clickNewWorkspace();
        await surface.submit("Second one");

        const alert = surface.dialog()?.querySelector('[role="alert"]')?.textContent;
        expect(alert).toBe(t("zh_CN", "workspace.createFailed"));
        expect(surface.dialog()?.textContent).not.toContain(body);
        expect(surface.assigned).toEqual([]);
      } finally {
        await surface.cleanup();
      }
    }
  });

  test("Cancel after a 409 closes clean: the reopened dialog has no name and no stale refusal", async () => {
    const surface = await openMenu(() => new Response(FREE_SLOT_REFUSAL, { status: 409 }));
    try {
      await surface.clickNewWorkspace();
      await surface.submit("Second one");
      expect(surface.dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
        t("en", "nav.newWorkspaceBlockedFreeSlot"),
      );

      await surface.cancel();
      expect(surface.dialog()).toBeNull();

      await surface.clickNewWorkspace();
      expect(surface.dialog()).not.toBeNull();
      expect((surface.dialog()?.querySelector("#create-workspace-name") as HTMLInputElement | null)?.value).toBe("");
      expect(surface.dialog()?.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await surface.cleanup();
    }
  });

  test("at the free-slot cap the item stays disabled and opens no dialog", async () => {
    const surface = await openMenu(() => created(), {
      canCreateWorkspace: false,
      createWorkspaceBlockedReason: "free_slot",
    });
    try {
      expect(surface.item?.getAttribute("aria-disabled")).toBe("true");
      expect(surface.itemText).toContain(t("en", "nav.newWorkspaceBlockedFreeSlot"));
      await surface.clickNewWorkspace();
      expect(surface.dialog()).toBeNull();
      expect(surface.posts).toEqual([]);
    } finally {
      await surface.cleanup();
    }
  });

  test("self-hosted shows the same creation surface — only the free-slot rule is mode-gated", async () => {
    const surface = await openMenu(() => created(), {
      deploymentMode: "self-hosted",
    });
    try {
      expect(surface.item?.getAttribute("aria-disabled")).toBeNull();
      await surface.clickNewWorkspace();
      expect(surface.dialog()).not.toBeNull();
      expect(surface.dialog()?.querySelectorAll("input")).toHaveLength(1);
    } finally {
      await surface.cleanup();
    }
  });
});
