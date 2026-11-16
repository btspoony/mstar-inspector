/**
 * The repository surface's rendered faces (product spec J1/J2, plan 371.2).
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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  AddRepositoryDialogBody,
  repositoryCountLabel,
  TargetsView,
  targetStatusPill,
} from "../../src/spa/pages/TargetsPage";
import type { RepositoryOptionsState } from "../../src/spa/pages/TargetsPage";
import type { InstallationRepositoryOption, RepositoryAppOption, TargetListRow } from "../../src/spa/pages/data";
import { withLocation } from "./browser-stub";

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
