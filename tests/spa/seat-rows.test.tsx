/**
 * I-000648: 席位链 rendered each seat as a stacked pair — `name — role` on one
 * line and a full-size select on the next — so five seats read as five tall
 * blocks and 保存席位链 trailed the last seat.
 *
 * Pinned structurally over the rendered section: one `<label>` row per seat
 * carries BOTH the identity and its select, and the save is the section's own
 * trailing action outside every row. The control's behaviour is untouched.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { SeatsSection } from "../../src/spa/pages/SettingsPage";
import type { BotConfigSections } from "../../src/spa/pages/data";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { withMarkup } from "./dom";

const ROLES = ["mstar-review-seat", "deep-seat", "docs-seat"];

const seatsHtml = (): string =>
  renderToStaticMarkup(
    createElement(SeatsSection, {
      locale: "en",
      payload: {
        app: {
          github_app_id: 1,
          status: "active",
          last_webhook_at: null,
          scope: "owned",
          id: "app-test",
          sandbox_image_id: "omp",
          github_name: null,
          github_slug: null,
          github_description: null,
          github_html_url: null,
          github_avatar_url: null,
          github_metadata_synced_at: null,
        },
        keys: [],
        model_chain: null,
        model_roles: {},
        model_chains: [],
        custom_providers: [],
        configured_providers: [],
        provider_catalog_version: "fixture-catalog",
        provider_eligibility: {},
        model_role_ids: ROLES,
        custom_provider_api_ids: ["openai-completions"],
        sandbox_images: [{ id: "omp", enabled: true }],
        installations: [],
      } satisfies BotConfigSections,
      onSettings: async () => ({ kind: "success", message: "saved" }) satisfies OpNotice,
    }),
  );

describe("I-000648: a seat and its chain are one scannable row", () => {
  test("each seat is one row carrying both its identity and its select", async () => {
    const rows = await withMarkup(seatsHtml(), (container) =>
      [...container.querySelectorAll("label")].map((label) => ({
        text: (label.textContent ?? "").trim(),
        classes: [...label.classList],
        selects: label.querySelectorAll('[role="combobox"]').length,
      })),
    );

    expect(rows).toHaveLength(ROLES.length);
    for (const [index, role] of ROLES.entries()) {
      const row = rows[index]!;
      // Identity and control together: the seat name AND exactly one select.
      // A stacked pair would put the select in a second block under the
      // identity — `flex-col` is what that shape reads as.
      expect(row.text.startsWith(`${role} — `), role).toBe(true);
      expect(row.selects, role).toBe(1);
      expect(row.classes, role).not.toContain("flex-col");
      // The role caption stays in the row, not dropped with the stacked layout.
      expect(row.text.length, role).toBeGreaterThan(role.length + 3);
    }
  });

  test("the save action belongs to the section, not to the last seat's row", async () => {
    const save = await withMarkup(seatsHtml(), (container) => {
      const button =
        [...container.querySelectorAll("button")].find(
          (node) => node.textContent === t("en", "settings.saveRoleModels"),
        ) ?? null;
      return {
        exists: button !== null,
        insideSeatRow: button?.closest("label") !== null,
        classes: [...(button?.parentElement?.classList ?? [])],
        rows: container.querySelectorAll("label").length,
      };
    });

    expect(save.exists).toBe(true);
    // A save nested in the last seat's label would read as that seat's action.
    expect(save.insideSeatRow).toBe(false);
    expect(save.classes).toContain("justify-end");
    expect(save.rows).toBe(ROLES.length);
  });
});
