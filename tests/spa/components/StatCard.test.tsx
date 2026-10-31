/**
 * StatCard + StatGrid — label / value / hint / progress, and the grid that
 * makes them one definition list.
 *
 * Static render: no hooks, so every prop (and the 0–1 progress clamp) is
 * asserted on the emitted markup. The assertions name the definition-list
 * structure, the rendered text and the accessible progress values — never a
 * design-token class, so a token rename cannot false-fail this file.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatCard, StatGrid } from "../../../src/spa/components/StatCard";

const render = (props: Parameters<typeof StatCard>[0]) =>
  renderToStaticMarkup(createElement(StatCard, props));

describe("StatCard", () => {
  test("the label is the definition term, ahead of the figure", () => {
    const html = render({ label: "Plan", value: "Team" });
    const term = html.indexOf("<dt ");
    const figure = html.indexOf(">Team</dd>");
    expect(term).toBeGreaterThan(-1);
    expect(term).toBeLessThan(figure);
    expect(html).toContain(">Plan</dt>");
  });

  test("the figure is the definition value under its label", () => {
    const html = render({ label: "Members", value: "3 / 8" });
    expect(html).toContain(">Members</dt>");
    expect(html).toContain(">3 / 8</dd>");
  });

  test("hint line is optional and rides its own definition value", () => {
    expect(render({ label: "Members", value: "3 / 8" })).not.toContain("5 slots left");
    const html = render({ label: "Members", value: "3 / 8", hint: "5 slots left" });
    expect(html).toContain(">5 slots left</dd>");
    expect(html.indexOf(">3 / 8</dd>")).toBeLessThan(html.indexOf("5 slots left"));
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
    expect(html).toStartWith("<dl ");
    expect(html).toEndWith("</dl>");
    // Two dt/dd groups inside one dl — the card is written for this wrapper.
    expect(html.match(/<dt /g)?.length).toBe(2);
    expect(html.match(/<dd /g)?.length).toBe(2);
    expect(html).toContain(">Plan</dt>");
    expect(html).toContain(">3 / 8</dd>");
  });
});
