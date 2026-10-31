/**
 * StatusBadge — the tone × strength matrix.
 *
 * The contract is the semantic identity, not the utility classes: every pair
 * renders its own `data-tone`/`data-strength` and the caller's label, and the
 * fifteen faces stay distinct. A design-token rename must not fail these.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StatusBadge,
  type StatusStrength,
  type StatusTone,
} from "../../src/design-system";

const TONES: readonly StatusTone[] = ["neutral", "accent", "success", "warn", "danger"];
const STRENGTHS: readonly StatusStrength[] = ["quiet", "soft", "solid"];

const render = (tone: StatusTone, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(StatusBadge, { tone, ...extra }, "Active"));

describe("StatusBadge", () => {
  test("every tone × strength renders its own identity and the caller's label", () => {
    const faces = new Set<string>();
    for (const tone of TONES) {
      for (const strength of STRENGTHS) {
        const html = render(tone, { strength });
        expect(html, `${tone} × ${strength}`).toContain(
          `data-tone="${tone}" data-strength="${strength}"`,
        );
        expect(html, `${tone} × ${strength}`).toContain(">Active</span>");
        faces.add(html);
      }
    }
    expect(faces.size).toBe(TONES.length * STRENGTHS.length);
  });

  test("strength defaults to the tinted pill", () => {
    expect(render("success")).toContain('data-strength="soft"');
  });

  test("a caller cannot spoof the semantic identity", () => {
    const html = render("danger", {
      strength: "quiet",
      "data-tone": "success",
      "data-strength": "solid",
    });
    expect(html).toContain('data-tone="danger" data-strength="quiet"');
    expect(html).not.toContain('data-tone="success"');
    expect(html).not.toContain('data-strength="solid"');
    // Exactly one of each survives the merge.
    expect(html.split('data-tone="').length - 1).toBe(1);
    expect(html.split('data-strength="').length - 1).toBe(1);
  });

  test("className merges over the face; other span props pass through", () => {
    const html = render("warn", { className: "ml-2", title: "Paused reviews" });
    expect(html).toContain('title="Paused reviews"');
    expect(html).toContain("ml-2");
    expect(html).toContain('data-tone="warn" data-strength="soft"');
  });
});
