import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { type Element as DomElement, type Window } from "happy-dom";
import { t } from "../../src/i18n";
import { QuotaVersionsPage } from "../../src/spa/admin/QuotaVersionsPage";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

type Sent = { url: string; method: string; body: unknown };
type Respond = (request: Sent) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Surface = {
  win: Window;
  container: DomElement;
  sent: Sent[];
  text: () => string;
  click: (node: DomElement | null) => Promise<void>;
  type: (selector: string, value: string) => Promise<void>;
  close: () => Promise<void>;
};

async function mount(respond: Respond): Promise<Surface> {
  const { win, cleanup } = installDom("http://localhost/_internal_admin");
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    return respond(request);
  }) as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(QuotaVersionsPage, { locale: "en" })));
  await act(async () => {});

  return {
    win,
    container,
    sent,
    text: () => container.textContent ?? "",
    async click(node: DomElement | null) {
      await act(async () => {
        node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
    },
    async type(selector: string, value: string) {
      const input = container.querySelector(selector);
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, value);
        input?.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
    },
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

const DATA = {
  judgingVersion: 1,
  nextVersion: 2,
  uncoveredPlanIds: [],
  plans: [
    { id: "free", name: "Free" },
    { id: "pro", name: "Pro" },
    { id: "unlimited", name: "Unlimited" },
  ],
  versions: [
    {
      id: "quota-v1",
      version: 1,
      effectiveFrom: "2026-10-24T00:00:00.000Z",
      effectiveTo: null,
      state: "current",
      base: { quick: 1, default: 2, deep: 6 },
      source: { byok: 1, shared: 10 },
      rpPerCredit: 20,
      notes: "v1 baseline",
      monthlyRp: { free: 2000, pro: 20000, unlimited: null },
    },
  ],
};

const IMPACT = { count: 2, total: 12, startsOn: "2026-12-01" };

const publishButton = (surface: Surface): DomElement | null =>
  surface.container.querySelector('button[type="submit"]');

const previewButton = (surface: Surface): DomElement | null =>
  surface.container.querySelector('button[type="button"]');

describe("console quota versions page", () => {
  test("lists each version with its interval and the current marker", async () => {
    const surface = await mount(() => json(DATA));
    expect(surface.text()).toContain(t("en", "admin.nav.quotaVersions"));
    expect(surface.text()).toContain("v1");
    expect(surface.text()).toContain("2026-10-24 → —");
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.statusCurrent"));
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.formTitle"));
    expect(surface.text()).toContain("v2");
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.previewRequired"));
    expect(publishButton(surface)?.hasAttribute("disabled")).toBe(true);
    await surface.close();
  });

  test("a judging version that skips a plan is reported, naming the plan", async () => {
    const surface = await mount(() => json({ ...DATA, uncoveredPlanIds: ["pro"] }));
    expect(surface.text()).toContain(
      t("en", "admin.quotaVersions.uncoveredPlans", { version: 1, plans: "Pro" }),
    );
    await surface.close();
  });

  test("a fully covered judging version renders no coverage notice", async () => {
    const surface = await mount(() => json(DATA));
    expect(surface.text()).not.toContain(
      t("en", "admin.quotaVersions.uncoveredPlans", { version: 1, plans: "Pro" }),
    );
    expect(surface.text()).toContain("v1");
    await surface.close();
  });

  test("publishing is refused until a preview exists: no click, no request", async () => {
    const surface = await mount(() => json(DATA));
    await surface.click(publishButton(surface));
    expect(surface.sent.filter((request) => request.method === "POST")).toEqual([]);
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.previewRequired"));
    await surface.close();
  });

  test("the preview posts the candidate numbers and shows the count and the first judging 1st", async () => {
    const surface = await mount((request) =>
      request.url.endsWith("/quota-versions/preview") ? json(IMPACT) : json(DATA),
    );
    await surface.click(previewButton(surface));

    const preview = surface.sent.find((request) => request.url.endsWith("/quota-versions/preview"));
    expect(preview?.body).toMatchObject({
      effectiveFrom: new Date().toISOString().slice(0, 10),
      base: { quick: 1, default: 2, deep: 6 },
      source: { byok: 1, shared: 10 },
      rpPerCredit: 20,
      monthlyRp: { free: 2000, pro: 20000, unlimited: null },
    });
    expect(surface.text()).toContain(
      t("en", "admin.quotaVersions.previewCount", { count: 2, total: 12 }),
    );
    expect(surface.text()).toContain(
      t("en", "admin.quotaVersions.previewStartsOn", { date: "2026-12-01" }),
    );
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.effectiveFromJudges", { date: "2026-12-01" }));
    expect(publishButton(surface)?.hasAttribute("disabled")).toBe(false);
    await surface.close();
  });

  test("publishing carries the preview it was shown and reports the stored ordinal", async () => {
    const surface = await mount((request) => {
      if (request.url.endsWith("/quota-versions/preview")) return json(IMPACT);
      if (request.url.endsWith("/quota-versions") && request.method === "POST") {
        return json({ version: 2, startsOn: "2026-12-01" }, 201);
      }
      return json(DATA);
    });
    await surface.click(previewButton(surface));
    await surface.click(publishButton(surface));

    const publish = surface.sent.find(
      (request) => request.method === "POST" && request.url.endsWith("/quota-versions"),
    );
    expect(publish?.body).toMatchObject({ impact: IMPACT, notes: null });
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.published", { version: 2 }));
    expect(surface.sent.filter((request) => request.method === "GET").length).toBeGreaterThan(1);
    await surface.close();
  });

  test("editing any number invalidates the preview — a stale count is worse than none", async () => {
    const surface = await mount((request) =>
      request.url.endsWith("/quota-versions/preview") ? json(IMPACT) : json(DATA),
    );
    await surface.click(previewButton(surface));
    expect(publishButton(surface)?.hasAttribute("disabled")).toBe(false);

    await surface.type("#quota-monthly-pro", "15000");

    expect(publishButton(surface)?.hasAttribute("disabled")).toBe(true);
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.previewRequired"));
    expect(surface.text()).not.toContain(
      t("en", "admin.quotaVersions.previewCount", { count: 2, total: 12 }),
    );
    await surface.click(publishButton(surface));
    expect(
      surface.sent.filter(
        (request) => request.method === "POST" && request.url.endsWith("/quota-versions"),
      ),
    ).toEqual([]);
    await surface.close();
  });

  test("a failed preview shows the backend reason, never only the generic sentence", async () => {
    const reason = 'effectiveFrom "2026-11-26T00:00:00.000Z" is not a calendar date (YYYY-MM-DD)';
    const surface = await mount((request) =>
      request.url.endsWith("/quota-versions/preview") ? json({ error: reason }, 400) : json(DATA),
    );
    await surface.click(previewButton(surface));
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.previewLoadFailed", { detail: reason }));
    expect(publishButton(surface)?.hasAttribute("disabled")).toBe(true);
    await surface.close();
  });

  test("an unreachable preview says so instead of quoting a status", async () => {
    const surface = await mount((request) => {
      if (request.url.endsWith("/quota-versions/preview")) throw new TypeError("Failed to fetch");
      return json(DATA);
    });
    await surface.click(previewButton(surface));
    expect(surface.text()).toContain(t("en", "admin.quotaVersions.previewUnreachable"));
    expect(publishButton(surface)?.hasAttribute("disabled")).toBe(true);
    await surface.close();
  });
});
