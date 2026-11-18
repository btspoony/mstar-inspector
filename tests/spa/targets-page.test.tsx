/**
 * The repository surface's rendered faces (product spec J1/J2).
 *
 * Static SSR pins what the page shows, not how it wires:
 *   - the fixed 所有仓库 aggregate row first, with the live count and the
 *     per-repository rows behind it; the empty workspace still carries the
 *     fixed row plus the empty state;
 *   - the list's review vocabulary: total reviews, last-7-day reviews and last
 *     review per row, and the band summing the same aggregates;
 *   - 待安装 as a FILTER with its count, never a band metric;
 *   - the stepped add dialog: the App step always rendered (no implicit
 *     apps[0]), the installation check, and a repository scan that shows
 *     nothing before a query.
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

/** An offered repository row; `claimed` defaults to the common free case. */
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

/**
 * One table row's own markup, cut at the next row so a string the band or the
 * header band also renders (待安装 is a filter label too) cannot satisfy an
 * assertion about that row.
 */
function rowMarkup(markup: string, identity: string): string {
  const rows = markup.split("<tr ").slice(1);
  const found = rows.find((part) => part.includes(identity));
  if (found === undefined) throw new Error(`no row names ${identity}`);
  return found;
}

/** The table's header labels, in order. */
function headers(markup: string): string[] {
  return [...markup.matchAll(/<th [^>]*>([\s\S]*?)<\/th>/g)].map((cell) => (cell[1] ?? "").trim());
}

/** The metric band as `{ key: value }`, read off the rendered markup. */
function metricValues(markup: string): Record<string, string> {
  const pairs = markup.matchAll(
    /data-slot="metric-key"[^>]*>([^<]*)<\/span>.*?data-slot="metric-value"[^>]*>([^<]*)<\/span>/gs,
  );
  return Object.fromEntries([...pairs].map((match) => [match[1] ?? "", match[2] ?? ""]));
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
  /** The loaded list under the page's own base, with the rows as given. */
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
    // The fixed row comes first, then the repositories in payload order.
    expect(markup.indexOf(t("en", "targets.allRepositories"))).toBeLessThan(markup.indexOf("acme/api"));
    expect(markup).toContain(t("en", "targets.allRepositoriesMeta"));
    expect(markup).toContain("2 repositories");
    expect(markup).toContain('href="/dashboard/acme/repos/all"');
    expect(markup).toContain('href="/dashboard/acme/repos/t-1"');
    expect(markup).toContain('href="/dashboard/acme/repos/t-2"');
    // Status pills: reviewing and paused.
    expect(markup).toContain(t("en", "targets.status.reviewing"));
    expect(markup).toContain(t("en", "targets.status.paused"));
    // The row is the destination, as on the Apps table.
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
    // The App name is the composite cell's secondary line, as on the Apps list.
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

  test("a 待安装 row reports the discriminator instead of an invented name", () => {
    const markup = renderView([row({ repo_id: null, repo_owner: null, repo_name: null })]);
    expect(markup).toContain(t("en", "targets.status.uninstalled"));
    // `null`/`null` must not render as a repository named "null/null".
    expect(markup).not.toContain("null/null");
  });

  test("a target without repo_id but with owner/name renders the name, not a dash", () => {
    // The staging shape: a target that lost its installation still names the
    // repository it was reviewed under. `repo_id` stays the 待安装 badge's key,
    // but it must not erase the identity.
    const markup = renderView([row({ repo_id: null, repo_owner: "42ch-dev", repo_name: "nexus" })]);
    expect(markup).toContain("42ch-dev/nexus");
    // The badge is asserted on the ROW's own subtree: the filter renders the
    // same label, so a page-wide `toContain` would pass even without a badge.
    const targetRow = rowMarkup(markup, "42ch-dev/nexus");
    expect(targetRow).toContain(t("en", "targets.status.uninstalled"));
    expect(targetRow).toContain('data-tone="warn"');
    // No row fell back to the dash: the one target row named its repository.
    expect(targetRow).not.toContain(">—</a>");
  });

  test("a target with neither an id nor a name still falls back to the dash", () => {
    const markup = renderView([row({ repo_id: null, repo_owner: null, repo_name: null })]);
    const targetRow = rowMarkup(markup, "—</a>");
    expect(targetRow).toContain(">—</a>");
    // The same installation axis: no repo_id means the 待安装 pill.
    expect(targetRow).toContain(t("en", "targets.status.uninstalled"));
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
    // The one explanatory block — no second endpoint, no second paragraph.
    expect(markup).toContain(t("en", "targets.headingDescription"));
    // The figure and the pill are the SAME axis: t-2 names a repository but
    // carries no repo_id, and both read it as 待安装.
    expect(rowMarkup(markup, "acme/web")).toContain(t("en", "targets.status.uninstalled"));
    // Three figures, all summed from the loaded payload.
    expect(metricValues(markup)).toEqual({
      [t("en", "targets.metricRepositories")]: "3",
      [t("en", "targets.metricReviews")]: "13",
      [t("en", "targets.metricReviews7d")]: "5",
    });
    // 待安装 is no longer a metric (I-000640): read the band's OWN key list, so a
    // future band that re-adds it under any label fails here. The band renders
    // exactly the three review-volume figures and nothing else.
    expect(Object.keys(metricValues(markup))).toEqual([
      t("en", "targets.metricRepositories"),
      t("en", "targets.metricReviews"),
      t("en", "targets.metricReviews7d"),
    ]);
    // The count of unbound rows survives only as the filter's label.
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
      // The filter control names the count — it is a filter, not a metric.
      const segment = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "targets.filterUninstalled", { count: 1 }),
      );
      expect(segment).toBeDefined();

      await act(async () => {
        segment?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      // Only the unbound row survives, and the aggregate row stays first.
      const text = container.textContent ?? "";
      expect(text).toContain("acme/web");
      expect(text).not.toContain("acme/api");
      expect(text).not.toContain("acme/docs");
      expect(text.indexOf(t("en", "targets.allRepositories"))).toBeLessThan(text.indexOf("acme/web"));

      // Clearing restores every row in the payload's order.
      const all = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "targets.filterAll"),
      );
      await act(async () => {
        all?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      const restored = container.textContent ?? "";
      expect(restored.indexOf("acme/api")).toBeLessThan(restored.indexOf("acme/web"));
      expect(restored.indexOf("acme/web")).toBeLessThan(restored.indexOf("acme/docs"));
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
    // 待安装 is the first discriminator: a row with no repo_id is awaiting its
    // delivery whatever its pause column says.
    expect(targetStatusPill("en", row({ repo_id: null })).label).toBe(t("en", "targets.status.uninstalled"));
    expect(targetStatusPill("en", row({ review_enabled: 0 })).label).toBe(t("en", "targets.status.paused"));
    expect(targetStatusPill("en", row()).label).toBe(t("en", "targets.status.reviewing"));
  });
});

describe("add-repository dialog (static SSR)", () => {
  /** The three step headings, in order — the flow's own skeleton. */
  const steps = (markup: string): number[] =>
    [t("en", "targets.addDialog.stepApp"), t("en", "targets.addDialog.stepInstall"), t("en", "targets.addDialog.stepRepos")].map(
      (step) => markup.indexOf(step),
    );

  test("zero Apps: guidance and a jump link, no steps, confirm disabled", () => {
    const markup = renderBody({ apps: [] });
    expect(markup).toContain(t("en", "targets.addDialog.noApps"));
    expect(markup).toContain(t("en", "targets.addDialog.goToApps"));
    expect(markup).toContain('href="/dashboard/acme/apps"');
    // No steps: there is nothing to choose, and no way to proceed.
    expect(markup).not.toContain(t("en", "targets.addDialog.stepApp"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("the App step is ALWAYS rendered, even with exactly one App", () => {
    // I-000642: a single App used to bind silently to apps[0]. The choice is
    // now explicit — the combobox names the one App instead of a sentence
    // standing in for it.
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
    // The coming shared scope is stated, not built.
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

  test("no installation: the GitHub install link plus a re-check, confirm disabled", () => {
    const markup = renderBody({ apps: [app()], installs: installations([]) });
    expect(markup).toContain(t("en", "targets.addDialog.noInstallations"));
    expect(markup).toContain('href="https://github.com/apps/acme-inspector/installations/new"');
    expect(markup).toContain(t("en", "targets.addDialog.recheck"));
    expect(confirmDisabled(markup)).toBe(true);
    // The repository step is not offered: there is nothing to search.
    expect(markup).not.toContain('id="add-repository-search"');
  });

  test("a failed installation read offers its own retry", () => {
    const markup = renderBody({ apps: [app()], installs: { state: "error" } });
    // The copy's apostrophe is HTML-escaped in static markup; the prefix is
    // the assertion that matters.
    expect(markup).toContain("Could not read this App");
    expect(markup).toContain(t("en", "common.retry"));
    expect(confirmDisabled(markup)).toBe(true);
  });

  test("nothing repository-wise renders before a query", () => {
    // I-000642: the dialog used to dump 40 rows before anyone typed. The
    // search box is there; the results are not.
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

// --- mounted (stateful dialog + page) --------------------------------------

type Wire = { url: string; method: string; body: string | null };

const wireJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** One installation listing, as the dialog's read consumes it. */
/** One installation listing; `claimed` defaults to the free case. */
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

/**
 * Mount `element` on the targets URL with a recorded fetch stub. Teardown
 * unmounts, restores `fetch` and removes the window, including on a throw.
 */
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

/** The settings payload's installation section — the dialog's step 2 read. */
const settingsWith = (
  rows: Array<{ installation_id: number; account_login: string | null; seen_at: string }>,
) => wireJson({ can_manage: true, installations: rows });

const INSTALLED = [{ installation_id: 901, account_login: "acme", seen_at: "2026-01-01 00:00:00" }];

/** Type into the dialog's search input the way a user's keystroke arrives. */
async function filter(win: DomWindow, value: string): Promise<void> {
  const input = win.document.querySelector("#add-repository-search");
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input?.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  for (let flush = 0; flush < 2; flush += 1) await act(async () => {});
}

/** `count` repositories named `repo-0`…`repo-<count-1>` under one owner. */
const many = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    repo_id: 500 + index,
    owner: "acme",
    name: `repo-${index}`,
  }));

/** The dialog's rendered repository rows, read off their checkbox labels. */
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
        if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
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
      await filter(view.win, "web");
      expect(view.dialog()?.textContent ?? "").toContain("acme/web");

      // The slow answer for the App the user left lands last and must be dropped.
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
          apps: [{ github_app_id: 9401, bot_id: "bot-1", github_name: "Acme Inspector", github_slug: "acme-inspector" }],
          shared_bots: [],
        });
      }
      if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
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
        wire.url.endsWith("/settings")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      // Query-first: the search box exists, the 45 grants do not render.
      expect(view.win.document.querySelector("#add-repository-search")).not.toBeNull();
      expect(listed(view.win)).toHaveLength(0);

      await filter(view.win, "  repo-4  ");
      const narrowed = listed(view.win);
      // repo-4 and repo-40…repo-44 — trimmed and case-insensitive.
      expect(narrowed).toHaveLength(6);
      expect(narrowed.some((label) => label.includes("acme/repo-44"))).toBe(true);
      expect(narrowed.some((label) => label.includes("acme/repo-3"))).toBe(false);
      expect(view.dialog()?.textContent ?? "").toContain(
        t("en", "targets.addDialog.resultsCount").replace("{count}", "6"),
      );

      // Upper case is the same query: one case fold, not two code paths.
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
        wire.url.endsWith("/settings")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      // "repo-" matches all 45 rows; the dialog mounts 40 and says so.
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
      if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) return listing(many(45));
      return wireJson({});
    });
    try {
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      await view.click(addButton);
      await filter(view.win, "repo-0");
      // Tick the first row, then narrow it out of sight.
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
        wire.url.endsWith("/settings")
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
        wire.url.endsWith("/settings")
          ? settingsWith(INSTALLED)
          : wire.url.endsWith("/installation-repositories")
            ? listing(many(45))
            : wireJson({}),
    );
    try {
      // repo-41 sits past the 40-row cap, so the query is what brings it back.
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
    // I-000642 follow-up: the duplicate predicate is the BOT's, so a row a
    // sibling workspace holds can only fail the POST. The server marks it and
    // the dialog must not offer it as a choice — while the free row stays open.
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
        wire.url.endsWith("/settings")
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
        wire.url.endsWith("/settings")
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
      // Two reasons, two labels — "already existed" must not stand for
      // "another workspace reviews it".
      expect(text).toContain(t("en", "targets.addDialog.alreadyAdded"));
      expect(text).toContain(t("en", "targets.addDialog.claimedElsewhere"));
    } finally {
      await view.unmount();
    }
  });

  test("a successful add leaves nothing selected for the next open", async () => {
    // The created repository is checked+disabled on the next open, so a
    // surviving selection would keep Confirm enabled over a row that cannot be
    // submitted — and pressing it would report "already existed" for an add the
    // operator never made.
    let added = false;
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/targets") && wire.method === "POST") {
        added = true;
        return wireJson({ created: [{ target_id: "t-new", repo_id: 501, repo_owner: "acme", repo_name: "api" }], duplicates: [] }, 201);
      }
      // After the add the list carries the new target, so a stale selection
      // would line up with a disabled row.
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
      if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
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
      // The all-created path closed the dialog.
      expect(view.dialog()).toBeNull();

      await openDialog();
      // Reopened with the repository now taken by this workspace: no row can be
      // selected, so Confirm must be disabled rather than carry the old tick.
      await filter(view.win, "api");
      const boxes = [...view.win.document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].map(
        (node) => node as unknown as HTMLInputElement,
      );
      expect(boxes).toHaveLength(1);
      expect(boxes[0]?.checked).toBe(true); // the Added face
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
      if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
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
      // Cancel: the selection must not survive into the next open.
      const cancel = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t("en", "common.cancel"),
      );
      await view.click(cancel as unknown as DomElement | undefined);
      await openDialog();
      await filter(view.win, "api");
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(true);

      // A refused batch, on the other hand, keeps what the server did not
      // write so the operator can see it.
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
      if (wire.url.endsWith("/settings")) return settingsWith(installed ? INSTALLED : []);
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
      const before = view.sent.filter((wire) => wire.url.endsWith("/settings")).length;

      installed = true;
      const recheck = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t("en", "targets.addDialog.recheck"),
      );
      await view.click(recheck as unknown as DomElement | undefined);

      expect(view.sent.filter((wire) => wire.url.endsWith("/settings")).length).toBe(before + 1);
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
    // BUG-01 regression: the page settles the target list BEFORE reading apps,
    // so the dialog first mounts against `apps === []`. The selection must
    // derive from the list, not a lazy initialiser that freezes `""`.
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
      if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
      if (wire.url.endsWith("/installation-repositories")) {
        return listing([{ repo_id: 501, owner: "acme", name: "api" }]);
      }
      return wireJson({});
    });
    try {
      // The list painted while the App list is still in flight.
      expect(view.text()).not.toContain(t("en", "common.loadFailed"));
      const addButton = [...view.win.document.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "targets.add"),
      );
      expect(addButton).toBeDefined();

      // Open BEFORE the App list lands: the empty-application face, not a blank
      // select stuck in loading.
      await view.click(addButton as unknown as DomElement | undefined);
      expect(view.dialog()?.textContent ?? "").toContain(t("en", "targets.addDialog.noApps"));

      releaseApps();
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});

      // The arriving list adopts: the combobox names it and both reads ran.
      const text = view.dialog()?.textContent ?? "";
      expect(text).not.toContain(t("en", "targets.addDialog.noApps"));
      const combobox = view.win.document.querySelector('[role="dialog"] [role="combobox"]');
      expect(combobox?.textContent ?? "").toContain("Acme Inspector");
      expect(view.sent.some((wire) => wire.url.endsWith("/settings"))).toBe(true);
      expect(view.sent.some((wire) => wire.url.endsWith("/installation-repositories"))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("an ordinary load preselects the first App and enables Confirm once a row is chosen", async () => {
    // The same ordering, without holding the read: this is the everyday path the
    // regression broke — blank select, both reads parked, Confirm dead forever.
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
      if (wire.url.endsWith("/settings")) return settingsWith(INSTALLED);
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

      // The first App is preselected and the installation step resolved.
      const combobox = view.win.document.querySelector('[role="dialog"] [role="combobox"]');
      expect(combobox?.textContent ?? "").toContain("Acme Inspector");
      await filter(view.win, "api");
      expect(listed(view.win)).toHaveLength(1);

      // Choosing a row is all Confirm needs — no second click on the App step.
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(true);
      await view.click(view.win.document.querySelector('[role="dialog"] input[type="checkbox"]'));
      expect(confirmButton(view.win)?.hasAttribute("disabled")).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  test("a failed Apps read degrades the add panel instead of blanking the list", async () => {
    // `/api/apps` feeds only the add dialog: a transient failure there must not
    // replace a successfully read repository list with the page error face.
    const view = await mountTargets(createElement(TargetsPage, { boot: BOOT }), (wire) => {
      if (wire.url.endsWith("/api/apps")) return wireJson({ error: "boom" }, 500);
      if (wire.url.endsWith("/api/targets")) {
        return wireJson({ targets: [row({ repo_id: 501, repo_name: "api" })] });
      }
      return wireJson({});
    });
    try {
      // The list rendered: the row is there and the load error is not.
      expect(view.text()).toContain("acme/api");
      expect(view.text()).not.toContain(t("en", "common.loadFailed"));
      // The panel says what is unavailable and offers a retry.
      expect(view.text()).toContain(t("en", "targets.appsReadFailed"));
      expect(
        [...view.win.document.querySelectorAll("button")].some(
          (button) => button.textContent === t("en", "common.retry"),
        ),
      ).toBe(true);
      // The dialog is still reachable; it explains the missing App list itself.
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

  test("the tab names the bound App and says rebinding is not supported yet", () => {
    // I-000642: the user asked for the bot binding to be visible here. It is a
    // labelled row plus one informational line — never a rebind control.
    const markup = renderSettingsTab(1);
    expect(markup).toContain(t("en", "targets.settings.boundApp"));
    expect(markup).toContain("Acme Inspector");
    expect(markup).toContain(t("en", "targets.settings.boundAppPlanned"));
    // No control offers the change: the row is copy.
    expect(markup).not.toContain('aria-label="' + t("en", "targets.settings.boundApp") + '"');
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
      expect(view.win.document.querySelector("a")?.getAttribute("href")).toBe("/dashboard/acme/repos");
    } finally {
      await view.unmount();
    }
  });
});

/**
 * The fixed 所有仓库 entry (`…/repos/all`, product spec J1/J4): the workspace
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
      // No `follow` companion: nothing at this level inherits.
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
