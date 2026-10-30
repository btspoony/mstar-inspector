/**
 * The three provider dialogs (plan 103 task 4): the two-step Add provider flow,
 * the add-key flow of an existing group, and the custom declaration.
 *
 * Mounted, because the panels live in Radix portals and the flows are stateful:
 * a rejected submit must stay open with every typed value (AC-6/7/8), a
 * successful one is the only thing that dismisses the flow (AC-9), and one
 * submit sends one request (AC-19 / I-000207). The picker's grouping and the
 * `unavailable` entry's absent submit path are observed on the rendered dialog,
 * not on the module's source.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import type { CatalogProvider, SettingsManagePayload } from "../../src/spa/pages/data";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { AddKeyDialog, AddProviderDialog, CustomProviderDialog } from "../../src/spa/pages/providers-dialogs";
import { installDom } from "./dom";

const catalogEntry = (id: string, overrides: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id,
  label: `${id} label`,
  tier: "builtin",
  base_url: null,
  api: null,
  models: [],
  verifiable: true,
  eligibility: "builtin",
  display_group: "catalog",
  ...overrides,
});

const CATALOG: CatalogProvider[] = [
  catalogEntry("anthropic", { label: "Anthropic", display_group: "common" }),
  // AC-16: a builtin that takes a key only — the console dead end is gone.
  catalogEntry("zai", { label: "Z.AI", display_group: "common" }),
  // AC-18: the SHIPPED console-only builtins, verbatim from the settings
  // payload — builtin tier, not verifiable, and carrying the declaration
  // prefill (protocol + URL shape) the generator emits for them.
  catalogEntry("azure-openai", {
    label: "Azure OpenAI",
    verifiable: false,
    base_url: "https://{resource}.openai.azure.com/openai/deployments/{deployment}",
    api: "openai-completions",
  }),
  catalogEntry("ai-gateway", {
    label: "AI Gateway",
    verifiable: false,
    base_url: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}",
    api: "openai-completions",
  }),
  catalogEntry("workers-ai", {
    label: "Cloudflare Workers AI",
    tier: "template",
    eligibility: "template",
    base_url: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    api: "openai-completions",
  }),
  catalogEntry("mistral", { label: "Mistral", eligibility: "unavailable" }),
];

function managePayload(overrides: Partial<SettingsManagePayload> = {}): SettingsManagePayload {
  return {
    can_manage: true,
    workspace_id: "ws_test",
    app: {
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      id: "app-test",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
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
    provider_catalog: CATALOG,
    model_role_ids: [],
    custom_provider_api_ids: ["openai-completions"],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    deliveries: [],
    ...overrides,
  };
}

/** A promise the test settles by hand, so an in-flight submit is observable. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, settle: resolve };
}

/**
 * The dialog's open state lives with its caller (the providers card), so the
 * harness is the minimal controlled parent — a dialog that closes itself would
 * never be observed through a fixed `open` prop.
 */
function Opener({
  factory,
}: {
  factory: (open: boolean, onOpenChange: (open: boolean) => void) => ReactElement;
}) {
  const [open, setOpen] = useState(true);
  return factory(open, setOpen);
}

/** Mount a controlled dialog and hand back the queries the cases drive it with. */
async function mount(factory: (open: boolean, onOpenChange: (open: boolean) => void) => ReactElement) {
  const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(Opener, { factory })));
  await act(async () => {});

  const dialog = (): HTMLElement | null =>
    win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const submitButton = (): HTMLButtonElement | null =>
    (dialog()?.querySelector('button[type="submit"]') as unknown as HTMLButtonElement | null) ?? null;

  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
      );
    });
  };

  const type = async (target: Element | null, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(target, value);
      target?.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
  };

  /** Submit the dialog's form — twice in one flush when `times` is 2. */
  const submit = async (times = 1) => {
    const form = dialog()?.querySelector("form");
    await act(async () => {
      for (let index = 0; index < times; index += 1) {
        form?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      }
    });
  };

  /** Open the catalog picker and click the entry whose row names `label`. */
  const pick = async (label: string) => {
    await click(dialog()?.querySelector('[role="combobox"]') ?? null);
    const row = [...win.document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes(label),
    );
    if (row === undefined) throw new Error(`no picker row for ${label}`);
    await click(row as unknown as Element);
  };

  return {
    win,
    dialog,
    submitButton,
    click,
    type,
    submit,
    pick,
    options: () => [...win.document.querySelectorAll('[role="option"]')] as unknown as Element[],
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanupDom();
    },
  };
}

const locale: SpaBoot["locale"] = "en";
const notice = (kind: OpNotice["kind"], message: string): OpNotice => ({ kind, message });

function addProvider(overrides: {
  onVerify?: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings?: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome?: (outcome: OpNotice) => void;
  customApiIds?: string[];
}) {
  return (open: boolean, onOpenChange: (open: boolean) => void) =>
    createElement(AddProviderDialog, {
      locale,
      open,
      onOpenChange,
      payload: managePayload(
        overrides.customApiIds === undefined
          ? {}
          : { custom_provider_api_ids: overrides.customApiIds },
      ),
      onVerify: overrides.onVerify ?? (async () => notice("success", "added")),
      onSettings: overrides.onSettings ?? (async () => notice("success", "added")),
      onOutcome: overrides.onOutcome ?? (() => {}),
    });
}

describe("AddProviderDialog — step 1 picks from the grouped catalog", () => {
  test("the picker lists both groups and every entry, unavailable included", async () => {
    const view = await mount(addProvider({}));
    try {
      await view.click(view.dialog()?.querySelector('[role="combobox"]') ?? null);
      const panel = view.dialog()?.textContent ?? "";
      expect(panel).toContain(t(locale, "settings.catalogBuiltin"));
      expect(panel).toContain(t(locale, "settings.catalogTemplate"));
      const rows = view.options().map((option) => option.textContent ?? "");
      expect(rows.some((row) => row.includes("Anthropic"))).toBe(true);
      expect(rows.some((row) => row.includes("Azure OpenAI"))).toBe(true);
      // The unavailable entry stays listed, marked, and selectable — its
      // suffix is the marker, not a disabled row.
      const unavailable = view.options().find((option) => option.textContent?.includes("Mistral"));
      expect(unavailable?.textContent).toContain("unavailable under omp");
      expect(unavailable?.getAttribute("aria-disabled")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("an unavailable entry reaches its reason with no submit path at all", async () => {
    const view = await mount(addProvider({}));
    try {
      await view.pick("Mistral");
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.eligibilityUnavailable", { image: "omp" }),
      );
      expect(view.dialog()?.querySelector("form")).toBeNull();
      expect(view.submitButton()).toBeNull();
      // The step indicator moved to the configuration step.
      const current = view.win.document.querySelector('[data-slot="step-dialog-step"][aria-current="step"]');
      expect(current?.textContent).toBe(t(locale, "settings.providers.stepConfigure"));
    } finally {
      await view.cleanup();
    }
  });

  test("the secondary custom entry hands over to the declaration dialog (AC-5)", async () => {
    const view = await mount(addProvider({}));
    try {
      const entry = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t(locale, "settings.customEntry"),
      );
      expect(entry, "custom entry").toBeDefined();
      await view.click(entry ?? null);
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.addCustomProvider"));
      expect(view.dialog()?.querySelector('input')).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("every aria-controls the flow renders names a mounted region (I-000208)", async () => {
    const view = await mount(addProvider({}));
    try {
      await view.pick("Anthropic");
      for (const control of view.dialog()?.querySelectorAll("[aria-controls]") ?? []) {
        const id = control.getAttribute("aria-controls") ?? "";
        expect(id.length).toBeGreaterThan(0);
        expect(view.win.document.getElementById(id), id).not.toBeNull();
      }
    } finally {
      await view.cleanup();
    }
  });
});

describe("AddProviderDialog — the console-only builtins expose an endpoint path (AC-18)", () => {
  // The SHIPPED rows: builtin tier, verifiable false. Their own id is reserved
  // by the store, so the endpoint lives on a declaration with a user id.
  const CONSOLE_ROWS = [
    ["azure-openai", "Azure OpenAI", "https://{resource}.openai.azure.com/openai/deployments/{deployment}"],
    ["ai-gateway", "AI Gateway", "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}"],
  ] as const;

  test("a console-only builtin offers the custom-endpoint action instead of a dead end", async () => {
    for (const [id, label] of CONSOLE_ROWS) {
      const view = await mount(addProvider({}));
      try {
        await view.pick(label);
        // The row itself stays console-only: no endpoint input, no submit.
        expect(view.submitButton(), id).toBeNull();
        expect(view.dialog()?.querySelector("input"), id).toBeNull();
        expect(view.dialog()?.textContent).toContain(t(locale, "settings.consoleOnly"));
        // The way out is an explicit action — copy alone was the finding.
        const action = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent === t(locale, "settings.providers.customEndpoint"),
        );
        expect(action, `${id} custom-endpoint action`).toBeDefined();
        // The copy explains the reservation rather than claiming the console
        // is the only path.
        expect(view.dialog()?.textContent).toContain(
          t(locale, "settings.providers.customEndpointCopy", { provider: label }),
        );
      } finally {
        await view.cleanup();
      }
    }
  });

  test("the action opens the declaration form prefilled with the entry's protocol and URL shape", async () => {
    for (const [id, label, shape] of CONSOLE_ROWS) {
      const calls: Array<Record<string, string>> = [];
      // The seeded default protocol differs from the entry's own, so a
      // dropped prefill cannot pass by landing on the first option.
      const view = await mount(
        addProvider({
          customApiIds: ["anthropic-messages", "openai-completions"],
          onSettings: async (fields) => {
            calls.push(fields);
            return notice("error", "kept open");
          },
        }),
      );
      try {
        await view.pick(label);
        const action = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent === t(locale, "settings.providers.customEndpoint"),
        );
        await view.click(action ?? null);
        expect(view.dialog()?.textContent, id).toContain(t(locale, "settings.addCustomProvider"));

        const fields = view.dialog()?.querySelectorAll('input:not([type="password"])');
        const idField = fields?.item(0) as HTMLInputElement | undefined;
        // The id is the user's and clearly required — never the built-in one.
        expect(idField?.value, id).toBe("");
        expect(idField?.required, id).toBe(true);
        expect(view.dialog()?.textContent).toContain(
          t(locale, "settings.providers.customIdRequired", { provider: label }),
        );

        await view.type(idField ?? null, `${id}-direct`);
        await view.submit();
        expect(calls, id).toHaveLength(1);
        expect(calls[0], id).toMatchObject({
          op: "add-custom-provider",
          provider_id: `${id}-direct`,
          base_url: shape,
          api: "openai-completions",
        });
      } finally {
        await view.cleanup();
      }
    }
  });

  test("a template entry keeps the endpoint field, prefilled from the catalog", async () => {
    const view = await mount(addProvider({}));
    try {
      await view.pick("Cloudflare Workers AI");
      const endpoint = view.dialog()?.querySelector("input");
      expect(endpoint?.getAttribute("value")).toBe(
        "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
      );
      expect(view.submitButton()).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("zai asks for a key and offers a submit — never a console dead end (AC-16)", async () => {
    const view = await mount(addProvider({}));
    try {
      await view.pick("Z.AI");
      expect(view.dialog()?.querySelector('input[type="password"]')).not.toBeNull();
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.apiKey"));
      expect(view.submitButton()?.textContent).toBe(t(locale, "settings.addKey"));
      expect(view.dialog()?.textContent).not.toContain(t(locale, "settings.consoleOnly"));
    } finally {
      await view.cleanup();
    }
  });
});

describe("AddProviderDialog — submit contract (AC-6, AC-19)", () => {
  test("a second submit in flight sends one request, disables the trigger and swaps its copy", async () => {
    const pending = deferred<OpNotice>();
    const calls: Array<Record<string, string>> = [];
    const view = await mount(
      addProvider({
        onVerify: async (fields) => {
          calls.push(fields);
          return pending.promise;
        },
      }),
    );
    try {
      await view.pick("Anthropic");
      await view.type(view.dialog()?.querySelector('input[type="password"]') ?? null, "sk-live-key");
      await view.submit(2);
      expect(calls).toHaveLength(1);
      const button = view.submitButton();
      expect(button?.disabled).toBe(true);
      expect(button?.textContent).toBe(t(locale, "settings.providers.verifying"));
      await act(async () => {
        pending.settle(notice("success", "Key verified — stored."));
      });
      await act(async () => {});
      expect(view.dialog()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a rejected submit keeps the dialog open with the key and shows the reason (AC-6)", async () => {
    const view = await mount(addProvider({ onVerify: async () => notice("error", "That key was rejected.") }));
    try {
      await view.pick("Anthropic");
      await view.type(view.dialog()?.querySelector('input[type="password"]') ?? null, "sk-bad-key");
      await view.submit();
      expect(view.dialog()).not.toBeNull();
      expect(view.dialog()?.textContent).toContain("That key was rejected.");
      const field = view.dialog()?.querySelector('input[type="password"]') as HTMLInputElement | null;
      expect(field?.value).toBe("sk-bad-key");
      expect(view.submitButton()?.disabled).toBe(false);
    } finally {
      await view.cleanup();
    }
  });
});

describe("AddKeyDialog (AC-7, AC-19)", () => {
  const addKey = (
    keyCount: number,
    onVerify: (fields: Record<string, string>) => Promise<OpNotice>,
    onOutcome: (outcome: OpNotice) => void = () => {},
  ) =>
    (open: boolean, onOpenChange: (open: boolean) => void) =>
      createElement(AddKeyDialog, {
        locale,
        open,
        onOpenChange,
        provider: "anthropic",
        label: "Anthropic",
        keyCount,
        onVerify,
        onOutcome,
      });

  test("at the 8-key ceiling the submit is unavailable and the limit is stated (AC-7)", async () => {
    const view = await mount(addKey(8, async () => notice("success", "added")));
    try {
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.keyLimitReached", { limit: 8 }));
      expect(view.submitButton()?.disabled).toBe(true);
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.keyUsage", { count: 8, limit: 8 }));
    } finally {
      await view.cleanup();
    }
  });

  test("below the ceiling the submit is available and names the pool usage", async () => {
    const view = await mount(addKey(3, async () => notice("success", "added")));
    try {
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.keyUsage", { count: 3, limit: 8 }));
      expect(view.submitButton()?.disabled).toBe(false);
      expect(view.dialog()?.textContent).not.toContain(t(locale, "settings.providers.keyLimitReached", { limit: 8 }));
    } finally {
      await view.cleanup();
    }
  });

  test("a rejected submit keeps the dialog open with the typed key", async () => {
    const view = await mount(addKey(1, async () => notice("error", "The provider could not be reached.")));
    try {
      await view.type(view.dialog()?.querySelector('input[type="password"]') ?? null, "sk-second-key");
      await view.submit();
      expect(view.dialog()).not.toBeNull();
      expect(view.dialog()?.textContent).toContain("The provider could not be reached.");
      const field = view.dialog()?.querySelector('input[type="password"]') as HTMLInputElement | null;
      expect(field?.value).toBe("sk-second-key");
    } finally {
      await view.cleanup();
    }
  });

  test("a rejecting submit prop lands in the inline region (qc3 S-2)", async () => {
    const view = await mount(
      addKey(1, () => {
        throw new Error("transport exploded");
      }),
    );
    try {
      await view.type(view.dialog()?.querySelector('input[type="password"]') ?? null, "sk-fourth-key");
      await view.submit();
      expect(view.dialog()).not.toBeNull();
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.submitFailed"));
      expect(view.submitButton()?.disabled).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  test("a second submit in flight sends one request and closes on success", async () => {
    const pending = deferred<OpNotice>();
    const calls: Array<Record<string, string>> = [];
    const view = await mount(
      addKey(2, async (fields) => {
        calls.push(fields);
        return pending.promise;
      }),
    );
    try {
      await view.type(view.dialog()?.querySelector('input[type="password"]') ?? null, "sk-third-key");
      await view.submit(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ provider: "anthropic", key: "sk-third-key" });
      expect(view.submitButton()?.disabled).toBe(true);
      expect(view.submitButton()?.textContent).toBe(t(locale, "settings.providers.verifying"));
      await act(async () => {
        pending.settle(notice("success", "added"));
      });
      await act(async () => {});
      expect(view.dialog()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});

describe("CustomProviderDialog (AC-8, AC-19)", () => {
  const custom = (
    onSettings: (fields: Record<string, string>) => Promise<OpNotice>,
    onOutcome: (outcome: OpNotice) => void = () => {},
  ) =>
    (open: boolean, onOpenChange: (open: boolean) => void) =>
      createElement(CustomProviderDialog, {
        locale,
        open,
        onOpenChange,
        payload: managePayload(),
        onSettings,
        onOutcome,
      });

  /** The declaration's four typed fields, in render order (the API is a Select). */
  const textFields = (element: HTMLElement | null): NodeListOf<Element> | undefined =>
    element === null ? undefined : element.querySelectorAll('input:not([type="password"])');

  test("a rejected submit keeps every filled field (AC-8)", async () => {
    const view = await mount(custom(async () => notice("error", "The provider id is already taken.")));
    try {
      const fields = textFields(view.dialog());
      await view.type(fields?.item(0) ?? null, "my-gateway");
      await view.type(fields?.item(1) ?? null, "https://gw.test/v1");
      await view.type(fields?.item(2) ?? null, "m1, m2");
      await view.type(view.dialog()?.querySelector('input[type="password"]') ?? null, "sk-gw");
      await view.submit();
      expect(view.dialog()).not.toBeNull();
      expect(view.dialog()?.textContent).toContain("The provider id is already taken.");
      const after = textFields(view.dialog());
      expect((after?.item(0) as HTMLInputElement).value).toBe("my-gateway");
      expect((after?.item(1) as HTMLInputElement).value).toBe("https://gw.test/v1");
      expect((after?.item(2) as HTMLInputElement).value).toBe("m1, m2");
      const key = view.dialog()?.querySelector('input[type="password"]') as HTMLInputElement | null;
      expect(key?.value).toBe("sk-gw");
    } finally {
      await view.cleanup();
    }
  });

  test("a second submit in flight sends one custom request and closes on success", async () => {
    const pending = deferred<OpNotice>();
    const calls: Array<Record<string, string>> = [];
    const view = await mount(
      custom(async (fields) => {
        calls.push(fields);
        return pending.promise;
      }),
    );
    try {
      await view.type(textFields(view.dialog())?.item(0) ?? null, "my-gateway");
      await view.type(textFields(view.dialog())?.item(1) ?? null, "https://gw.test/v1");
      await view.submit(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ op: "add-custom-provider", provider_id: "my-gateway" });
      expect(view.submitButton()?.disabled).toBe(true);
      expect(view.submitButton()?.textContent).toBe(t(locale, "settings.providers.saving"));
      await act(async () => {
        pending.settle(notice("success", "declared"));
      });
      await act(async () => {});
      expect(view.dialog()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
