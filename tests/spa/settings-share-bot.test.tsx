import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { APP_ROUTES } from "../../src/dashboard/index";
import { BotPricingSection } from "../../src/spa/pages/BotSettingsPage";
import type { BotSettingsPayload } from "../../src/spa/pages/data";
import { installDom } from "./dom";

const locale = "en" as const;
const WORKSPACE_REF = "acme";

function registeredScopePath(appId: string): string {
  // The SPA posts the BOT share switch until apps-ia-split rewires it; this
  // helper pins the route registration the same way as before — by lookup,
  // not a hardcoded string — so a route-table drift fails loudly.
  const route = APP_ROUTES.find(
    (row) => row.method === "patch" && row.path === "/api/review-bots/:botId/scope",
  );
  if (route === undefined) throw new Error("no PATCH /api/review-bots/:botId/scope route is registered");
  return `/dashboard/${WORKSPACE_REF}${route.path.replace(":botId", appId)}`;
}

function payload(overrides: Partial<BotSettingsPayload> = {}): BotSettingsPayload {
  return {
    can_manage: true,
    official_workspace: true,
    archived: false,
    app: {
      github_app_id: 1,
      status: "active",
      last_webhook_at: null,
      scope: "owned",
      id: "1",
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
    model_role_ids: [],
    custom_provider_api_ids: ["openai-completions"],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    ...overrides,
  };
}

type Sent = { path: string; method: string; body: unknown };

async function mount(
  overrides: Partial<BotSettingsPayload> = {},
  status = 200,
  body = "{}",
  reloadOk = true,
  gate?: Promise<void>,
  reread?: Partial<BotSettingsPayload>,
) {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/repos");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const sent: Sent[] = [];
  const reloads: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      path: new URL(String(input), "http://localhost").pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // Lets a test hold a PATCH in flight and type into the page meanwhile.
    if ((init?.method ?? "GET") === "PATCH") await gate;
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  // `reread` is the payload a successful re-read would serve, so a landing can
  // replace the draft exactly as the real page does.
  function Harness() {
    const [current, setCurrent] = useState(payload(overrides));
    return createElement(BotPricingSection, {
      locale,
      payload: current,
      onReload: async () => {
        reloads.push(1);
        if (reloadOk && reread !== undefined) setCurrent(payload(reread));
        return reloadOk;
      },
    });
  }
  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {});
  } catch (err) {
    globalThis.fetch = originalFetch;
    throw err;
  }

  const buttonWith = (label: string, scope?: HTMLElement) => {
    const host = (scope ?? win.document) as unknown as HTMLElement;
    const buttons = host.querySelectorAll("button") as unknown as HTMLButtonElement[];
    return [...buttons].find((button) => button.textContent === label) ?? null;
  };
  const dialog = () => win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
      );
    });
  };

  return {
    win,
    container,
    sent,
    reloads,
    buttonWith,
    dialog,
    click,
    scopeCalls: () => sent.filter((row) => row.path.endsWith("/scope")),
    cleanup: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      cleanup();
    },
  };
}

type FixtureWindow = ReturnType<typeof installDom>["win"];

/** Set a controlled input's value inside `act`, so React flushes the change. */
async function typeInto(win: FixtureWindow, input: Element | null, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
}

describe("the bot page's share switch", () => {
  test("sharing confirms first, then PATCHes the shared scope and reloads", async () => {
    const view = await mount();
    try {
      expect(view.container.textContent).toContain(t(locale, "botDetail.share.title"));
      await view.click(view.buttonWith(t(locale, "botSettings.shareAction")));
      expect(view.scopeCalls()).toEqual([]);
      expect(view.dialog()?.textContent).toContain(t(locale, "botSettings.confirmShareBody"));

      await view.click(view.buttonWith(t(locale, "botSettings.shareAction"), view.dialog() ?? undefined));

      expect(view.scopeCalls()).toEqual([
        { path: registeredScopePath("1"), method: "PATCH", body: { scope: "shared" } },
      ]);
      expect(view.reloads).toHaveLength(1);
      expect(view.container.textContent).toContain(t(locale, "botSettings.shareSaved"));
    } finally {
      await view.cleanup();
    }
  });

  test("a revoke carries the confirmation the store requires", async () => {
    const view = await mount({ app: { ...payload().app, scope: "shared" } });
    try {
      await view.click(view.buttonWith(t(locale, "botSettings.unshareAction")));
      expect(view.scopeCalls()).toEqual([]);
      expect(view.dialog()?.textContent).toContain(t(locale, "botSettings.confirmUnshareBody"));

      await view.click(view.buttonWith(t(locale, "botSettings.unshareAction"), view.dialog() ?? undefined));

      expect(view.scopeCalls()).toEqual([
        { path: registeredScopePath("1"), method: "PATCH", body: { scope: "owned", confirm: true } },
      ]);
      expect(view.reloads).toHaveLength(1);
    } finally {
      await view.cleanup();
    }
  });

  test("a non-official workspace renders no share concept at all", async () => {
    const view = await mount({ official_workspace: false });
    try {
      const rendered = String(view.container.textContent);
      // The share switch is absent for a non-official workspace; the pricing
      // controls themselves stay preconfigurable.
      expect(rendered.includes(t(locale, "botDetail.share.switch"))).toBe(false);
      for (const key of [
        "botSettings.shareAction",
        "botSettings.unshareAction",
      ] as const) {
        expect(view.buttonWith(t(locale, key))).toBeNull();
      }
    } finally {
      await view.cleanup();
    }
  });

  test("a plain member renders no share concept either", async () => {
    const view = await mount({ can_manage: false });
    try {
      const rendered = String(view.container.textContent);
      // The read-only consumer face never renders this section at all; mounted
      // directly, the member answer keeps every share concept absent.
      expect(rendered.includes(t(locale, "botDetail.share.switch"))).toBe(false);
      expect(view.buttonWith(t(locale, "botSettings.shareAction"))).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a stale share refusal names its cause and never claims a save", async () => {
    const view = await mount({}, 409, JSON.stringify({ error: "bot is outside the official workspace" }));
    try {
      await view.click(view.buttonWith(t(locale, "botSettings.shareAction")));
      await view.click(view.buttonWith(t(locale, "botSettings.shareAction"), view.dialog() ?? undefined));

      expect(view.reloads).toEqual([]);
      expect(view.container.textContent).toContain(t(locale, "botSettings.shareOutsideOfficial"));
      expect(view.container.textContent).not.toContain(t(locale, "botSettings.shareSaved"));
    } finally {
      await view.cleanup();
    }
  });

  test("an unshared save sends the ceiling alone — the inert multiplier is omitted", async () => {
    const view = await mount();
    try {
      const capInput = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, capInput, "12");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { monthly_rp: 12000 } }]);
    } finally {
      await view.cleanup();
    }
  });

  test("the ceiling input uses the read faces' two-decimal quantum, integral values included", async () => {
    // 1,234 RP at the default rate renders 1.23 in the editor exactly as it
    // does in `1.23 Credits` on the read faces — never the raw 1.234.
    const fractional = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", monthly_rp: 1234 },
    });
    try {
      const capInput = fractional.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      expect(capInput?.value).toBe("1.23");
    } finally {
      await fractional.cleanup();
    }
    // An integral Credit ceiling keeps its decimals: 12,000 RP reads 12.00.
    const integral = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", monthly_rp: 12000 },
    });
    try {
      const capInput = integral.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      expect(capInput?.value).toBe("12.00");
    } finally {
      await integral.cleanup();
    }
  });

  test("the ceiling converts at the served rate, not a guessed 1,000", async () => {
    const view = await mount({ rp_per_credit: 500 });
    try {
      const capInput = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, capInput, "3");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing.at(0)?.body).toEqual({ monthly_rp: 1500 });
    } finally {
      await view.cleanup();
    }
  });

  test("a multiplier-only save omits the untouched ceiling, so a concurrent edit survives", async () => {
    // 1,234 RP renders as `1.23`; sending anything back would rewrite it as
    // 1,230 — and sending the page's stored 1,234 would OVERWRITE a ceiling
    // another admin raised to 2,000 after this page loaded. Omission is the
    // route's "leave the column alone".
    const view = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", multiplier: 2, monthly_rp: 1234 },
    });
    try {
      const multiplier = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.multiplier")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, multiplier, "5");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { multiplier: 5 } }]);
    } finally {
      await view.cleanup();
    }
  });

  test("a ceiling below the display quantum is not zeroed by an unrelated save", async () => {
    // 4 RP is 0.004 Credits — the field reads `0.00`, which the input parser
    // would refuse as non-positive. An untouched field must not be re-read.
    const view = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", multiplier: 2, monthly_rp: 4 },
    });
    try {
      const capInput = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      expect(capInput?.value).toBe("0.00");
      const multiplier = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.multiplier")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, multiplier, "3");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { multiplier: 3 } }]);
      expect(String(view.container.textContent)).not.toContain(t(locale, "bots.overrideInvalid"));
    } finally {
      await view.cleanup();
    }
  });

  test("a failed re-read after a committed save refuses the next write instead of replaying the old value", async () => {
    // The ceiling save landed, the re-read did not. The committed value is no
    // longer a pending edit, and the page cannot show what the store now holds
    // — so it must not send a second PATCH built on values it cannot confirm.
    const view = await mount(
      { rp_per_credit: 1000, app: { ...payload().app, scope: "shared", multiplier: 2, monthly_rp: 1234 } },
      200,
      "{}",
      false,
    );
    try {
      const capInput = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, capInput, "20");
      await view.click(view.buttonWith(t(locale, "common.save")));

      let pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { monthly_rp: 20000 } }]);
      expect(view.reloads).toHaveLength(1);
      expect(String(view.container.textContent)).toContain(t(locale, "bots.staleAfterSave"));

      // Editing only the multiplier now must not resurrect the ceiling: the
      // save is refused outright and nothing is sent.
      const multiplier = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.multiplier")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, multiplier, "5");
      const save = view.buttonWith(t(locale, "common.save")) as unknown as HTMLButtonElement | null;
      expect(save?.disabled).toBe(true);
      await view.click(save);

      pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toHaveLength(1);
      expect(pricing[0]?.body).not.toHaveProperty("multiplier");
    } finally {
      await view.cleanup();
    }
  });

  test("a ceiling-only save omits the untouched multiplier, so a concurrent edit survives", async () => {
    // The mirror of the case above: sending the page's stored 2 would restore it
    // over a 5 another admin set after this page loaded. The route's "leave the
    // column alone" is the omission.
    const view = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", multiplier: 2, monthly_rp: 1234 },
    });
    try {
      const capInput = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, capInput, "20");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { monthly_rp: 20000 } }]);
    } finally {
      await view.cleanup();
    }
  });

  test("a legacy below-floor multiplier does not block a ceiling-only save", async () => {
    // A row priced before the 0.01 write floor still renders and still serves.
    // It must not refuse a save that never carries it: an untouched multiplier
    // is omitted, so the client never re-validates a stored value it is not
    // writing.
    const view = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", multiplier: 0.001, monthly_rp: 1234 },
    });
    try {
      const capInput = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.monthlyCap")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, capInput, "20");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { monthly_rp: 20000 } }]);
      expect(String(view.container.textContent)).not.toContain(t(locale, "botDetail.share.multiplierInvalid"));
    } finally {
      await view.cleanup();
    }
  });

  test("neither field edited means no request at all", async () => {
    const view = await mount({
      rp_per_credit: 1000,
      app: { ...payload().app, scope: "shared", multiplier: 2, monthly_rp: 1234 },
    });
    try {
      await view.click(view.buttonWith(t(locale, "common.save")));

      expect(view.sent.filter((row) => row.path.endsWith("/pricing"))).toEqual([]);
      expect(String(view.container.textContent)).toContain(t(locale, "botSettings.nothingToSave"));
    } finally {
      await view.cleanup();
    }
  });

  test("a field typed into while the save is in flight stays pending, and the next save sends it", async () => {
    // The PATCH carries ×5 and the operator retypes ×7 before it lands. The
    // landing confirms ×5 only: ×7 stays on screen — the re-read serves the
    // committed ×5 and must not overwrite it — and goes out on the next save.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mount(
      { rp_per_credit: 1000, app: { ...payload().app, scope: "shared", multiplier: 2, monthly_rp: 1234 } },
      200,
      "{}",
      true,
      gate,
      // What the committed write left stored, served by the re-read.
      { rp_per_credit: 1000, app: { ...payload().app, scope: "shared", multiplier: 5, monthly_rp: 1234 } },
    );
    try {
      const multiplier = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.multiplier")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, multiplier, "5");
      // Dispatch the click without awaiting the handler: its PATCH is gated.
      await act(async () => {
        view
          .buttonWith(t(locale, "common.save"))
          ?.dispatchEvent(
            new view.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
          );
      });
      let pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([{ path: expect.any(String), method: "PATCH", body: { multiplier: 5 } }]);

      await typeInto(view.win, multiplier, "7");
      release();
      await act(async () => {});
      expect(view.reloads).toHaveLength(1);
      expect(String(view.container.textContent)).toContain(t(locale, "settings.changesSaved"));
      // The newer draft survived the landing and is still the field's text.
      expect(multiplier.value).toBe("7");

      await view.click(view.buttonWith(t(locale, "common.save")));
      pricing = view.sent.filter((row) => row.path.endsWith("/pricing"));
      expect(pricing).toEqual([
        { path: expect.any(String), method: "PATCH", body: { multiplier: 5 } },
        { path: expect.any(String), method: "PATCH", body: { multiplier: 7 } },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a bad multiplier names the multiplier, not the ceiling integer", async () => {
    const view = await mount({ app: { ...payload().app, scope: "shared", multiplier: 2 } });
    try {
      const input = view.container.querySelector(
        `input[aria-label="${t(locale, "botDetail.share.multiplier")}"]`,
      ) as unknown as HTMLInputElement;
      await typeInto(view.win, input, "0");
      await view.click(view.buttonWith(t(locale, "common.save")));

      const rendered = String(view.container.textContent);
      const invalid = t(locale, "botDetail.share.multiplierInvalid");
      expect(rendered).toContain(invalid);
      // The refusal must name the enforced floor rather than the old "greater than 0" wording.
      expect(invalid).toContain("0.01");
      expect(invalid).not.toContain("greater than 0");
      expect(rendered).not.toContain(t(locale, "bots.overrideInvalid"));
    } finally {
      await view.cleanup();
    }
  });
});
