/**
 * StatCard + StatGrid — label / value / hint / progress, and the grid that
 * makes them one definition list.
 *
 * Static render: no hooks, so every prop (and the 0–1 progress clamp) is
 * asserted on the emitted markup.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatCard, StatGrid } from "../../../src/spa/components/StatCard";

const LABEL = "text-(length:--typo-label-12-size)";
const VALUE = "text-(length:--typo-heading-16-size)";

const render = (props: Parameters<typeof StatCard>[0]) =>
  renderToStaticMarkup(createElement(StatCard, props));

describe("StatCard", () => {
  test("label is the uppercase muted label-12 step", () => {
    const html = render({ label: "Plan", value: "Team" });
    const label = html.match(/<dt class="([^"]*)">Plan<\/dt>/)?.[1] ?? "";
    expect(label).toContain(LABEL);
    expect(label).toContain("leading-(--typo-label-12-line)");
    expect(label).toContain("tracking-(--typo-label-12-tracking)");
    expect(label).toContain("font-(weight:--typo-label-12-weight)");
    expect(label).toContain("uppercase");
    expect(label).toContain("text-muted-foreground");
  });

  test("value is one step larger and tabular", () => {
    const html = render({ label: "Members", value: "3 / 8" });
    const value = html.match(/<dd class="([^"]*)">3 \/ 8<\/dd>/)?.[1] ?? "";
    expect(value).toContain(VALUE);
    expect(value).toContain("leading-(--typo-heading-16-line)");
    expect(value).toContain("tracking-(--typo-heading-16-tracking)");
    expect(value).toContain("tabular-nums");
  });

  test("hint line is optional and muted", () => {
    expect(render({ label: "Members", value: "3 / 8" })).not.toContain(
      '<dd class="text-xs text-muted-foreground">',
    );
    expect(render({ label: "Members", value: "3 / 8", hint: "5 slots left" })).toContain(
      '<dd class="text-xs text-muted-foreground">5 slots left</dd>',
    );
  });

  test("progress bar is optional and carries its 0–1 ratio as accessible value", () => {
    expect(render({ label: "Seats", value: "3 / 8" })).not.toContain('role="progressbar"');
    const html = render({ label: "Seats", value: "3 / 8", progress: 0.5 });
    expect(html).toContain('role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"');
    expect(html).toContain("w-[50%]");
  });

  test("progress clamps to the 0–1 range at both ends", () => {
    expect(render({ label: "Seats", value: "0 / 8", progress: 0 })).toContain('aria-valuenow="0"');
    expect(render({ label: "Seats", value: "0 / 8", progress: -2 })).toContain('aria-valuenow="0"');
    expect(render({ label: "Seats", value: "0 / 8", progress: 0 })).toContain("w-0");
    expect(render({ label: "Seats", value: "8 / 8", progress: 1 })).toContain('aria-valuenow="100"');
    expect(render({ label: "Seats", value: "8 / 8", progress: 9 })).toContain("w-full");
  });
});

describe("StatGrid", () => {
  test("plain responsive columns over a semantic definition list", () => {
    const html = renderToStaticMarkup(
      createElement(
        StatGrid,
        null,
        createElement(StatCard, { label: "Plan", value: "Team" }),
        createElement(StatCard, { label: "Members", value: "3 / 8" }),
      ),
    );
    expect(html).toStartWith('<dl class="grid gap-4 sm:grid-cols-3">');
    expect(html).toEndWith("</dl>");
    // Two dt/dd groups inside one dl — the card is written for this wrapper.
    expect(html.match(/<dt /g)?.length).toBe(2);
    expect(html.match(/<div class="flex flex-col gap-1">/g)?.length).toBe(2);
  });
});
