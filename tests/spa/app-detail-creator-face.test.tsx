import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  parseAppDetailSearch,
  type AppDetailTab,
  type SettingsManagePayload,
  type SettingsUntargetedPayload,
} from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import { withMarkup } from "./dom";

const managePayload: SettingsManagePayload = {
  can_manage: true,
  viewer_relation: "created",
  official_workspace: true,
  can_configure_bot: true,
  installation: null,
  pending_installations: [],
  blocked: false,
  blocked_reason: null,
  workspace_id: "ws_0123456789abcdefghijkl",
  target_id: "rt-1",
  app: {
    github_slug: "demo",
    id: "app-demo",
    github_app_id: 1,
    status: "active",
    review_enabled: true,
    created_by: "mallory",
    github_name: "Demo",
    github_description: null,
    github_html_url: "https://github.com/apps/demo",
    github_avatar_url: null,
    github_metadata_synced_at: null,
    last_webhook_at: null,
    scope: "owned",
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push",
    review_level: null,
    default_review_level: "default",
    github_visibility: "unknown",
  },
  check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog_version: "fixture-catalog",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
};

const untargetedPayload: SettingsUntargetedPayload = {
  can_manage: true,
  viewer_relation: "created",
  official_workspace: true,
  can_configure_bot: true,
  installation: null,
  pending_installations: [],
  blocked: false,
  blocked_reason: null,
  workspace_id: managePayload.workspace_id,
  app: {
    github_app_id: managePayload.app.github_app_id,
    id: managePayload.app.id,
    status: managePayload.app.status,
    created_by: "mallory",
    last_webhook_at: null,
    sandbox_image_id: "omp",
    scope: "owned",
    github_name: managePayload.app.github_name,
    github_slug: managePayload.app.github_slug,
    github_description: managePayload.app.github_description,
    github_html_url: managePayload.app.github_html_url,
    github_avatar_url: managePayload.app.github_avatar_url,
    github_metadata_synced_at: managePayload.app.github_metadata_synced_at,
    github_visibility: "unknown",
  },
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog_version: "fixture-catalog",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
};

const search = { tab: "settings" as const, window: "30" as const, repo: "", pr: "" };

function renderFace(payload: SettingsManagePayload | SettingsUntargetedPayload, tab: AppDetailTab = "settings") {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale: "en",
      appId: "1",
      payload,
      groups: [],
      notice: null,
      search: { ...search, tab },
      onReload: async () => true,
      onSearch: () => {},
    }),
  );
}

const tabLabels = (container: HTMLElement): string[] =>
  [...(container.querySelector('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])].map(
    (tab) => tab.textContent ?? "",
  );

describe("creator face — three tabs, no bots tab", () => {
  test("the tab bar is exactly 应用设置 / 投递状态 / 已安装", async () => {
    expect(await withMarkup(renderFace(managePayload), tabLabels)).toEqual([
      t("en", "appDetail.tabSettings"),
      t("en", "appDetail.tabDelivery"),
      t("en", "appDetail.tabInstallations"),
    ]);
  });

  test("?tab=bots no longer names an address on this page", () => {
    expect(parseAppDetailSearch("?tab=bots").tab).toBe("settings");
  });
});

describe("creator face — one merged GitHub App section", () => {
  test("the credential state is a sub-row of the App info section, not its own block", async () => {
    const markup = renderFace(managePayload);
    expect(markup).not.toContain('data-slot="app-credentials"');
    const found = await withMarkup(markup, (container) => {
      const section = [...container.querySelectorAll('[data-slot="flow-section"]')].find((node) =>
        (node.textContent ?? "").includes(t("en", "settings.appInfo")),
      );
      return section === undefined
        ? null
        : {
            stored: (section.textContent ?? "").includes(t("en", "appDetail.credentialsStored")),
            value: (section.textContent ?? "").includes(t("en", "appDetail.credentialsStoredValue")),
          };
    });
    expect(found).toEqual({ stored: true, value: true });
  });

  test("no repository notice renders, targeted or not", () => {
    for (const payload of [managePayload, untargetedPayload] as const) {
      const markup = renderFace(payload);
      expect(markup).not.toContain(t("en", "appDetail.noRepository"));
      expect(markup).not.toContain(t("en", "appDetail.targetsMany"));
    }
  });

  test("no 24h refusal figure rides this face", () => {
    const markup = renderFace({
      ...managePayload,
      delivery_summary: {
        latest: { event_name: "push", outcome: "ok", status_code: 200, created_at: "2026-01-01 00:00:00" },
        rejected24h: 7,
      },
    });
    expect(markup).not.toContain("24h");
  });
});

describe("creator face — the share switch is the official workspace's", () => {
  test("the official workspace gets the full switch", () => {
    const markup = renderFace(managePayload);
    expect(markup).toContain(t("en", "apps.shareAppSwitch"));
    expect(markup).not.toContain('data-slot="app-share-readonly"');
  });

  test("any other workspace gets the read-only state line, never the switch", () => {
    const markup = renderFace({ ...managePayload, official_workspace: false });
    expect(markup).not.toContain(t("en", "apps.shareAppSwitch"));
    expect(markup).toContain(t("en", "apps.shareAppOff"));
    expect(markup).toContain('data-slot="app-share-readonly"');
  });
});
