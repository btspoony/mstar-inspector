/**
 * The repository surface's rendered faces (product spec J1/J2).
 *
 * Static SSR pins what the page shows, not how it wires:
 *   - the fixed 所有仓库 row first, with the live count and the per-repository
 *     rows behind it; the empty workspace still carries the fixed row plus the
 *     empty state;
 *   - the add dialog's five faces: zero App (guidance + jump link, confirm
 *     disabled), one App (fixed binding, select omitted), several Apps
 *     (dropdown), an installation with no repository (guidance + jump link), and
 *     a duplicate refusal (notice, confirm still enabled for the rest).
 *
 * The stateful dialog owns the fetches; `AddRepositoryDialogBody` is the body
 * with every state as a prop, which is what a DOM-less runner can render.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { type Element as DomElement, type Window as DomWindow } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import {
  AddRepositoryDialogBody,
  AddRepositoryDialog,
  repositoryCountLabel,
  TargetDetailPage,
  TargetsPage,
  TargetsView,
  targetStatusPill,
} from "../../src/spa/pages/TargetsPage";
import type { RepositoryOptionsState } from "../../src/spa/pages/TargetsPage";
import { parseTargetCreate, parseTargetDetailTab, targetDetailTabQuery } from "../../src/spa/pages/data";
import { TargetSettingsTab } from "../../src/spa/pages/TargetSettingsTab";
import type { InstallationRepositoryOption, RepositoryAppOption, TargetListRow } from "../../src/spa/pages/data";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const row = (overrides: Partial<TargetListRow> = {}): TargetListRow => ({
  target_id: "t-1",
  repo_id: 501,
  repo_owner: "acme",
  repo_name: "api",
  bot_id: "bot-1",
  app_name: "Acme Inspector",
  review_enabled: 1,
  follow_workspace_defaults: 1,
  last_reviewed_at: null,
  ...overrides,
});

const app = (overrides: Partial<RepositoryAppOption> = {}): RepositoryAppOption => ({
  app_id: 9401,
  bot_id: "bot-1",
  name: "Acme Inspector",
  ...overrides,
});

const repositories = (...rows: InstallationRepositoryOption[]): RepositoryOptionsState => ({
  state: "ok",
  repositories: rows,
  degraded: false,
});

function renderBody(props: {
  apps: RepositoryAppOption[];
  appId?: string;
  repos?: RepositoryOptionsState;
  existing?: number[];
  selected?: number[];
  notice?: { kind: "warn" | "error"; message: string } | null;
}): string {
  return withLocation("/dashboard/acme/targets", () =>
    renderToStaticMarkup(
      createElement(AddRepositoryDialogBody, {
        locale: "en",
        apps: props.apps,
        appId: props.appId ?? (props.apps[0] ? String(props.apps[0].app_id) : ""),
        repositories: props.repos ?? repositories(),
        existingRepoIds: new Set(props.existing ?? []),
        selectedRepoIds: new Set(props.selected ?? []),
        notice: props.notice ?? null,
        busy: false,
        onSelectApp: () => {},
        onToggleRepo: () => {},
        onRetryRepositories: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      }),
    ),
  );
}

/**
 * The confirm button's disabled state, read off the rendered markup. React SSR
 * writes the attribute as `disabled=""`; the button's class list also mentions
 * `disabled:` variants, so only the bare attribute proves the state.
 */
function confirmDisabled(markup: string): boolean {
  const confirm = new RegExp(
    `<button[^>]*>${t("en", "targets.addDialog.confirm")}</button>`,
  ).exec(markup);
  if (confirm === null) throw new Error("the dialog rendered no confirm button");
  return /\sdisabled=""/.test(confirm[0]);
}

describe("repository list (static SSR)", () => {
  test("the fixed 所有仓库 row leads, and each live target gets one row", () => {
    const markup = withLocation("/dashboard/acme/targets", () =>
      renderToStaticMarkup(
        createElement(TargetsView, {
          locale: "en",
          state: "ok",
          targets: [
            row({ target_id: "t-1", repo_name: "api", last_reviewed_at: "2026-01-01 00:00:00" }),
            row({ target_id: "t-2", repo_id: 502, repo_name: "web", review_enabled: 0 }),
          ],
          onRetry: () => {},
        }),
      ),
    );
    // The fixed row comes first, then the repositories in payload order.
    expect(markup.indexOf(t("en", "targets.allRepositories"))).toBeLessThan(
      markup.indexOf("acme/api"),
    );
    expect(markup).toContain(t("en", "targets.allRepositoriesMeta"));
    expect(markup).toContain("2 repositories");
    expect(markup).toContain('href="/dashboard/acme/targets/all"');
    expect(markup).toContain('href="/dashboard/acme/targets/t-1"');
    expect(markup).toContain('href="/dashboard/acme/targets/t-2"');
    // Status pills: reviewing and paused.
    expect(markup).toContain(t("en", "targets.status.reviewing"));
    expect(markup).toContain(t("en", "targets.status.paused"));
  });

  test("an empty workspace keeps the fixed row and states the empty case", () => {
    const markup = withLocation("/dashboard/acme/targets", () =>
      renderToStaticMarkup(
        createElement(TargetsView, { locale: "en", state: "ok", targets: [], onRetry: () => {} }),
      ),
    );
    expect(markup).toContain(t("en", "targets.allRepositories"));
    expect(markup).toContain("0 repositories");
    expect(markup).toContain(t("en", "targets.emptyTitle"));
    expect(markup).toContain(t("en", "targets.emptyDescription"));
  });

  test("a 待安装 row reports the discriminator instead of an invented name", () => {
    const markup = withLocation("/dashboard/acme/targets", () =>
      renderToStaticMarkup(
        createElement(TargetsView, {
          locale: "en",
          state: "ok",
          targets: [row({ repo_id: null, repo_owner: null, repo_name: null })],
          onRetry: () => {},
        }),
      ),
    );
    expect(markup).toContain(t("en", "targets.status.uninstalled"));
    expect(markup).toContain(t("en", "targets.metaUninstalled"));
    // `null`/`null` must not render as a repository named "null/null".
    expect(markup).not.toContain("null/null");
  });

  test("a load failure shows the error face with the fixed row still reachable", () => {
    const markup = withLocation("/dashboard/acme/targets", () =>
      renderToStaticMarkup(
        createElement(TargetsView, { locale: "en", state: "error", targets: null, onRetry: () => {} }),
      ),
    );
    expect(markup).toContain(t("en", "common.loadFailed"));
    expect(markup).toContain(t("en", "common.retry"));
  });
});

describe("list helpers", () => {
  test("the count pill pluralizes on the live target count", () => {
    expect(repositoryCountLabel("en", 0)).toBe("0 repositories");
    expect(repositoryCountLabel("en", 1)).toBe("1 repository");
    expect(repositoryCountLabel("en", 3)).toBe("3 repositories");
    expect(repositoryCountLabel("zh_CN", 2)).toContain("2");
  });

  test("a paused target outranks its missing repository identity only after it", () => {
    // 待安装 is the first discriminator: a row with no repo_id is awaiting its
    // delivery whatever its pause column says.
    expect(targetStatusPill("en", row({ repo_id: null })).label).toBe(t("en", "targets.status.uninstalled"));
    expect(targetStatusPill("en", row({ review_enabled: 0 })).label).toBe(t("en", "targets.status.paused"));
    expect(targetStatusPill("en", row()).label).toBe(t("en", "targets.status.reviewing"));
  });
});

describe("add-repository dialog (static SSR)", () => {
  test("zero Apps: guidance and a jump link, no select, confirm disabled", () => {
    const markup = renderBody({ apps: [] });
    expect(markup).toContain(t("en", "targets.addDialog.noApps"));
    expect(markup).toContain(t("en", "targets.addDialog.goToApps"));
    expect(markup).toContain('href="/dashboard/acme/apps"');
    // No select: there is nothing to choose, and no way to proceed.
    expect(markup).not.toContain(t("en", "targets.addDialog.appLabel"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("exactly one App states the binding instead of a select", () => {
    const markup = renderBody({ apps: [app()], repos: repositories({ repo_id: 501, owner: "acme", name: "api" }) });
    expect(markup).toContain(t("en", "targets.addDialog.binding").replace("{app}", "Acme Inspector"));
    expect(markup).not.toContain(t("en", "targets.addDialog.appLabel"));
  });

  test("several Apps render the dropdown instead of a fixed binding", () => {
    const markup = renderBody({
      apps: [app(), app({ app_id: 9402, bot_id: "bot-2", name: "Second App" })],
      repos: repositories({ repo_id: 501, owner: "acme", name: "api" }),
    });
    expect(markup).toContain(t("en", "targets.addDialog.appLabel"));
    // The choice is a control here, not stated copy: that is the whole
    // difference from the single-App face (whose items only mount on open, so
    // the combobox itself is the assertion that matters).
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain(t("en", "targets.addDialog.binding").replace("{app}", "Acme Inspector"));
  });

  test("an installation with no repositories explains the dead end and disables confirm", () => {
    const markup = renderBody({ apps: [app()], repos: repositories() });
    expect(markup).toContain(t("en", "targets.addDialog.noInstallationRepos"));
    // The label's apostrophe is HTML-escaped in static markup; the destination
    // is the assertion that matters.
    expect(markup).toContain("installed tab");
    expect(markup).toContain('href="/dashboard/acme/apps/9401?tab=installations"');
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("a repository fetch failure offers a retry and disables confirm", () => {
    const markup = renderBody({ apps: [app()], repos: { state: "error" } });
    // Same escaping note: assert the prefix before the apostrophe.
    expect(markup).toContain("Could not load this App");
    expect(markup).toContain(t("en", "common.retry"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("already-added repositories are visible, disabled and tagged", () => {
    const markup = renderBody({
      apps: [app()],
      repos: repositories(
        { repo_id: 501, owner: "acme", name: "api" },
        { repo_id: 502, owner: "acme", name: "web" },
      ),
      existing: [501],
    });
    expect(markup).toContain("acme/api");
    expect(markup).toContain(t("en", "targets.addDialog.alreadyAdded"));
    const inputs = markup.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("disabled");
    expect(inputs[1]).not.toContain("disabled");
  });

  test("a zero selection keeps confirm disabled even with repositories offered", () => {
    const markup = renderBody({
      apps: [app()],
      repos: repositories({ repo_id: 501, owner: "acme", name: "api" }),
    });
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("a duplicate refusal reports what existed and keeps confirm usable for the rest", () => {
    const markup = renderBody({
      apps: [app()],
      repos: repositories(
        { repo_id: 501, owner: "acme", name: "api" },
        { repo_id: 502, owner: "acme", name: "web" },
      ),
      selected: [502],
      notice: {
        kind: "warn",
        message: t("en", "targets.addDialog.duplicates", { names: "acme/api" }),
      },
    });
    expect(markup).toContain(t("en", "targets.addDialog.duplicates").replace("{names}", "acme/api"));
    expect(confirmDisabled(markup)).toBe(false);
  });

  test("a degraded answer says the list may be incomplete", () => {
    const markup = renderBody({
      apps: [app()],
      repos: { state: "ok", repositories: [{ repo_id: 501, owner: "acme", name: "api" }], degraded: true },
    });
    expect(markup).toContain(t("en", "targets.addDialog.degraded"));
  });
});

// --- mounted (stateful dialog + page) --------------------------------------

type Wire = { url: string; method: string; body: string | null };

const wireJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** One installation listing, as the dialog's read consumes it. */
const listing = (rows: Array<{ repo_id: number; owner: string; name: string }>) =>
  wireJson({ repositories: rows, degraded: false });

const BOOT: SpaBoot = {
  locale: "en",
  login: "mallory",
  name: null,
  workspaceRef: "acme",
  memberships: [{ id: "acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

/**
 * Mount `element` on the targets URL with a recorded fetch stub. Teardown
 * unmounts, restores `fetch` and removes the window, including on a throw.
 */
async function mountTargets(
  element: ReturnType<typeof createElement>,
  respond: (wire: Wire) => Response | Promise<Response>,
) {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/targets");
  const realFetch = globalThis.fetch;
  const sent: Wire[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const wire: Wire = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    };
    sent.push(wire);
    return await respond(wire);
  }) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const settle = async () => {
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
  };
  await act(async () => root.render(element));
  await settle();
  return {
    win,
    sent,
    /** Re-render the page (a workspace switch re-derives its base from the URL). */
    rerender: async (next: ReturnType<typeof createElement>) => {
      await act(async () => root.render(next));
      await settle();
    },
    dialog: (): DomElement | null => win.document.querySelector('[role="dialog"]') as unknown as DomElement | null,
    text: () => container.textContent ?? "",
    click: async (node: DomElement | null | undefined) => {
      await act(async () => {
        node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await settle();
    },
    /** Open a Radix Select (pointerdown is what it listens for), then pick by label. */
    pickApp: async (label: string) => {
      const trigger = win.document.querySelector('[role="combobox"]');
      await act(async () => {
        trigger?.dispatchEvent(
          new win.PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerType: "mouse",
          }),
        );
        trigger?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (node) => node.textContent === label,
      );
      await act(async () => {
        option?.dispatchEvent(
          new win.PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerType: "mouse",
          }),
        );
        option?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

const confirmButton = (win: DomWindow): DomElement | null => {
  const dialog = win.document.querySelector('[role="dialog"]');
  const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
  return buttons.find((button) => button.textContent === t("en", "targets.addDialog.confirm")) ?? null;
};

describe("add-repository dialog (mounted)", () => {
  test("a stale repository read cannot overwrite the App now selected", async () => {
    let releaseFirst: () => void = () => {};
    const firstAnswer = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(listing([{ repo_id: 501, owner: "acme", name: "api" }]));
    });
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app(), app({ app_id: 9402, bot_id: "bot-2", name: "Second App" })],
        existingRepoIds: new Set<number>(),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) => {
        if (wire.url.endsWith("/api/apps/9401/installation-repositories")) return firstAnswer;
        if (wire.url.endsWith("/api/apps/9402/installation-repositories")) {
          return listing([{ repo_id: 502, owner: "acme", name: "web" }]);
        }
        return wireJson({});
      },
    );
    try {
      // Switch to the second App while the first App's walk is still in flight.
      await view.pickApp("Second App");
      expect(view.dialog()?.textContent ?? "").toContain("acme/web");

      // The slow answer for the App the user left lands last and must be dropped.
      releaseFirst();
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain("acme/web");
      expect(text).not.toContain("acme/api");
    } finally {
      await view.unmount();
    }
  });

  test("a duplicate refusal keeps the dialog open with its notice across the refresh", async () => {
    // The refresh the add triggers is held open: a reload that put the page back
    // on its skeleton would unmount the dialog (and its notice) right here.
    let releaseRefresh: () => void = () => {};
    const heldRefresh = new Promise<Response>((resolve) => {
      releaseRefresh = () => resolve(wireJson({ targets: [row()] }));
    });
    let afterPost = false;
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/targets") && wire.method === "POST") {
        afterPost = true;
        return wireJson({ created: [], duplicates: [{ repo_id: 501, owner: "acme", name: "api" }] }, 201);
      }
      if (wire.url.endsWith("/api/targets")) {
        return afterPost ? heldRefresh : wireJson({ targets: [] });
      }
      if (wire.url.endsWith("/api/apps")) {
        return wireJson({
          viewer: { login: "mallory", role: "admin" },
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/installation-repositories")) {
        return listing([{ repo_id: 501, owner: "acme", name: "api" }]);
      }
      return wireJson({});
    });
    try {
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      await view.click(addButton);
      await view.click(view.win.document.querySelector('input[type="checkbox"]') as unknown as DomElement | null);
      await view.click(confirmButton(view.win));

      // While the list refresh is still in flight the dialog is still mounted
      // and still carries the refusal notice.
      const pending = view.dialog();
      expect(pending).not.toBeNull();
      expect(pending?.textContent ?? "").toContain(
        t("en", "targets.addDialog.duplicates").replace("{names}", "acme/api"),
      );
      expect(view.win.document.querySelector('[data-slot="page-skeleton"]')).toBeNull();

      // ...and it survives the refresh landing.
      releaseRefresh();
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      const landed = view.dialog();
      expect(landed).not.toBeNull();
      expect(landed?.textContent ?? "").toContain(
        t("en", "targets.addDialog.duplicates").replace("{names}", "acme/api"),
      );
      expect(view.win.document.querySelector('[data-slot="page-skeleton"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

describe("target create parser", () => {
  test("keeps the created rows, not just their count", () => {
    const parsed = parseTargetCreate(
      JSON.stringify({
        created: [{ target_id: "t-9", repo_id: 901, repo_owner: "acme", repo_name: "new" }],
        duplicates: [{ repo_id: 501, owner: "acme", name: "api" }],
      }),
    );
    expect(parsed?.created).toEqual([
      { target_id: "t-9", repo_id: 901, repo_owner: "acme", repo_name: "new" },
    ]);
    expect(parsed?.duplicates).toEqual([{ repo_id: 501, owner: "acme", name: "api" }]);
  });
});

describe("the list failure face", () => {
  test("a workspace switch mid-read drops the answer for the workspace left behind", async () => {
    // The first workspace's read is held open across the navigation, so it
    // lands last — after the new workspace's rows are already on screen.
    let releaseStale: () => void = () => {};
    const staleRead = new Promise<Response>((resolve) => {
      releaseStale = () => resolve(wireJson({ targets: [row()] }));
    });
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.startsWith("/dashboard/acme/api/targets")) return staleRead;
      if (wire.url.endsWith("/api/targets")) {
        return wireJson({ targets: [row({ target_id: "t-2", repo_owner: "beta", repo_name: "site" })] });
      }
      return wireJson({});
    });
    try {
      view.win.history.pushState(null, "", "/dashboard/beta/targets");
      await view.rerender(createElement(TargetsPage, { boot: BOOT }));
      expect(view.text()).toContain("beta/site");

      releaseStale();
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      expect(view.text()).toContain("beta/site");
      expect(view.text()).not.toContain("acme/api");
    } finally {
      await view.unmount();
    }
  });

  test("a failed list read offers no add dialog (an empty App list is not 'no apps')", async () => {
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), () =>
      wireJson({ error: "boom" }, 500),
    );
    try {
      expect(view.text()).toContain(t("en", "common.loadFailed"));
      expect(
        [...view.win.document.querySelectorAll("button")].some(
          (button) => button.textContent === t("en", "targets.add"),
        ),
      ).toBe(false);
    } finally {
      await view.unmount();
    }
  });
});

/**
 * The 评审配置 tab (D16 / product spec J4): what the target RUNS
 * with while inheriting, and the same controls editable once it opts out. The
 * only DOM facts asserted are the ones a reader would check — read-only
 * controls, the follow line, the two switches.
 */
function targetPayload(
  follow: 0 | 1,
  overrides: { review_enabled?: 0 | 1; verdictsReadable?: boolean; reviewDrafts?: boolean } = {},
) {
  const readable = overrides.verdictsReadable ?? true;
  const draftSwitch: 0 | 1 = overrides.reviewDrafts === false ? 0 : 1;
  return {
    target: {
      target_id: "t-1",
      repo_owner: "acme",
      repo_name: "api",
      app_name: "Acme Inspector",
      review_enabled: overrides.review_enabled ?? 1,
      follow_workspace_defaults: follow,
      review_drafts: draftSwitch,
    },
    effective: {
      trigger_mode: "every_push" as const,
      review_level: "deep" as const,
      check_min_score: 45,
      // An unreadable stored list arrives as the server's empty placeholder.
      check_pass_verdicts: readable ? ["ship it"] : [],
      check_pass_verdicts_readable: readable,
      reviewDrafts: overrides.reviewDrafts ?? true,
    },
    defaults: {
      trigger_mode: "open" as const,
      review_level: "default" as const,
      check_min_score: 60,
      check_pass_verdicts: ["ship it", "blocked"],
      check_pass_verdicts_readable: true,
    },
  };
}

function renderSettingsTab(
  follow: 0 | 1,
  reviewEnabled: 0 | 1 = 1,
  verdictsReadable = true,
): string {
  return withLocation("/dashboard/acme/targets/t-1", () =>
    renderToStaticMarkup(
      createElement(TargetSettingsTab, {
        locale: "en",
        payload: targetPayload(follow, {
          review_enabled: reviewEnabled,
          verdictsReadable,
        }),
        onReload: async () => true,
        onNotice: () => {},
      }),
    ),
  );
}

/** The disabled inputs of a rendered face (SSR writes the bare attribute). */
function disabledInputs(markup: string): number {
  return [...markup.matchAll(/<input[^>]*>/g)].filter((match) => /\sdisabled=""/.test(match[0])).length;
}

describe("target settings tab (static SSR)", () => {
  test("an inheriting target shows the effective values read-only plus the follow line", () => {
    const markup = renderSettingsTab(1);
    // The effective policy, not the workspace default beside it.
    expect(markup).toContain("Every push");
    expect(markup).toContain("Deep");
    expect(markup).toContain('value="45"');
    // The policy cluster's controls are all disabled — the score field and the
    // four verdict boxes — while the three admission switches (draft,
    // inheritance, pause) stay operable: 8 inputs, 5 of them disabled. The
    // draft switch is target-owned (D12), so inheriting does not lock it.
    const inputs = [...markup.matchAll(/<input[^>]*>/g)];
    expect(inputs.length).toBe(8);
    expect(disabledInputs(markup)).toBe(5);
    expect(markup).toContain("Following the workspace defaults");
    expect(markup).toContain(t("en", "settings.reviewGateSave"));
  });

  test("an explicit target renders the same controls enabled and no follow line", () => {
    const markup = renderSettingsTab(0);
    expect(disabledInputs(markup)).toBe(0);
    expect(markup).not.toContain("Following the workspace defaults");
    expect(markup).toContain("Every push");
  });

  test("the pause switch reflects review_enabled", () => {
    const paused = renderSettingsTab(0, 0);
    expect(paused).toContain(t("en", "settings.resumeReviews"));
    const running = renderSettingsTab(0, 1);
    expect(running).toContain(t("en", "settings.pauseReviews"));
  });

  test("an unreadable stored gate states the recovery copy and offers no save", () => {
    // The server sent the fail-closed placeholder, so the gate has no value to
    // edit — and no policy save may round-trip (a snapshot would persist it).
    const markup = renderSettingsTab(0, 1, false);
    // The copy's apostrophe is HTML-escaped in the markup.
    expect(markup).toContain("stored review gate could not be read");
    expect(markup).not.toContain(t("en", "settings.reviewGateSave"));
    expect(markup).not.toContain('type="number"');
    // Three switches survive — draft, inheritance, pause — and inheritance is
    // locked: turning it off snapshots the placeholder into the row. The draft
    // switch names no policy column, so it stays operable.
    const inputs = [...markup.matchAll(/<input[^>]*>/g)];
    expect(inputs.length).toBe(3);
    expect(disabledInputs(markup)).toBe(1);
    expect(markup).toContain(t("en", "settings.pauseReviews"));
    expect(markup).toContain(t("en", "settings.reviewDrafts"));
  });
});

/**
 * The detail page's wiring: the three tabs, the
 * not-found face a 404 renders, and the settings tab reading the payload the
 * page loaded. Asserted on the page, not the tab component — the tab's own
 * faces are pinned above.
 */
async function mountDetail(
  respond: (wire: Wire) => Response | Promise<Response>,
  options: { path?: string; targetId?: string } = {},
) {
  const targetId = options.targetId ?? "t-1";
  const { win, cleanup } = installDom(
    `http://localhost${options.path ?? `/dashboard/acme/targets/${targetId}`}`,
  );
  const realFetch = globalThis.fetch;
  const sent: Wire[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const wire: Wire = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    };
    sent.push(wire);
    return await respond(wire);
  }) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const settle = async () => {
    for (let flush = 0; flush < 6; flush += 1) await act(async () => {});
  };
  await act(async () => root.render(createElement(TargetDetailPage, { boot: BOOT, targetId })));
  await settle();
  return {
    win,
    sent,
    /** Re-render the page on another address segment (the switcher's navigation). */
    rerender: async (next: string) => {
      await act(async () => root.render(createElement(TargetDetailPage, { boot: BOOT, targetId: next })));
      await settle();
    },
    tabs: () => [...win.document.querySelectorAll('[role="tab"]')].map((node) => node.textContent),
    activeTab: () => win.document.querySelector('[role="tab"][data-state="active"]')?.textContent,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

describe("repository detail page (mounted)", () => {
  test("the draft switch posts only review_drafts and survives the reload while inheriting", async () => {
    // The D12 face: the switch is target-owned, so its save names exactly one
    // field, never `follow`, and an inheriting target keeps the new value.
    let draftOn = true;
    const view = await mountDetail((wire) => {
      if (wire.method === "POST") {
        expect(JSON.parse(wire.body ?? "null")).toEqual({ review_drafts: false });
        expect(wire.url).toBe("/dashboard/acme/api/targets/t-1");
        draftOn = false;
        return wireJson(targetPayload(1, { reviewDrafts: false }));
      }
      return wire.url.endsWith("/api/targets/t-1")
        ? wireJson(targetPayload(1, { reviewDrafts: draftOn }))
        : wireJson({}, 500);
    });
    /** The draft switch, found by the label it is bound to. */
    const draftSwitch = (): HTMLInputElement | null =>
      [...view.win.document.querySelectorAll("label")]
        .find((node) => node.textContent === t("en", "settings.reviewDrafts"))
        ?.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement | null;
    try {
      expect(draftSwitch()?.checked).toBe(true);
      // Inheriting locks the policy cluster, not this admission switch.
      expect(draftSwitch()?.disabled).toBe(false);

      await act(async () => {
        draftSwitch()?.dispatchEvent(
          new view.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
        );
      });
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});

      expect(view.sent.filter((wire) => wire.method === "POST")).toHaveLength(1);
      // The reload painted the stored off value with `follow` still 1.
      expect(draftSwitch()?.checked).toBe(false);
      expect(view.text()).toContain("Following the workspace defaults");
    } finally {
      await view.unmount();
    }
  });

  test("renders the three tabs and hands the loaded payload to the settings tab", async () => {
    const view = await mountDetail((wire) =>
      wire.url.endsWith("/api/targets/t-1") ? wireJson(targetPayload(1)) : wireJson({}, 500),
    );
    try {
      expect(view.tabs()).toEqual([
        t("en", "targets.settings.heading"),
        t("en", "targets.tabInsights"),
        t("en", "targets.tabPullRequests"),
      ]);
      // The settings panel is the default face and renders the payload's
      // EFFECTIVE policy (Every push / 45), not the defaults beside it.
      expect(view.text()).toContain("Every push");
      const score = view.win.document.querySelector('input[type="number"]');
      expect((score as unknown as { value: string } | null)?.value).toBe("45");
    } finally {
      await view.unmount();
    }
  });

  test("a read for the target the operator left cannot paint over the one now open", async () => {
    // The first target's read is held open across the navigation; its answer
    // lands last and must be dropped rather than shown under the new address.
    let releaseStale: () => void = () => {};
    const staleRead = new Promise<Response>((resolve) => {
      releaseStale = () => resolve(wireJson(targetPayload(1)));
    });
    const view = await mountDetail((wire) =>
      wire.url.endsWith("/api/targets/t-1") ? staleRead : wireJson(workspaceDefaults()),
    );
    try {
      // Navigate to the fixed 所有仓库 entry while t-1 is still in flight.
      await view.rerender("all");
      expect(view.text()).toContain(t("en", "targets.allRepositories"));

      releaseStale();
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});
      expect(view.text()).toContain(t("en", "targets.allRepositories"));
      expect(view.text()).not.toContain("acme/api");
    } finally {
      await view.unmount();
    }
  });

  test("a 404 payload renders the not-found face with the way back to the list", async () => {
    const view = await mountDetail(() => wireJson({ error: "unknown target" }, 404));
    try {
      expect(view.text()).toContain(t("en", "common.error.notFoundTitle"));
      // No retry: the address names no target of this workspace, so the only
      // way out is the list.
      expect(view.text()).not.toContain(t("en", "common.retry"));
      expect(view.win.document.querySelector("a")?.getAttribute("href")).toBe("/dashboard/acme/targets");
    } finally {
      await view.unmount();
    }
  });
});

/**
 * The fixed 所有仓库 entry (`…/targets/all`, product spec J1/J4): the workspace
 * defaults form — no inheritance switch, no pause — over the workspace-scoped
 * 洞察 / 拉取请求 tabs, with the live count in the header.
 */
const workspaceDefaults = (overrides: Record<string, unknown> = {}) => ({
  defaults: {
    trigger_mode: "open" as const,
    review_level: "default" as const,
    check_min_score: 60,
    check_pass_verdicts: ["ship it", "blocked"],
    check_pass_verdicts_readable: true,
    ...overrides,
  },
  target_count: 3,
});

describe("all-repositories detail (mounted)", () => {
  test("renders the defaults form, the workspace tabs and the live count", async () => {
    const view = await mountDetail(
      (wire) => (wire.url.endsWith("/api/targets/all") ? wireJson(workspaceDefaults()) : wireJson({}, 500)),
      { path: "/dashboard/acme/targets/all", targetId: "all" },
    );
    try {
      expect(view.text()).toContain(t("en", "targets.allRepositories"));
      expect(view.text()).toContain(t("en", "targets.repositoryCountMany", { count: 3 }));
      expect(view.tabs()).toEqual([
        t("en", "targets.settings.heading"),
        t("en", "targets.tabInsights"),
        t("en", "targets.tabPullRequests"),
      ]);
      // The workspace defaults, editable — and the two per-target switches are
      // absent, because neither inherits nor pauses anything at this level.
      // The draft switch is target-owned (D12), so it is absent too.
      expect(view.text()).toContain(t("en", "settings.triggerModeOpen"));
      expect(view.text()).not.toContain(t("en", "settings.pauseReviews"));
      expect(view.text()).not.toContain(t("en", "targets.settings.follow"));
      expect(view.text()).not.toContain(t("en", "settings.reviewDrafts"));
      const score = view.win.document.querySelector('input[type="number"]');
      expect((score as unknown as { value: string } | null)?.value).toBe("60");
      expect((score as unknown as { disabled: boolean } | null)?.disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  test("a non-manager gets the same defaults read-only", async () => {
    const member = {
      ...BOOT,
      memberships: [{ id: "acme", slug: "acme", name: "Acme", role: "member" as const, plan: "Free" }],
    };
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/targets/all");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => wireJson(workspaceDefaults())) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const settle = async () => {
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});
    };
    await act(async () =>
      root.render(createElement(TargetDetailPage, { boot: member, targetId: "all" })),
    );
    await settle();
    try {
      const score = win.document.querySelector('input[type="number"]');
      expect((score as unknown as { disabled: boolean } | null)?.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a policy pick posts exactly that one field to the defaults route", async () => {
    const view = await mountDetail(
      (wire) =>
        wire.method === "POST"
          ? wireJson({ defaults: workspaceDefaults().defaults })
          : wire.url.endsWith("/api/targets/all")
            ? wireJson(workspaceDefaults())
            : wireJson({}, 500),
      { path: "/dashboard/acme/targets/all", targetId: "all" },
    );
    try {
      const manual = [...view.win.document.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "settings.triggerModeManual"),
      );
      await act(async () => {
        manual?.dispatchEvent(
          new view.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      const post = view.sent.find((wire) => wire.method === "POST");
      expect(post?.url).toBe("/dashboard/acme/api/targets/defaults");
      // No `follow` companion: nothing at this level inherits.
      expect(JSON.parse(post?.body ?? "null")).toEqual({ trigger_mode: "manual" });
    } finally {
      await view.unmount();
    }
  });

  test("?tab=insights opens the insights tab, and picking a tab writes it to the address", async () => {
    const view = await mountDetail(
      (wire) => (wire.url.endsWith("/api/targets/all") ? wireJson(workspaceDefaults()) : wireJson({}, 500)),
      { path: "/dashboard/acme/targets/all?tab=insights", targetId: "all" },
    );
    try {
      expect(view.activeTab()).toBe(t("en", "targets.tabInsights"));
      const prs = [...view.win.document.querySelectorAll('[role="tab"]')].find(
        (node) => node.textContent === t("en", "targets.tabPullRequests"),
      );
      await act(async () => {
        prs?.dispatchEvent(
          new view.win.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        prs?.dispatchEvent(
          new view.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await act(async () => {});
      expect(view.win.location.search).toBe("?tab=pull-requests");
    } finally {
      await view.unmount();
    }
  });
});

describe("repository detail tab URL state", () => {
  test("parse and format round-trip, and the bare path is the settings tab", () => {
    expect(parseTargetDetailTab("")).toBe("settings");
    expect(parseTargetDetailTab("?tab=installations")).toBe("settings");
    for (const tab of ["settings", "insights", "pull-requests"] as const) {
      expect(parseTargetDetailTab(targetDetailTabQuery(tab))).toBe(tab);
    }
    expect(targetDetailTabQuery("settings")).toBe("");
    expect(targetDetailTabQuery("insights")).toBe("?tab=insights");
  });
});
