import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { HTMLElement as DomHTMLElement } from "happy-dom";
import { t } from "../../src/i18n";
import { TokenUsageSection, TokenUsageTable } from "../../src/spa/pages/AppInsightsTab";
import { targetTokenUsageUrl, type TargetTokenUsage } from "../../src/spa/pages/data";
import { installDom } from "./dom";

const USAGE: TargetTokenUsage = {
  window_days: 30,
  buckets: [
    { provider: "ark", model: "deepseek-v4-flash", requests: 5, input: 150, cache_read: 10, cache_write: 5, output: 60, total: 225, cost_usd: 0.75 },
    { provider: "openai", model: "gpt-5.2", requests: 1, input: 7, cache_read: 0, cache_write: 0, output: 3, total: 10, cost_usd: 0.125 },
  ],
  total: { requests: 6, input: 157, cache_read: 10, cache_write: 5, output: 63, total: 235, cost_usd: 0.875 },
};

const EMPTY: TargetTokenUsage = {
  window_days: 7,
  buckets: [],
  total: { requests: 0, input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, cost_usd: 0 },
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function mount(
  respond: (url: string) => Response,
): Promise<{ container: DomHTMLElement; calls: string[]; close: () => Promise<void> }> {
  const { win, cleanup } = installDom("http://localhost/dashboard/ws_two/apps/1");
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return respond(url);
  }) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(createElement(TokenUsageSection, { locale: "en", targetId: "t-1", windowDays: "30" })),
  );
  await act(async () => {});
  return {
    container,
    calls,
    close: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

describe("targetTokenUsageUrl", () => {
  test("rides the page's window verbatim and the target path", () => {
    expect(targetTokenUsageUrl("/dashboard/ws_two", "t-1", "7")).toBe(
      "/dashboard/ws_two/api/targets/t-1/token-usage?window=7",
    );
    expect(targetTokenUsageUrl("/dashboard", "t 1", "90")).toBe(
      "/dashboard/api/targets/t%201/token-usage?window=90",
    );
  });
});

describe("TokenUsageSection", () => {
  test("renders one row per (provider, model) from the payload plus the total", async () => {
    const page = await mount(() => json(USAGE));
    try {
      const rows = [...page.container.querySelectorAll("tbody tr")];
      expect(rows).toHaveLength(2);
      const cells = rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
      expect(cells[0]).toEqual(["ark", "deepseek-v4-flash", "5", "150", "10", "5", "60", "225", "$0.7500"]);
      expect(cells[1]).toEqual(["openai", "gpt-5.2", "1", "7", "0", "0", "3", "10", "$0.1250"]);
      expect(page.container.textContent).toContain(
        t("en", "insights.tokenUsage.totalSummary", { tokens: 235, cost: "0.8750" }),
      );
      expect(page.calls).toEqual(["/dashboard/ws_two/api/targets/t-1/token-usage?window=30"]);
    } finally {
      await page.close();
    }
  });

  test("renders the empty state when the window has no buckets", async () => {
    const page = await mount(() => json(EMPTY));
    try {
      expect(page.container.querySelector("tbody")).toBeNull();
      expect(page.container.textContent).toContain(t("en", "insights.tokenUsage.empty"));
    } finally {
      await page.close();
    }
  });

  test("a drifted payload is a failed read, not a half-rendered table", async () => {
    const page = await mount(() => json({ window_days: 30, buckets: "no", total: {} }));
    try {
      expect(page.container.querySelector("tbody")).toBeNull();
      expect(page.container.textContent).toContain(t("en", "common.loadFailed"));
    } finally {
      await page.close();
    }
  });
});

describe("TokenUsageTable locales", () => {
  for (const locale of ["en", "zh_CN"] as const) {
    test(`${locale} renders translated headers and the total line`, () => {
      const html = renderToStaticMarkup(createElement(TokenUsageTable, { locale, usage: USAGE }));
      expect(html).toContain(t(locale, "insights.tokenUsage.provider"));
      expect(html).toContain(t(locale, "insights.tokenUsage.cacheRead"));
      expect(html).toContain(
        t(locale, "insights.tokenUsage.totalSummary", { tokens: 235, cost: "0.8750" }),
      );
    });
  }

  test("zh-CN renders the empty copy", () => {
    const html = renderToStaticMarkup(createElement(TokenUsageTable, { locale: "zh_CN", usage: EMPTY }));
    expect(html).toContain(t("zh_CN", "insights.tokenUsage.empty"));
  });
});
