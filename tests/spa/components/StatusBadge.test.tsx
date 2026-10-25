/**
 * StatusBadge — every tone resolves to the existing component/token colors,
 * never to a literal color value.
 *
 * Static render: tone is the only presentation input, so each tone is asserted
 * on the emitted class list and the output is checked for hex/rgb coloring.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StatusBadge,
  type StatusTone,
} from "../../../src/spa/components/StatusBadge";

const render = (tone: StatusTone, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(StatusBadge, { tone, ...extra }, "Active"));

/** The tone → token pairs DESIGN.md Badge declares. */
const TONE_CLASSES: Record<StatusTone, readonly string[]> = {
  neutral: ["bg-(--badge-bg)", "text-(--badge-fg)"],
  success: ["bg-(--badge-success-bg)", "text-(--badge-success-fg)"],
  warning: ["bg-(--badge-warn-bg)", "text-(--badge-warn-fg)"],
  error: ["bg-(--badge-error-bg)", "text-(--badge-error-fg)"],
  brand: ["bg-(--brand-700)", "text-(--background-100)"],
};

describe("StatusBadge", () => {
  test("every tone resolves to its token-backed classes", () => {
    for (const tone of Object.keys(TONE_CLASSES) as StatusTone[]) {
      const html = render(tone);
      for (const cls of TONE_CLASSES[tone]) expect(html, tone).toContain(cls);
      // Tone is the only color source: no literal color anywhere.
      expect(html, tone).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, tone).not.toContain("rgb(");
    }
  });

  test("pill shape rides the badge component tokens", () => {
    const html = render("neutral");
    expect(html).toContain("inline-flex h-(--badge-height) items-center rounded-(--badge-radius) px-2");
  });

  test("label is caller-owned content", () => {
    expect(render("success")).toBe(
      '<span class="inline-flex h-(--badge-height) items-center rounded-(--badge-radius) px-2 text-xs font-medium bg-(--badge-success-bg) text-(--badge-success-fg)">Active</span>',
    );
  });

  test("className merges over the tone face; other span props pass through", () => {
    const html = render("warning", { className: "ml-2", title: "Paused reviews" });
    expect(html).toContain('title="Paused reviews"');
    expect(html).toContain("bg-(--badge-warn-bg)");
    expect(html).toContain("ml-2");
  });
});
