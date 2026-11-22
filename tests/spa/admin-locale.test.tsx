import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/spa/admin/main";
import type { SpaBoot } from "../../src/spa/boot";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

type Mounted = {
  container: HTMLElement;
  cleanup: () => void;
};

async function mountApp(boot: SpaBoot): Promise<Mounted> {
  const { win, cleanup } = installDom("http://localhost/_internal_admin/flags");
  const bootHost = globalThis as { window?: { __BOOT__?: SpaBoot } };
  bootHost.window!.__BOOT__ = boot;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify({ flags: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(App)));
  await act(async () => {});
  return {
    container: container as unknown as HTMLElement,
    cleanup: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

function switchForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form[action="/dashboard/locale"]');
  if (!(form instanceof HTMLFormElement)) throw new Error("locale switch form missing");
  return form;
}

function localeInput(form: HTMLFormElement): HTMLInputElement {
  const input = form.querySelector('input[name="locale"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("locale input missing");
  return input;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("admin App locale plumbing", () => {
  test("a zh_CN boot renders the shell in Chinese", async () => {
    const { container, cleanup } = await mountApp({ locale: "zh_CN", login: "op", name: null });
    const text = container.textContent ?? "";
    expect(text).toContain("平台运营");
    expect(text).toContain("服务器开关");
    expect(text).toContain("工作区");
    expect(text).toContain("用户");
    expect(text).toContain("支持访问");
    const form = switchForm(container);
    expect(form.method).toBe("post");
    expect(localeInput(form).value).toBe("en");
    expect(form.querySelector("button")?.textContent).toBe("EN");
    await cleanup();
  });

  test("an en boot renders the shell in English", async () => {
    const { container, cleanup } = await mountApp({ locale: "en", login: "op", name: null });
    const text = container.textContent ?? "";
    expect(text).toContain("Platform operations");
    expect(text).toContain("Server flags");
    expect(text).toContain("Support access");
    const form = switchForm(container);
    expect(localeInput(form).value).toBe("zh_CN");
    expect(form.querySelector("button")?.textContent).toBe("中文");
    await cleanup();
  });
});
