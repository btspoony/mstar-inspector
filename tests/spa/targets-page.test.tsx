import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { type Element as DomElement, type Window as DomWindow } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { formatRelativeTime } from "../../src/spa/relative-time";
import {
  AddRepositoryDialogBody,
  AddRepositoryDialog,
  REPOSITORY_LIST_CAP,
  repositoryCountLabel,
  TargetDetailPage,
  TargetsPage,
  TargetsView,
  targetStatusPill,
} from "../../src/spa/pages/TargetsPage";
import type { InstallationsState, RepositoryOptionsState } from "../../src/spa/pages/TargetsPage";
import { parseTargetCreate, parseTargetDetailTab, targetDetailTabQuery } from "../../src/spa/pages/data";
import { TargetSettingsTab } from "../../src/spa/pages/TargetSettingsTab";
import type {
  InstallationRepository,
  InstallationRepositoryOption,
  RepositoryAppOption,
  TargetListRow,
} from "../../src/spa/pages/data";
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
  reviews_total: 0,
  reviews_7d: 0,
  ...overrides,
});

const app = (overrides: Partial<RepositoryAppOption> = {}): RepositoryAppOption => ({
  app_id: 9401,
  bot_id: "bot-1",
  name: "Acme Inspector",
  slug: "acme-inspector",
  ...overrides,
});

const installations = (
  rows: Array<{ installation_id: number; account_login: string | null; seen_at: string }> = [
    { installation_id: 901, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
  ],
): InstallationsState => ({ state: "ok", installations: rows });

const offered = (
  row: InstallationRepositoryOption,
  claimed = false,
): InstallationRepository => ({ ...row, claimed });

const repositories = (...rows: InstallationRepository[]): RepositoryOptionsState => ({
  state: "ok",
  repositories: rows,
  degraded: false,
});

function renderBody(props: {
  apps: RepositoryAppOption[];
  appId?: string;
  installs?: InstallationsState;
  repos?: RepositoryOptionsState;
  existing?: number[];
  selected?: number[];
  notice?: { kind: "warn" | "error"; message: string } | null;
}): string {
  return withLocation("/dashboard/acme/repos", () =>
    renderToStaticMarkup(
      createElement(AddRepositoryDialogBody, {
        locale: "en",
        apps: props.apps,
        appId: props.appId ?? (props.apps[0] ? String(props.apps[0].app_id) : ""),
        installations: props.installs ?? installations(),
        repositories: props.repos ?? repositories(),
        existingRepoIds: new Set(props.existing ?? []),
        selectedRepoIds: new Set(props.selected ?? []),
        notice: props.notice ?? null,
        busy: false,
        onSelectApp: () => {},
        onToggleRepo: () => {},
        onRetryInstallations: () => {},
        onRetryRepositories: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      }),
    ),
  );
}

function rowMarkup(markup: string, identity: string): string {
  const rows = markup.split("<tr ").slice(1);
  const found = rows.find((part) => part.includes(identity));
  if (found === undefined) throw new Error(`no row names ${identity}`);
  return found;
}

function headers(markup: string): string[] {
  return [...markup.matchAll(/<th [^>]*>([\s\S]*?)<\/th>/g)].map((cell) => (cell[1] ?? "").trim());
}

function metricValues(markup: string): Record<string, string> {
  const pairs = markup.matchAll(
    /data-slot="metric-key"[^>]*>([^<]*)<\/span>.*?data-slot="metric-value"[^>]*>([^<]*)<\/span>/gs,
  );
  return Object.fromEntries([...pairs].map((match) => [match[1] ?? "", match[2] ?? ""]));
}

function confirmDisabled(markup: string): boolean {
  const confirm = new RegExp(
    `<button[^>]*>${t("en", "targets.addDialog.confirm")}</button>`,
  ).exec(markup);
  if (confirm === null) throw new Error("the dialog rendered no confirm button");
  return /\sdisabled=""/.test(confirm[0]);
}

describe("repository list (static SSR)", () => {
  const renderView = (targets: TargetListRow[]): string =>
    withLocation("/dashboard/acme/repos", () =>
      renderToStaticMarkup(
        createElement(TargetsView, { locale: "en", state: "ok", targets, onRetry: () => {} }),
      ),
    );

  test("the fixed 所有仓库 aggregate row leads, and each live target gets one row", () => {
    const markup = renderView([
      row({ target_id: "t-1", repo_name: "api", last_reviewed_at: "2026-01-01 00:00:00" }),
      row({ target_id: "t-2", repo_id: 502, repo_name: "web", review_enabled: 0 }),
    ]);
    expect(markup.indexOf(t("en", "targets.allRepositories"))).toBeLessThan(markup.indexOf("acme/api"));
    expect(markup).toContain(t("en", "targets.allRepositoriesMeta"));
    expect(markup).toContain("2 repositories");
    expect(markup).toContain('href="/dashboard/acme/repos/all"');
    expect(markup).toContain('href="/dashboard/acme/repos/t-1"');
    expect(markup).toContain('href="/dashboard/acme/repos/t-2"');
    expect(markup).toContain(t("en", "targets.status.reviewable"));
    expect(markup).toContain(t("en", "targets.status.paused"));
    expect(markup).toContain("cursor-pointer");
  });

  test("the table speaks the review vocabulary: repository, state, totals, 7 days, last review", () => {
    const markup = renderView([row({ reviews_total: 7, reviews_7d: 2 })]);
    expect(headers(markup)).toEqual([
      t("en", "targets.columnRepository"),
      t("en", "targets.columnState"),
      t("en", "targets.columnReviews"),
      t("en", "targets.columnReviews7d"),
      t("en", "targets.columnLastReview"),
    ]);
    const targetRow = rowMarkup(markup, "acme/api");
    expect(targetRow).toContain("acme/api");
    expect(targetRow).toContain("Acme Inspector");
    expect(targetRow).toContain(">7<");
    expect(targetRow).toContain(">2<");
  });

  test("an empty workspace keeps the fixed row and states the empty case", () => {
    const markup = renderView([]);
    expect(markup).toContain(t("en", "targets.allRepositories"));
    expect(markup).toContain("0 repositories");
    expect(markup).toContain(t("en", "targets.emptyTitle"));
    expect(markup).toContain(t("en", "targets.emptyDescription"));
  });

  test("the default face omits a pending target's row link", () => {
    const markup = renderView([
      row({ target_id: "t-web", repo_id: null, repo_owner: "acme", repo_name: "web" }),
    ]);
    expect(markup).not.toContain('href="/dashboard/acme/repos/t-web"');
    expect(markup).not.toContain("acme/web");
  });

  test("a target without repo_id but with owner/name is hidden from the default face", () => {
    const markup = renderView([row({ repo_id: null, repo_owner: "42ch-dev", repo_name: "nexus" })]);
    expect(markup).not.toContain("42ch-dev/nexus");
  });

  test("an all-pending workspace shows the available-empty copy on the default face", () => {
    const markup = renderView([
      row({ target_id: "t-web", repo_id: null, repo_owner: "acme", repo_name: "web" }),
    ]);
    expect(markup).toContain(t("en", "targets.filterEmptyAvailable"));
  });

  test("the overview band reports review volume summed from the row aggregates", () => {
    const markup = renderView([
      row({ target_id: "t-1", reviews_total: 10, reviews_7d: 4 }),
      row({
        target_id: "t-2",
        repo_id: null,
        repo_owner: "acme",
        repo_name: "web",
        reviews_total: 3,
        reviews_7d: 1,
        last_reviewed_at: "2026-01-03 00:00:00",
      }),
      row({ target_id: "t-3", repo_id: null, repo_owner: null, repo_name: null }),
    ]);
    expect(markup).toContain(t("en", "targets.headingDescription"));
    expect(markup).not.toContain("acme/web");
    expect(metricValues(markup)).toEqual({
      [t("en", "targets.metricRepositories")]: "3",
      [t("en", "targets.metricReviews")]: "13",
      [t("en", "targets.metricReviews7d")]: "5",
    });
    expect(Object.keys(metricValues(markup))).toEqual([
      t("en", "targets.metricRepositories"),
      t("en", "targets.metricReviews"),
      t("en", "targets.metricReviews7d"),
    ]);
    expect(markup).toContain(t("en", "targets.filterUninstalled", { count: 2 }));
  });

  test("an empty workspace bands zeros rather than blanks", () => {
    const markup = renderView([]);
    expect(metricValues(markup)).toEqual({
      [t("en", "targets.metricRepositories")]: "0",
      [t("en", "targets.metricReviews")]: "0",
      [t("en", "targets.metricReviews7d")]: "0",
    });
  });

  test("a load failure shows the error face with the fixed row still reachable", () => {
    const markup = withLocation("/dashboard/acme/repos", () =>
      renderToStaticMarkup(
        createElement(TargetsView, { locale: "en", state: "error", targets: null, onRetry: () => {} }),
      ),
    );
    expect(markup).toContain(t("en", "common.loadFailed"));
    expect(markup).toContain(t("en", "common.retry"));
  });
});

describe("the 待安装 filter (mounted)", () => {
  test("the filter carries the count, narrows the table, and keeps the payload order", async () => {
    const targets = [
      row({ target_id: "t-1", repo_name: "api", reviews_total: 5 }),
      row({ target_id: "t-2", repo_id: null, repo_name: "web", reviews_total: 3 }),
      row({ target_id: "t-3", repo_name: "docs", reviews_total: 1 }),
    ];
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/repos");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () =>
      root.render(createElement(TargetsView, { locale: "en", state: "ok", targets, onRetry: () => {} })),
    );
    try {
      const initial = container.textContent ?? "";
      expect(initial).toContain("acme/api");
      expect(initial).toContain("acme/docs");
      expect(initial).not.toContain("acme/web");

      const segment = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "targets.filterUninstalled", { count: 1 }),
      );
      expect(segment).toBeDefined();

      await act(async () => {
        segment?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      const text = container.textContent ?? "";
      expect(text).toContain("acme/web");
      expect(text).not.toContain("acme/api");
      expect(text).not.toContain("acme/docs");
      const pendingRow = rowMarkup(container.innerHTML, "acme/web");
      expect(pendingRow).toContain(t("en", "targets.status.uninstalled"));
      expect(pendingRow).toContain('data-tone="warn"');
      expect(text).toContain(t("en", "targets.allRepositories"));
      expect(text.indexOf(t("en", "targets.allRepositories"))).toBeLessThan(text.indexOf("acme/web"));

      const all = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "targets.filterAvailable"),
      );
      await act(async () => {
        all?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      const restored = container.textContent ?? "";
      expect(restored).not.toContain("acme/web");
      expect(restored.indexOf("acme/api")).toBeLessThan(restored.indexOf("acme/docs"));
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("a reload that empties the pending set restores the available face and drops the toggle", async () => {
    const targets = [
      row({ target_id: "t-1", repo_name: "api" }),
      row({ target_id: "t-2", repo_id: null, repo_name: "web" }),
      row({ target_id: "t-3", repo_name: "docs" }),
    ];
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/repos");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () =>
      root.render(createElement(TargetsView, { locale: "en", state: "ok", targets, onRetry: () => {} })),
    );
    try {
      const segment = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "targets.filterUninstalled", { count: 1 }),
      );
      await act(async () => {
        segment?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      const narrowed = container.textContent ?? "";
      expect(narrowed).toContain("acme/web");
      expect(narrowed).not.toContain("acme/api");
      expect(narrowed).not.toContain("acme/docs");
      expect(segment?.getAttribute("data-state")).toBe("on");

      const reloaded = targets.map((target) =>
        target.target_id === "t-2" ? { ...target, repo_id: 501 } : target,
      );
      await act(async () =>
        root.render(createElement(TargetsView, { locale: "en", state: "ok", targets: reloaded, onRetry: () => {} })),
      );

      const text = container.textContent ?? "";
      expect(text).toContain("acme/api");
      expect(text).toContain("acme/web");
      expect(text).toContain("acme/docs");
      const toggleLabels = [...container.querySelectorAll("button")].map((node) => node.textContent);
      expect(toggleLabels).not.toContain(t("en", "targets.filterAvailable"));
      expect(toggleLabels).not.toContain(t("en", "targets.filterUninstalled", { count: 0 }));

      const reloadedAgain = reloaded.map((target) =>
        target.target_id === "t-2" ? { ...target, repo_id: null } : target,
      );
      await act(async () =>
        root.render(
          createElement(TargetsView, { locale: "en", state: "ok", targets: reloadedAgain, onRetry: () => {} }),
        ),
      );
      const textAgain = container.textContent ?? "";
      expect(textAgain).toContain("acme/api");
      expect(textAgain).toContain("acme/docs");
      expect(textAgain).not.toContain("acme/web");
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
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
    expect(targetStatusPill("en", row({ repo_id: null })).label).toBe(t("en", "targets.status.uninstalled"));
    expect(targetStatusPill("en", row({ review_enabled: 0 })).label).toBe(t("en", "targets.status.paused"));
    expect(targetStatusPill("en", row()).label).toBe(t("en", "targets.status.reviewable"));
  });
});

describe("add-repository dialog (static SSR)", () => {
  const steps = (markup: string): number[] =>
    [t("en", "targets.addDialog.stepApp"), t("en", "targets.addDialog.stepInstall"), t("en", "targets.addDialog.stepRepos")].map(
      (step) => markup.indexOf(step),
    );

  test("zero Apps: guidance and a jump link, no steps, confirm disabled", () => {
    const markup = renderBody({ apps: [] });
    expect(markup).toContain(t("en", "targets.addDialog.noApps"));
    expect(markup).toContain(t("en", "targets.addDialog.goToApps"));
    expect(markup).toContain('href="/dashboard/acme/apps"');
    expect(markup).not.toContain(t("en", "targets.addDialog.stepApp"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("the App step is ALWAYS rendered, even with exactly one App", () => {
    const single = renderBody({ apps: [app()] });
    expect(single).toContain(t("en", "targets.addDialog.stepApp"));
    expect(single).toContain(t("en", "targets.addDialog.appLabel"));
    expect(single).toContain('role="combobox"');
    const [appStep, installStep, repoStep] = steps(single);
    expect(appStep).toBeGreaterThanOrEqual(0);
    expect(appStep).toBeLessThan(installStep!);
    expect(installStep!).toBeLessThan(repoStep!);
  });

  test("several Apps render the same always-present dropdown", () => {
    const markup = renderBody({
      apps: [app(), app({ app_id: 9402, bot_id: "bot-2", name: "Second App" })],
    });
    expect(markup).toContain(t("en", "targets.addDialog.stepApp"));
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain(t("en", "targets.addDialog.sharedScopeComing"));
  });

  test("the installation step lists account, id and last seen", () => {
    const markup = renderBody({ apps: [app()] });
    expect(markup).toContain(t("en", "targets.addDialog.stepInstall"));
    expect(markup).toContain(
      t("en", "targets.addDialog.installationRow", {
        account: "acme",
        id: 901,
        time: formatRelativeTime("2026-01-01 00:00:00", "en"),
      }),
    );
  });

  test("no installation: exactly one GitHub install link plus a re-check, confirm disabled", () => {
    const markup = renderBody({ apps: [app()], installs: installations([]) });
    expect(markup).toContain(t("en", "targets.addDialog.noInstallations"));
    const step =
      markup.split('data-slot="add-step-installations"')[1]?.split('data-slot="add-step-repositories"')[0] ?? "";
    expect(step.match(/href="https:\/\/github\.com\/apps\/acme-inspector\/installations\/new"/g)).toHaveLength(1);
    expect(markup).toContain(t("en", "targets.addDialog.recheck"));
    expect(confirmDisabled(markup)).toBe(true);
    expect(markup).not.toContain('id="add-repository-search"');
  });

  test("the installation step keeps one install link in every read state", () => {
    for (const installs of [{ state: "loading" } as InstallationsState, { state: "error" } as InstallationsState, installations()]) {
      const markup = renderBody({ apps: [app()], installs });
      const step =
        markup.split('data-slot="add-step-installations"')[1]?.split('data-slot="add-step-repositories"')[0] ?? "";
      expect(step.match(/installations\/new/g)).toHaveLength(1);
    }
  });

  test("a failed installation read offers its own retry", () => {
    const markup = renderBody({ apps: [app()], installs: { state: "error" } });
    expect(markup).toContain("Could not read this App");
    expect(markup).toContain(t("en", "common.retry"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("nothing repository-wise renders before a query", () => {
    const markup = renderBody({
      apps: [app()],
      repos: repositories(
        offered({ repo_id: 501, owner: "acme", name: "api" }),
        offered({ repo_id: 502, owner: "acme", name: "web" }),
      ),
    });
    expect(markup).toContain('id="add-repository-search"');
    expect(markup).toContain(t("en", "targets.addDialog.stepRepos"));
    expect(markup).not.toContain("acme/api");
    expect(markup).not.toContain("acme/web");
    expect(markup.match(/<input type="checkbox"/g) ?? []).toHaveLength(0);
  });

  test("an App that grants no repository explains the dead end and disables confirm", () => {
    const markup = renderBody({ apps: [app()], repos: repositories() });
    expect(markup).toContain(t("en", "targets.addDialog.noInstallationRepos"));
    expect(markup).toContain('href="/dashboard/acme/apps/9401?tab=installations"');
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("a repository fetch failure offers a retry and disables confirm", () => {
    const markup = renderBody({ apps: [app()], repos: { state: "error" } });
    expect(markup).toContain("Could not load this App");
    expect(markup).toContain(t("en", "common.retry"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("a duplicate refusal reports what existed and keeps confirm usable for the rest", () => {
    const markup = renderBody({
      apps: [app()],
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
      repos: {
        state: "ok",
        repositories: [offered({ repo_id: 501, owner: "acme", name: "api" })],
        degraded: true,
      },
    });
    expect(markup).toContain(t("en", "targets.addDialog.degraded"));
  });
});


type Wire = { url: string; method: string; body: string | null };

const wireJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const listing = (rows: Array<{ repo_id: number; owner: string; name: string; claimed?: boolean }>) =>
  wireJson({
    repositories: rows.map((row) => ({ claimed: false, ...row })),
    degraded: false,
  });

const BOOT: SpaBoot = {
  locale: "en",
  login: "mallory",
  name: null,
  workspaceRef: "acme",
  memberships: [{ id: "acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

async function mountTargets(
  element: ReturnType<typeof createElement>,
  respond: (wire: Wire) => Response | Promise<Response>,
) {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/repos");
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

const settingsWith = (
  rows: Array<{ installation_id: number; account_login: string | null; seen_at: string }>,
) => wireJson({ can_manage: true, installations: rows });

const INSTALLED = [{ installation_id: 901, account_login: "acme", seen_at: "2026-01-01 00:00:00" }];

async function filter(win: DomWindow, value: string): Promise<void> {
  const input = win.document.querySelector("#add-repository-search");
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input?.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  for (let flush = 0; flush < 2; flush += 1) await act(async () => {});
}

const many = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    repo_id: 500 + index,
    owner: "acme",
    name: `repo-${index}`,
  }));

const listed = (win: DomWindow): string[] =>
  [...win.document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].map(
    (node) => node.parentElement?.textContent ?? "",
  );

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
        if (wire.url.endsWith("/api/apps/9402")) return settingsWith(INSTALLED);
        if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
        if (wire.url.endsWith("/api/apps/9402/installation-repositories")) {
          return listing([{ repo_id: 502, owner: "acme", name: "web" }]);
        }
        return wireJson({});
      },
    );
    try {
      await view.pickApp("Second App");
      await filter(view.win, "web");
      expect(view.dialog()?.textContent ?? "").toContain("acme/web");

      releaseFirst();
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      await filter(view.win, "api");
      const text = view.dialog()?.textContent ?? "";
      expect(text).not.toContain("acme/api");
    } finally {
      await view.unmount();
    }
  });

  test("a duplicate refusal keeps the dialog open with its notice across the refresh", async () => {
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
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
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
      await filter(view.win, "api");
      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]') as unknown as DomElement | null);
      await view.click(confirmButton(view.win));

      const pending = view.dialog();
      expect(pending).not.toBeNull();
      expect(pending?.textContent ?? "").toContain(
        t("en", "targets.addDialog.duplicates").replace("{names}", "acme/api"),
      );
      expect(view.win.document.querySelector('[data-slot="page-skeleton"]')).toBeNull();

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

  test("nothing is listed until the operator types, and the count says how many matched", async () => {
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app()],
        existingRepoIds: new Set<number>(),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) =>
        wire.url.endsWith("/api/apps/9401")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      expect(view.win.document.querySelector("#add-repository-search")).not.toBeNull();
      expect(listed(view.win)).toHaveLength(0);

      await filter(view.win, "  repo-4  ");
      const narrowed = listed(view.win);
      expect(narrowed).toHaveLength(6);
      expect(narrowed.some((label) => label.includes("acme/repo-44"))).toBe(true);
      expect(narrowed.some((label) => label.includes("acme/repo-3"))).toBe(false);
      expect(view.dialog()?.textContent ?? "").toContain(
        t("en", "targets.addDialog.resultsCount").replace("{count}", "6"),
      );

      await filter(view.win, "REPO-4");
      expect(listed(view.win)).toEqual(narrowed);

      await filter(view.win, "");
      expect(listed(view.win)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });

  test("a broad query states the cap it applied and how many matched", async () => {
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app()],
        existingRepoIds: new Set<number>(),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) =>
        wire.url.endsWith("/api/apps/9401")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      await filter(view.win, "repo-");
      expect(listed(view.win)).toHaveLength(REPOSITORY_LIST_CAP);
      expect(view.dialog()?.textContent ?? "").toContain(
        t("en", "targets.addDialog.resultsTruncated")
          .replace("{cap}", String(REPOSITORY_LIST_CAP))
          .replace("{count}", "45"),
      );
    } finally {
      await view.unmount();
    }
  });

  test("a row hidden by a later query still reaches the submitted payload", async () => {
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/targets") && wire.method === "POST") {
        return wireJson({ created: [], duplicates: [] }, 201);
      }
      if (wire.url.endsWith("/api/targets")) return wireJson({ targets: [] });
      if (wire.url.endsWith("/api/apps")) {
        return wireJson({
          viewer: { login: "mallory", role: "admin" },
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) return listing(many(45));
      return wireJson({});
    });
    try {
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      await view.click(addButton);
      await filter(view.win, "repo-0");
      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]'));
      await filter(view.win, "repo-44");
      expect(listed(view.win)).toHaveLength(1);

      await view.click(confirmButton(view.win));
      const post = view.sent.find((wire) => wire.method === "POST");
      expect(JSON.parse(post?.body ?? "null")).toEqual({
        bot_id: "bot-1",
        repositories: [{ repo_id: 500, owner: "acme", name: "repo-0" }],
      });
    } finally {
      await view.unmount();
    }
  });

  test("a query matching nothing states it and leaves the controls usable", async () => {
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app()],
        existingRepoIds: new Set<number>(),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) =>
        wire.url.endsWith("/api/apps/9401")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      await filter(view.win, "no-such-repository");
      expect(listed(view.win)).toHaveLength(0);
      expect(view.dialog()?.textContent ?? "").toContain(
        t("en", "targets.addDialog.noMatch").replace("{query}", "no-such-repository"),
      );
      const cancel = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t("en", "common.cancel"),
      );
      expect(cancel?.hasAttribute("disabled")).toBe(false);
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("an already-added row stays checked and disabled under a query", async () => {
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app()],
        existingRepoIds: new Set<number>([541]),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) =>
        wire.url.endsWith("/api/apps/9401")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      await filter(view.win, "repo-41");
      const boxes = [...view.win.document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].map(
        (node) => node as unknown as HTMLInputElement,
      );
      expect(boxes).toHaveLength(1);
      expect(boxes[0]?.checked).toBe(true);
      expect(boxes[0]?.disabled).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("a repository the bot already holds elsewhere renders claimed, never selectable", async () => {
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app()],
        existingRepoIds: new Set<number>(),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) =>
        wire.url.endsWith("/api/apps/9401")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing([
                { repo_id: 501, owner: "acme", name: "api", claimed: true },
                { repo_id: 502, owner: "acme", name: "web" },
              ])
            : wireJson({}),
    );
    try {
      await filter(view.win, "acme/");
      const boxes = [...view.win.document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].map(
        (node) => node as unknown as HTMLInputElement,
      );
      expect(boxes).toHaveLength(2);
      expect(boxes[0]?.disabled).toBe(true);
      expect(boxes[1]?.disabled).toBe(false);
      expect(view.dialog()?.textContent ?? "").toContain(t("en", "targets.addDialog.claimedElsewhere"));
    } finally {
      await view.unmount();
    }
  });

  test("this workspace's own repository is tagged Added, a foreign claim Taken", async () => {
    const view = await mountTargets(
      createElement(AddRepositoryDialog, {
        locale: "en",
        open: true,
        apps: [app()],
        existingRepoIds: new Set<number>([501]),
        onAdded: () => {},
        onClose: () => {},
      }),
      (wire) =>
        wire.url.endsWith("/api/apps/9401")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing([
                { repo_id: 501, owner: "acme", name: "api" },
                { repo_id: 502, owner: "acme", name: "web", claimed: true },
              ])
            : wireJson({}),
    );
    try {
      await filter(view.win, "acme/");
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t("en", "targets.addDialog.alreadyAdded"));
      expect(text).toContain(t("en", "targets.addDialog.claimedElsewhere"));
    } finally {
      await view.unmount();
    }
  });

  test("a successful add leaves nothing selected for the next open", async () => {
    let added = false;
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/targets") && wire.method === "POST") {
        added = true;
        return wireJson({ created: [{ target_id: "t-new", repo_id: 501, repo_owner: "acme", repo_name: "api" }], duplicates: [] }, 201);
      }
      if (wire.url.endsWith("/api/targets")) {
        return wireJson({ targets: added ? [row({ repo_id: 501, repo_name: "api" })] : [] });
      }
      if (wire.url.endsWith("/api/apps")) {
        return wireJson({
          viewer: { login: "mallory", role: "admin" },
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) {
        return listing([{ repo_id: 501, owner: "acme", name: "api" }]);
      }
      return wireJson({});
    });
    const openDialog = async (): Promise<void> => {
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      await view.click(addButton as unknown as DomElement | undefined);
    };
    try {
      await openDialog();
      await filter(view.win, "api");
      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]'));
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(false);
      await view.click(confirmButton(view.win));
      expect(view.dialog()).toBeNull();

      await openDialog();
      await filter(view.win, "api");
      const boxes = [...view.win.document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].map(
        (node) => node as unknown as HTMLInputElement,
      );
      expect(boxes).toHaveLength(1);
      expect(boxes[0]?.checked).toBe(true);
      expect(boxes[0]?.disabled).toBe(true);
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("closing and reopening drops the selection; a partial refusal keeps it", async () => {
    let duplicates = false;
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/targets") && wire.method === "POST") {
        duplicates = true;
        return wireJson({ created: [], duplicates: [{ repo_id: 501, owner: "acme", name: "api" }] }, 201);
      }
      if (wire.url.endsWith("/api/targets")) return wireJson({ targets: [] });
      if (wire.url.endsWith("/api/apps")) {
        return wireJson({
          viewer: { login: "mallory", role: "admin" },
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) {
        return listing([
          { repo_id: 501, owner: "acme", name: "api" },
          { repo_id: 502, owner: "acme", name: "web" },
        ]);
      }
      return wireJson({});
    });
    const openDialog = async (): Promise<void> => {
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      await view.click(addButton as unknown as DomElement | undefined);
    };
    try {
      await openDialog();
      await filter(view.win, "api");
      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]'));
      const cancel = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t("en", "common.cancel"),
      );
      await view.click(cancel as unknown as DomElement | undefined);
      await openDialog();
      await filter(view.win, "api");
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(true);

      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]'));
      await view.click(confirmButton(view.win));
      expect(duplicates).toBe(true);
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(false);
      const checked = [...view.win.document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].map(
        (node) => (node as unknown as HTMLInputElement).checked,
      );
      expect(checked).toContain(true);
    } finally {
      await view.unmount();
    }
  });

  test("re-check refetches the installation payload and unlocks the repository step", async () => {
    let installed = false;
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/targets")) return wireJson({ targets: [] });
      if (wire.url.endsWith("/api/apps")) {
        return wireJson({
          viewer: { login: "mallory", role: "admin" },
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(installed ? INSTALLED : []);
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
      expect(view.dialog()?.textContent ?? "").toContain(t("en", "targets.addDialog.noInstallations"));
      expect(view.win.document.querySelector("#add-repository-search")).toBeNull();
      const before = view.sent.filter((wire) => wire.url.endsWith("/api/apps/9401")).length;

      installed = true;
      const recheck = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t("en", "targets.addDialog.recheck"),
      );
      await view.click(recheck as unknown as DomElement | undefined);

      expect(view.sent.filter((wire) => wire.url.endsWith("/api/apps/9401")).length).toBe(before + 1);
      expect(view.win.document.querySelector("#add-repository-search")).not.toBeNull();
      expect(view.dialog()?.textContent ?? "").not.toContain(t("en", "targets.addDialog.noInstallations"));
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
      view.win.history.pushState(null, "", "/dashboard/beta/repos");
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

  test("a late-arriving App list adopts: the App step preselects it, never blank", async () => {
    let releaseApps: () => void = () => {};
    const heldApps = new Promise<Response>((resolve) => {
      releaseApps = () =>
        resolve(
          wireJson({
            viewer: { login: "mallory", role: "admin" },
            apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
            shared_bots: [],
          }),
        );
    });
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/apps")) return heldApps;
      if (wire.url.endsWith("/api/targets")) return wireJson({ targets: [] });
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) {
        return listing([{ repo_id: 501, owner: "acme", name: "api" }]);
      }
      return wireJson({});
    });
    try {
      expect(view.text()).not.toContain(t("en", "common.loadFailed"));
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      expect(addButton).toBeDefined();

      await view.click(addButton as unknown as DomElement | undefined);
      expect(view.dialog()?.textContent ?? "").toContain(t("en", "targets.addDialog.noApps"));

      releaseApps();
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});

      const text = view.dialog()?.textContent ?? "";
      expect(text).not.toContain(t("en", "targets.addDialog.noApps"));
      const combobox = view.win.document.querySelector('[role="dialog"] [role="combobox"]');
      expect(combobox?.textContent ?? "").toContain("Acme Inspector");
      expect(view.sent.some((wire) => wire.url.endsWith("/api/apps/9401"))).toBe(true);
      expect(view.sent.some((wire) => wire.url.endsWith("/installation-repositories"))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("an ordinary load preselects the first App and enables Confirm once a row is chosen", async () => {
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/apps")) {
        return wireJson({
          viewer: { login: "mallory", role: "admin" },
          apps: [
            { github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" },
            { github_app_id: 9402, bot_id: "bot-2", github_name: "Second App", github_slug: "second-app" },
          ],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/api/targets")) return wireJson({ targets: [] });
      if (wire.url.endsWith("/api/apps/9401")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) {
        return listing([{ repo_id: 501, owner: "acme", name: "api" }]);
      }
      return wireJson({});
    });
    try {
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      await view.click(addButton as unknown as DomElement | undefined);

      const combobox = view.win.document.querySelector('[role="dialog"] [role="combobox"]');
      expect(combobox?.textContent ?? "").toContain("Acme Inspector");
      await filter(view.win, "api");
      expect(listed(view.win)).toHaveLength(1);

      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(true);
      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]'));
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  test("a failed Apps read degrades the add panel instead of blanking the list", async () => {
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/apps")) return wireJson({ error: "boom" }, 500);
      if (wire.url.endsWith("/api/targets")) {
        return wireJson({ targets: [row({ repo_id: 501, repo_name: "api" })] });
      }
      return wireJson({});
    });
    try {
      expect(view.text()).toContain("acme/api");
      expect(view.text()).not.toContain(t("en", "common.loadFailed"));
      expect(view.text()).toContain(t("en", "targets.appsReadFailed"));
      expect(
        [...view.win.document.querySelectorAll("button")].some(
          (button) => button.textContent === t("en", "common.retry"),
        ),
      ).toBe(true);
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      expect(addButton).toBeDefined();
      await view.click(addButton as unknown as DomElement | undefined);
      expect(view.dialog()?.textContent ?? "").toContain(t("en", "targets.addDialog.noApps"));
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

function targetPayload(
  follow: 0 | 1,
  overrides: { review_enabled?: 0 | 1; verdictsReadable?: boolean; review_drafts?: boolean } = {},
) {
  const readable = overrides.verdictsReadable ?? true;
  const draftSwitch: 0 | 1 = overrides.review_drafts === false ? 0 : 1;
  return {
    target: {
      target_id: "t-1",
      repo_owner: "acme",
      repo_name: "api",
      app_name: "Acme Inspector",
      app_id: null,
      app_avatar_url: null,
      review_enabled: overrides.review_enabled ?? 1,
      follow_workspace_defaults: follow,
      review_drafts: draftSwitch,
    },
    effective: {
      trigger_mode: "every_push" as const,
      review_level: "deep" as const,
      check_min_score: 45,
      check_pass_verdicts: readable ? ["ship it"] : [],
      check_pass_verdicts_readable: readable,
      review_drafts: overrides.review_drafts ?? true,
      review_enabled: (overrides.review_enabled ?? 1) === 1,
    },
    defaults: {
      trigger_mode: "open" as const,
      review_level: "default" as const,
      check_min_score: 60,
      check_pass_verdicts: ["ship it", "blocked"],
      check_pass_verdicts_readable: true,
      review_drafts: true,
      review_enabled: true,
    },
  };
}

function renderSettingsTab(
  follow: 0 | 1,
  reviewEnabled: 0 | 1 = 1,
  verdictsReadable = true,
): string {
  return withLocation("/dashboard/acme/repos/t-1", () =>
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

function disabledInputs(markup: string): number {
  return [...markup.matchAll(/<input[^>]*>/g)].filter((match) => /\sdisabled=""/.test(match[0])).length;
}

describe("target settings tab (static SSR)", () => {
  test("an inheriting target shows the effective values read-only plus the follow line", () => {
    const markup = renderSettingsTab(1);
    expect(markup).toContain("Every push");
    expect(markup).toContain("Deep");
    expect(markup).toContain('value="45"');
    const inputs = [...markup.matchAll(/<input[^>]*>/g)];
    expect(inputs.length).toBe(8);
    expect(disabledInputs(markup)).toBe(7);
    expect(markup).toContain("Following the workspace defaults");
    expect(markup).toContain(t("en", "settings.reviewGateSave"));
  });

  test("an explicit target renders the same controls enabled and no follow line", () => {
    const markup = renderSettingsTab(0);
    expect(disabledInputs(markup)).toBe(0);
    expect(markup).not.toContain("Following the workspace defaults");
    expect(markup).toContain("Every push");
  });

  test("the tab names the bound App and says rebinding is not supported yet", () => {
    const markup = renderSettingsTab(1);
    expect(markup).toContain(t("en", "targets.settings.boundApp"));
    expect(markup).toContain("Acme Inspector");
    expect(markup).toContain(t("en", "targets.settings.boundAppPlanned"));
    expect(markup).not.toContain('aria-label="' + t("en", "targets.settings.boundApp") + '"');
    const bound = markup
      .split(t("en", "targets.settings.boundApp"))[1]
      ?.split(t("en", "settings.triggerMode"))[0] ?? "";
    expect(bound).not.toContain("<a ");
  });

  test("the pause switch reflects review_enabled", () => {
    const paused = renderSettingsTab(0, 0);
    expect(paused).toContain(t("en", "settings.resumeReviews"));
    const running = renderSettingsTab(0, 1);
    expect(running).toContain(t("en", "settings.pauseReviews"));
  });

  test("an unreadable stored gate states the recovery copy and offers no save", () => {
    const markup = renderSettingsTab(0, 1, false);
    expect(markup).toContain("stored review gate could not be read");
    expect(markup).not.toContain(t("en", "settings.reviewGateSave"));
    expect(markup).not.toContain('type="number"');
    const inputs = [...markup.matchAll(/<input[^>]*>/g)];
    expect(inputs.length).toBe(3);
    expect(disabledInputs(markup)).toBe(1);
    expect(markup).toContain(t("en", "settings.pauseReviews"));
    expect(markup).toContain(t("en", "settings.reviewDrafts"));
  });
});

async function mountDetail(
  respond: (wire: Wire) => Response | Promise<Response>,
  options: { path?: string; targetId?: string } = {},
) {
  const targetId = options.targetId ?? "t-1";
  const { win, cleanup } = installDom(
    `http://localhost${options.path ?? `/dashboard/acme/repos/${targetId}`}`,
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
  test("the draft switch posts only review_drafts on an explicit target", async () => {
    let draftOn = true;
    const view = await mountDetail((wire) => {
      if (wire.method === "POST") {
        expect(JSON.parse(wire.body ?? "null")).toEqual({ review_drafts: false });
        expect(wire.url).toBe("/dashboard/acme/api/targets/t-1");
        draftOn = false;
        return wireJson(targetPayload(0, { review_drafts: false }));
      }
      return wire.url.endsWith("/api/targets/t-1")
        ? wireJson(targetPayload(0, { review_drafts: draftOn }))
        : wireJson({}, 500);
    });
    const draftSwitch = (): HTMLInputElement | null =>
      [...view.win.document.querySelectorAll("label")]
        .find((node) => node.textContent === t("en", "settings.reviewDrafts"))
        ?.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement | null;
    try {
      expect(draftSwitch()?.checked).toBe(true);
      expect(draftSwitch()?.disabled).toBe(false);

      await act(async () => {
        draftSwitch()?.dispatchEvent(
          new view.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
        );
      });
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});

      expect(view.sent.filter((wire) => wire.method === "POST")).toHaveLength(1);
      expect(draftSwitch()?.checked).toBe(false);
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
      expect(view.text()).toContain("Every push");
      const score = view.win.document.querySelector('input[type="number"]');
      expect((score as unknown as { value: string } | null)?.value).toBe("45");
    } finally {
      await view.unmount();
    }
  });

  test("a read for the target the operator left cannot paint over the one now open", async () => {
    let releaseStale: () => void = () => {};
    const staleRead = new Promise<Response>((resolve) => {
      releaseStale = () => resolve(wireJson(targetPayload(1)));
    });
    const view = await mountDetail((wire) =>
      wire.url.endsWith("/api/targets/t-1") ? staleRead : wireJson(workspaceDefaults()),
    );
    try {
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
      expect(view.text()).not.toContain(t("en", "common.retry"));
      expect(view.win.document.querySelector("a")?.getAttribute("href")).toBe("/dashboard/acme/repos");
    } finally {
      await view.unmount();
    }
  });
});

const workspaceDefaults = (overrides: Record<string, unknown> = {}) => ({
  defaults: {
    trigger_mode: "open" as const,
    review_level: "default" as const,
    check_min_score: 60,
    check_pass_verdicts: ["ship it", "blocked"],
    check_pass_verdicts_readable: true,
    review_drafts: true,
    review_enabled: true,
    ...overrides,
  },
  target_count: 3,
});

describe("all-repositories detail (mounted)", () => {
  test("renders the defaults form, the workspace tabs and the live count", async () => {
    const view = await mountDetail(
      (wire) => (wire.url.endsWith("/api/targets/all") ? wireJson(workspaceDefaults()) : wireJson({}, 500)),
      { path: "/dashboard/acme/repos/all", targetId: "all" },
    );
    try {
      expect(view.text()).toContain(t("en", "targets.allRepositories"));
      expect(view.text()).toContain(t("en", "targets.repositoryCountMany", { count: 3 }));
      expect(view.tabs()).toEqual([
        t("en", "targets.settings.heading"),
        t("en", "targets.tabInsights"),
        t("en", "targets.tabPullRequests"),
      ]);
      expect(view.text()).toContain(t("en", "settings.triggerModeOpen"));
      expect(view.text()).toContain(t("en", "settings.pauseReviews"));
      expect(view.text()).not.toContain(t("en", "targets.settings.follow"));
      expect(view.text()).toContain(t("en", "settings.reviewDrafts"));
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
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/repos/all");
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
      { path: "/dashboard/acme/repos/all", targetId: "all" },
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
      expect(JSON.parse(post?.body ?? "null")).toEqual({ trigger_mode: "manual" });
    } finally {
      await view.unmount();
    }
  });

  test("?tab=insights opens the insights tab, and picking a tab writes it to the address", async () => {
    const view = await mountDetail(
      (wire) => (wire.url.endsWith("/api/targets/all") ? wireJson(workspaceDefaults()) : wireJson({}, 500)),
      { path: "/dashboard/acme/repos/all?tab=insights", targetId: "all" },
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
