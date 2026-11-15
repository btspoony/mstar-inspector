/**
 * The review-target surface (`/dashboard/<ref>/targets` and
 * `…/targets/:appId`) — the fourth workspace surface that hosts the
 * target-owned review policy the App detail's settings tab used to carry.
 *
 * Static SSR pins the list's empty copy and the per-target link; the mounted
 * case proves an EXISTING target renders with its controls on its own page
 * (no App page in the path), reading the same app-addressed settings payload.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { AppsList } from "../../src/spa/pages/AppsPage";
import { parseApps, type AppsPayload, type SettingsManagePayload } from "../../src/spa/pages/data";
import { TargetDetailPage, TargetsView } from "../../src/spa/pages/TargetsPage";
import { installDom } from "./dom";
import { withLocation } from "./browser-stub";

/** A manager face with an overlapping owner claim, so every control renders. */
const targetPayload: SettingsManagePayload = {
  can_manage: true,
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
  allowlist: { enabled: false, owners: [] },
  owner_overlap: true,
  keys: [],
  model_chain: null,
  model_limits_snapshot: "2026-01-01",
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog: [],
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
  deliveries: [],
};

const emptyList = (): AppsPayload => ({
  viewer: { login: "mallory", role: "admin" },
  apps: [],
  shared_bots: [],
});

const oneTarget = (): AppsPayload => ({
  viewer: { login: "mallory", role: "admin" },
  apps: [
    {
      github_app_id: 1,
      github_name: "Demo",
      github_slug: "demo",
      github_avatar_url: null,
      status: "active",
      review_enabled: 1,
      created_by: "mallory",
      health: { latest: null, rejected24h: 0 },
    },
  ],
});

const boot = { locale: "en" as const, login: "mallory", name: null };

describe("review-target list (static SSR)", () => {
  test("an empty workspace states the two creation paths in one sentence", () => {
    const markup = withLocation("/dashboard/acme/targets", () =>
      renderToStaticMarkup(
        createElement(TargetsView, {
          locale: "en",
          state: "ok",
          payload: emptyList(),
          onRetry: () => {},
        }),
      ),
    );
    expect(markup).toContain(t("en", "targets.heading"));
    expect(markup).toContain(t("en", "targets.emptyTitle"));
    expect(markup).toContain(t("en", "targets.emptyDescription"));
    // No dead row and no action that could not land: the empty face is copy.
    expect(markup).not.toContain('href="/dashboard/acme/targets/');
  });

  test("an existing target links to its own surface, not the App page", () => {
    const markup = withLocation("/dashboard/acme/targets", () =>
      renderToStaticMarkup(
        createElement(AppsList, { locale: "en", payload: oneTarget(), detailSegment: "targets" }),
      ),
    );
    expect(markup).toContain('href="/dashboard/acme/targets/1"');
    expect(markup).not.toContain('href="/dashboard/acme/apps/1"');
    expect(markup).toContain("Demo");
  });

  test("the empty copy is the dictionary pair the surface renders", () => {
    // The exact strings the product round fixed; both locales carry them.
    expect(t("en", "targets.emptyTitle")).toBe("No review targets yet");
    expect(t("en", "targets.emptyDescription")).toBe(
      "Review targets come from GitHub Apps — create one, or attach the shared bot if your plan includes it.",
    );
    expect(t("zh_CN", "targets.heading")).toBe("审查目标");
  });
});

describe("review-target detail (mounted)", () => {
  test("an existing target renders its policy controls without visiting an App page", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/targets/1");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(targetPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(TargetDetailPage, { boot, appId: "1" })));
      await act(async () => {});
      const text = container.textContent ?? "";

      // The identity header + the target-owned policy sections.
      expect(text).toContain("Demo");
      for (const key of [
        "settings.reviewTrigger",
        "settings.reviewDepth",
        "settings.reviewGate",
        "settings.ops",
      ] as const) {
        expect(text, key).toContain(t("en", key));
      }
      // The controls the plan names: pause, park (the claim overlaps here).
      expect(text).toContain(t("en", "settings.pauseReviews"));
      expect(text).toContain(t("en", "settings.opsParkAction"));
      // Wayfinding: back to the list, and across to the bot's own page (which
      // keeps its app-scoped path).
      expect(container.querySelector(`a[href="/dashboard/acme/targets"]`)).not.toBeNull();
      expect(container.querySelector(`a[href="/dashboard/acme/apps/1/bot"]`)).not.toBeNull();
      // No App-detail tab machinery on this surface.
      expect(container.querySelector('[role="tablist"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("the list payload parser accepts the same rows the Apps page reads", () => {
    // ONE data face: the target list is the existing app list, normalized by
    // the same parser.
    expect(parseApps(oneTarget())?.apps[0]?.github_app_id).toBe(1);
    expect(parseApps(emptyList())?.apps).toEqual([]);
  });
});
