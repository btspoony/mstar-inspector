/**
 * Save feedback rides the button; success notices expire on their own.
 *
 * Three layers, pinned where each contract lives:
 * 1. the Button status face (static SSR) — one leading glyph per state,
 *    aria-busy only while loading, data-status exposed for tests, markup
 *    byte-identical without status, the spinner folding under
 *    prefers-reduced-motion while the three states stay distinguishable;
 * 2. the useSaveSignal hook (mounted, fake timers) — success reverts to idle
 *    after ~2s, error sticks until the next submit, restart and unmount
 *    clear the clock;
 * 3. NoticeRegion's success expiry (mounted, fake timers) — ~3s, warn/error
 *    persist, replacement restarts the clock, unmount is safe — and the
 *    workspace-name card end to end: a saved name renders no role=status
 *    notice box, shows the check on the button, keeps the success copy as
 *    assistive text, and a refusal keeps the persistent role=alert notice
 *    with the button's error face.
 */
import { describe, expect, jest, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Window } from "happy-dom";
import { t } from "../../src/i18n";
import { Button } from "../../src/design-system/primitives/button";
import { useSaveSignal } from "../../src/spa/components/save-signal";
import { NoticeRegion, type OpNotice } from "../../src/spa/pages/PageNotice";
import { WorkspaceSettingsPage } from "../../src/spa/pages/WorkspaceSettingsPage";
import type { SpaBoot } from "../../src/spa/boot";
import { installDom } from "./dom";

// Rendered on main before the status face existed — the no-status markup
// must stay byte-identical.
const PLAIN_BUTTON_MARKUP =
  '<button data-slot="button" data-variant="default" data-size="default" class="inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-(--duration-base) ease-(--ease-in-out) outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover h-(--control-h-md) px-4 py-2 has-[&gt;svg]:px-3" type="submit">Save changes</button>';
const OUTLINE_BUTTON_MARKUP =
  '<button data-slot="button" data-variant="outline" data-size="sm" class="inline-flex shrink-0 items-center justify-center text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-(--duration-base) ease-(--ease-in-out) outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 border border-(--border-default) bg-background shadow-xs hover:border-(--border-strong) hover:bg-accent hover:text-accent-foreground active:border-(--border-strong) active:bg-accent active:text-accent-foreground h-(--control-h-sm) gap-1.5 rounded-sm px-3 has-[&gt;svg]:px-2.5 w-20">Discard</button>';

describe("Button status face", () => {
  test("loading renders one spinner glyph, aria-busy and data-status; the spinner folds under reduced motion", () => {
    const html = renderToStaticMarkup(createElement(Button, { status: "loading" }, "Save"));
    expect(html).toContain('data-status="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain("lucide-loader-circle");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("motion-reduce:animate-none");
  });

  test("success renders the check with aria-busy absent; error renders the alert", () => {
    const success = renderToStaticMarkup(createElement(Button, { status: "success" }, "Save"));
    expect(success).toContain('data-status="success"');
    expect(success).toContain("lucide-circle-check");
    expect(success).not.toContain("aria-busy");
    expect(success).not.toContain("animate-spin");
    const error = renderToStaticMarkup(createElement(Button, { status: "error" }, "Save"));
    expect(error).toContain('data-status="error"');
    expect(error).toContain("lucide-circle-alert");
    expect(error).not.toContain("aria-busy");
  });

  test("without status the markup is byte-identical to the pre-change face", () => {
    expect(renderToStaticMarkup(createElement(Button, { type: "submit" }, "Save changes"))).toBe(
      PLAIN_BUTTON_MARKUP,
    );
    expect(
      renderToStaticMarkup(
        createElement(Button, { variant: "outline", size: "sm", className: "w-20" }, "Discard"),
      ),
    ).toBe(OUTLINE_BUTTON_MARKUP);
  });
});

type SignalProbe = ReturnType<typeof useSaveSignal>;
let signalProbe: SignalProbe;

function SignalProbeComponent() {
  signalProbe = useSaveSignal();
  return null;
}

function RegionProbeComponent() {
  const [notice, setNotice] = useState<OpNotice | null>(null);
  regionPush = setNotice;
  return createElement(NoticeRegion, { notice });
}
let regionPush: (notice: OpNotice | null) => void = () => {};

function mount(win: Window) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  return { container, root };
}

describe("useSaveSignal", () => {
  test("success reverts to idle after ~2s; error sticks until the next submit", async () => {
    jest.useFakeTimers();
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    try {
      const { root } = mount(win);
      await act(async () => root.render(createElement(SignalProbeComponent)));
      expect(signalProbe.status).toBe("idle");

      await act(async () => {
        signalProbe.start();
      });
      expect(signalProbe.status).toBe("loading");

      await act(async () => {
        signalProbe.succeed();
      });
      expect(signalProbe.status).toBe("success");
      // Still confirming just before its own deadline…
      await act(async () => {
        jest.advanceTimersByTime(1999);
      });
      expect(signalProbe.status).toBe("success");
      // …and idle once it passes, so a stale confirmation never lingers.
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(signalProbe.status).toBe("idle");

      // An error is the sticky face: it survives any deadline until the next submit.
      await act(async () => {
        signalProbe.fail();
      });
      expect(signalProbe.status).toBe("error");
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(signalProbe.status).toBe("error");

      // A new submit restarts the clock: the pending revert is cancelled.
      await act(async () => {
        signalProbe.succeed();
      });
      await act(async () => {
        signalProbe.start();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(signalProbe.status).toBe("loading");

      await act(async () => root.unmount());
    } finally {
      jest.useRealTimers();
      cleanup();
    }
  });

  test("unmount cancels the pending revert timer", async () => {
    jest.useFakeTimers();
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    try {
      const { root } = mount(win);
      await act(async () => root.render(createElement(SignalProbeComponent)));
      await act(async () => {
        signalProbe.succeed();
      });
      const armed = jest.getTimerCount();
      await act(async () => root.unmount());
      // The teardown removed exactly one timer: the revert this success armed.
      expect(jest.getTimerCount()).toBe(armed - 1);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
    } finally {
      jest.useRealTimers();
      cleanup();
    }
  });
});

describe("NoticeRegion success expiry", () => {
  test("a success notice expires after ~3s without touching the parent; warn and error persist", async () => {
    jest.useFakeTimers();
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    try {
      const { container, root } = mount(win);
      await act(async () => root.render(createElement(RegionProbeComponent)));

      await act(async () => {
        regionPush({ kind: "success", message: "Saved." });
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved.");
      await act(async () => {
        jest.advanceTimersByTime(2999);
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved.");
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      // Hidden locally — the region renders nothing without the parent clearing.
      expect(container.querySelector('[role="status"]')).toBeNull();

      await act(async () => {
        regionPush({ kind: "warn", message: "Nothing to remove." });
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Nothing to remove.");

      await act(async () => {
        regionPush({ kind: "error", message: "Could not save." });
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save.");

      await act(async () => root.unmount());
    } finally {
      jest.useRealTimers();
      cleanup();
    }
  });

  test("replacing the notice restarts the clock; unmount clears the pending timer", async () => {
    jest.useFakeTimers();
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    try {
      const { container, root } = mount(win);
      await act(async () => root.render(createElement(RegionProbeComponent)));

      await act(async () => {
        regionPush({ kind: "success", message: "First." });
      });
      await act(async () => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        regionPush({ kind: "success", message: "Second." });
      });
      // The replacement restarted the clock: 2500ms in, the second notice stays.
      await act(async () => {
        jest.advanceTimersByTime(2500);
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Second.");
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(container.querySelector('[role="status"]')).toBeNull();

      await act(async () => {
        regionPush({ kind: "success", message: "Third." });
      });
      const armed = jest.getTimerCount();
      await act(async () => root.unmount());
      expect(jest.getTimerCount()).toBe(armed - 1);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
    } finally {
      jest.useRealTimers();
      cleanup();
    }
  });
});

const boot: SpaBoot = {
  locale: "en",
  login: "dana",
  name: "Dana",
  workspaceRef: "ws_acme",
  deploymentMode: "self-hosted",
  memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

function stubWorkspaceSettingsFetch(put: (body: string) => Response) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "PUT") return put(String(init?.body ?? ""));
    if (url.endsWith("/api/settings/concurrency")) {
      return new Response(JSON.stringify({ concurrency: 8, min: 1, max: 32, degraded: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/settings/check-min-score")) {
      return new Response(JSON.stringify({ min_score: 60, min: 3, max: 100, degraded: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ grants: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return realFetch;
}

async function submitName(win: Window, container: Element, value: string) {
  const input = win.document.querySelector("#workspace-name") as unknown as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
  await act(async () => {
    input
      .closest("form")
      ?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  const button = container.querySelector("form button[type=\"submit\"]") as unknown as HTMLButtonElement;
  return { input, button };
}

describe("workspace name card end to end", () => {
  test("a saved name shows the check, no notice box, and the copy as assistive text; the face reverts after ~2s", async () => {
    jest.useFakeTimers();
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    const realFetch = stubWorkspaceSettingsFetch(
      () =>
        new Response(JSON.stringify({ name: "Acme Labs" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      const { container, root } = mount(win);
      await act(async () => root.render(createElement(WorkspaceSettingsPage, { boot })));

      const { button } = await submitName(win, container as unknown as Element, "Acme Labs");
      expect(button.getAttribute("data-status")).toBe("success");
      expect(button.querySelector("svg.lucide-circle-check")).not.toBeNull();
      // The success never renders as a notice box on the op channel…
      expect(container.querySelector("p[role=\"status\"]")).toBeNull();
      // …the copy stays in the DOM as assistive text announced by a live region…
      expect(container.textContent).toContain(t("en", "workspace.nameSaved"));
      const live = container.querySelector("span[role=\"status\"]") as unknown as HTMLSpanElement;
      expect(live.className).toContain("sr-only");
      expect(live.textContent).toContain(t("en", "workspace.nameSaved"));

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(button.getAttribute("data-status")).toBeNull();
      expect(container.textContent).not.toContain(t("en", "workspace.nameSaved"));

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      jest.useRealTimers();
      cleanup();
    }
  });

  test("a refused save keeps the button's error face and the persistent role=alert notice", async () => {
    jest.useFakeTimers();
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    const realFetch = stubWorkspaceSettingsFetch(
      () =>
        new Response(JSON.stringify({ message: "name taken" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      const { container, root } = mount(win);
      await act(async () => root.render(createElement(WorkspaceSettingsPage, { boot })));

      const { button } = await submitName(win, container as unknown as Element, "Taken Name");
      expect(button.getAttribute("data-status")).toBe("error");
      expect(button.querySelector("svg.lucide-circle-alert")).not.toBeNull();
      const alerts = [...container.querySelectorAll("p[role=\"alert\"]")].map((node) =>
        node.textContent ?? "",
      );
      expect(alerts.some((text) => text.includes("name taken"))).toBe(true);

      // The failure does not self-clear: face and notice outlive any deadline.
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(button.getAttribute("data-status")).toBe("error");
      const later = [...container.querySelectorAll("p[role=\"alert\"]")].map(
        (node) => node.textContent ?? "",
      );
      expect(later.some((text) => text.includes("name taken"))).toBe(true);

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      jest.useRealTimers();
      cleanup();
    }
  });
});
