/**
 * QC F2-8 (surface half): the installation-only manager's blocked face RENDERS.
 *
 * A workspace that holds a bound installation but no target of its own reads a
 * blocked App whose payload says `target_id: null` + `targets_many: false`. That
 * face must show the warning, the installation roster and the chain it still
 * mounts — not a load error, and not the creator tabs.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import {
  appDetailFace,
  parseSettings,
  type AppChainEntry,
  type SettingsBlockedInstallPayload,
  type SettingsPayload,
} from "../../src/spa/pages/data";
import { withMarkup } from "./dom";

const WORKSPACE_ID = "ws_installer";

const chainRow = (overrides: Partial<AppChainEntry> = {}): AppChainEntry => ({
  position: 1,
  bot_id: "bot-9",
  name: "Mounted Bot",
  description: null,
  provider_workspace: "Platform",
  owned: false,
  available: false,
  multiplier: 2,
  month_used_rp: 120,
  effective_monthly_rp: 5000,
  archived: false,
  default_chain: null,
  runtime: null,
  ...overrides,
});

/**
 * The exact shape the worker serves once the owner stops sharing and the
 * caller has lost its last target: blocked, an explicit null target, and
 * `targets_many: false`.
 */
function blockedInstallPayload(): SettingsBlockedInstallPayload {
  return {
    can_manage: true,
    can_edit_chain: true,
    blocked: true,
    blocked_reason: "bot_not_shared",
    viewer_relation: "installed",
    workspace_id: WORKSPACE_ID,
    target_id: null,
    targets_many: false,
    app: {
      github_app_id: 7301,
      id: "app-installer",
      status: "active",
      created_by: "dana",
      scope: "owned",
      github_name: "Shared App",
      github_slug: "shared-app",
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_visibility: "unknown",
    },
    installation: { id: 5151, account_login: "acme-org", removed: false },
    installations: [{ installation_id: 5151, account_login: "acme-org", seen_at: "2026-11-27 09:00" }],
    chain: [chainRow()],
  };
}

function renderFace(payload: SettingsPayload): string {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale: "en",
      appId: "7301",
      payload,
      groups: [],
      notice: null,
      search: { tab: "settings", window: "30", repo: "", pr: "" },
      from: "installed",
      mountable: [],
      onReload: async () => true,
      onSearch: () => {},
    }),
  );
}

describe("F2-8 — the zero-target blocked face renders the mount it still holds", () => {
  test("the payload parses as its own face, and the installed origin selects the installed face", () => {
    const payload = blockedInstallPayload();
    const parsed = parseSettings(payload);
    expect(parsed).not.toBeNull();
    expect((parsed as SettingsBlockedInstallPayload).targets_many).toBe(false);
    expect(appDetailFace((parsed as SettingsPayload).viewer_relation, "installed")).toBe("installed");
  });

  test("the warning, the roster and the chain all render", async () => {
    const markup = renderFace(blockedInstallPayload());
    // The warning states why the mount reviews nothing.
    expect(markup).toContain(t("en", "appDetail.blockedBotNotShared"));
    // The roster names the installation this workspace still holds.
    expect(markup).toContain(t("en", "settings.installations"));
    expect(markup).toContain("acme-org");
    // The chain renders its mounted row — a mount, not an absent chain.
    expect(markup).toContain("Mounted Bot");
    const rows = await withMarkup(markup, (container) => container.querySelectorAll("tbody tr").length);
    expect(rows).toBeGreaterThan(0);
    // No creator surface on a mount: the ADR's two-origins rule.
    expect(markup).not.toContain(t("en", "settings.providers.title"));
    expect(markup).not.toContain(t("en", "apps.shareAppSwitch"));
  });

  test("the several-targets face keeps its own copy and does not claim a single target", () => {
    const many: SettingsPayload = {
      ...blockedInstallPayload(),
      targets_many: true,
      installation: null,
      installations: [],
    };
    const markup = renderFace(many);
    expect(markup).toContain(t("en", "appDetail.blockedBotNotShared"));
    // Nothing is mounted for this workspace: the roster is empty, never a
    // stand-in for the single-target face's bound row.
    expect(markup).not.toContain("acme-org");
  });
});
