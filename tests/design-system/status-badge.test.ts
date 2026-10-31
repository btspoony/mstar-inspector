/**
 * StatusBadge — the tone × strength matrix.
 *
 * Two contracts, asserted in the same loop over the fifteen faces:
 *
 * - the semantic identity: every pair renders its own `data-tone` /
 *   `data-strength` and the caller's label, and no two faces are the same;
 * - the paint wiring: `quiet` withholds the fill, `soft` takes the tone's tint,
 *   `solid` takes the tone's solid step, and every paint names a token of the
 *   SAME tone's family. The fifteen faces are spelled in exactly one place
 *   (`patterns/status-badge.tsx`), so swapping two entries, tinting a quiet pill
 *   or dropping a literal colour in fails here instead of restyling silently.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StatusBadge,
  type StatusStrength,
  type StatusTone,
} from "../../src/design-system";
import { PALETTE_UTILITY_SOURCE } from "../helpers/tailwind-palette";

const TONES: readonly StatusTone[] = ["neutral", "accent", "success", "warn", "danger"];
const STRENGTHS: readonly StatusStrength[] = ["quiet", "soft", "solid"];

/** The palette the face must not name — the same list the both-theme pass runs. */
const PALETTE_UTILITY = new RegExp(PALETTE_UTILITY_SOURCE);

const render = (tone: StatusTone, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(StatusBadge, { tone, ...extra }, "Active"));

/** The class list one rendered span carries. */
const classList = (html: string): string => / class="([^"]*)"/.exec(html)?.[1] ?? "";

/**
 * Every paint in a class list, as the token it names or the `transparent`
 * keyword: `bg-(--tone-warn-bg)` reads as `tone-warn-bg`. A bare width utility
 * (`border`) and the typography group (`text-(length:--…)`) paint nothing.
 */
const paints = (classes: string, property: "bg" | "border" | "text"): string[] =>
  [
    ...classes.matchAll(
      new RegExp(`(?<![\\w-])${property}-\\(--([a-z0-9-]+)\\)|(?<![\\w-])${property}-(transparent)`, "g"),
    ),
  ].map((match) => match[1] ?? (match[2] as string));

describe("StatusBadge", () => {
  test("every tone × strength renders its own identity, the caller's label, and the strength's paint", () => {
    const faces = new Set<string>();
    for (const tone of TONES) {
      for (const strength of STRENGTHS) {
        const html = render(tone, { strength });
        const face = `${tone} × ${strength}`;
        expect(html, face).toContain(`data-tone="${tone}" data-strength="${strength}"`);
        expect(html, face).toContain(">Active</span>");
        faces.add(html);

        const classes = classList(html);
        const [fill] = paints(classes, "bg");
        const [edge] = paints(classes, "border");
        const [label] = paints(classes, "text");

        // No literal colour on any face: every paint is a token, or the
        // withheld `transparent` keyword. This is the negative the retired
        // component test carried, over the full Tailwind palette rather than a
        // 13-family subset of it.
        expect(classes, face).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(classes, face).not.toMatch(PALETTE_UTILITY);

        if (strength === "quiet") {
          // The edge and the label carry the meaning; the fill is withheld.
          expect(fill, face).toBe("transparent");
          expect(edge, face).toBe(`tone-${tone}-border`);
          expect(label, face).toBe(`tone-${tone}-fg`);
        }
        if (strength === "soft") {
          expect(fill, face).toBe(`tone-${tone}-bg`);
          expect(edge, face).toBe(`tone-${tone}-border`);
          expect(label, face).toBe(`tone-${tone}-fg`);
        }
        if (strength === "solid") {
          expect(fill, face).toBe(`tone-${tone}-solid`);
          expect(edge, face).toBe("transparent");
          // The label sits on its own solid step: the page ink, except accent,
          // whose solid is the primary-action fill and takes the brand label.
          expect(label, face).toBe(tone === "accent" ? "on-brand" : "surface-page");
        }
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
