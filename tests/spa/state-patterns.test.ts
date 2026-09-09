/**
 * Plan 57 T4: state-pattern trio (AD-582) — PageSkeleton / EmptyState /
 * ErrorState under `src/spa/components/state/`. Components are pinned
 * behaviorally through react-dom/server SSR (the plan-53 settings-layout
 * idiom, no DOM runner in this stack): role faces, per-kind skeleton
 * shapes and per-kind row defaults, the EmptyState slot composition, the
 * ErrorState default message + retry wiring, i18n key faces in both
 * locales, the PageNotice channel boundary, and the no-raw-hex discipline.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageSkeleton, type SkeletonKind } from "../../src/spa/components/state/PageSkeleton";
import { EmptyState } from "../../src/spa/components/state/EmptyState";
import { ErrorState } from "../../src/spa/components/state/ErrorState";
import { t } from "../../src/i18n";

const spaRoot = join(import.meta.dir, "../../src/spa");

const count = (markup: string, marker: string) => markup.split(marker).length - 1;

const renderSkeleton = (kind: SkeletonKind, overrides: { locale?: "en" | "zh_CN"; rows?: number } = {}) =>
  renderToStaticMarkup(
    createElement(PageSkeleton, {
      locale: overrides.locale ?? "en",
      kind,
      ...(overrides.rows === undefined ? {} : { rows: overrides.rows }),
    }),
  );

const emptyState = (props: {
  icon?: boolean;
  title?: string;
  description?: string;
  action?: boolean;
}) =>
  renderToStaticMarkup(
    createElement(EmptyState, {
      ...(props.icon ? { icon: createElement("svg", { "data-testid": "chosen-icon" }) } : {}),
      title: props.title ?? "No Apps yet",
      ...(props.description === undefined ? {} : { description: props.description }),
      ...(props.action ? { action: createElement("button", null, "Create GitHub App") } : {}),
    }),
  );

const errorState = (overrides: { locale?: "en" | "zh_CN"; message?: string; onRetry?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(ErrorState, {
      locale: overrides.locale ?? "en",
      ...(overrides.message === undefined ? {} : { message: overrides.message }),
      ...(overrides.onRetry ? { onRetry: () => {} } : {}),
    }),
  );

describe("state trio placement + channel boundary (plan 57 T4 / AD-582)", () => {
  test("the trio lives under src/spa/components/state/ as three files", () => {
    for (const file of ["PageSkeleton.tsx", "EmptyState.tsx", "ErrorState.tsx"]) {
      const source = readFileSync(join(spaRoot, "components/state", file), "utf8");
      expect(source.length > 0, file).toBe(true);
    }
  });

  test("the trio does not touch the PageNotice channel (plan 38/44 untouched)", () => {
    const pageNotice = readFileSync(join(spaRoot, "pages/PageNotice.tsx"), "utf8");
    expect(pageNotice).not.toContain('from "../components/state');
    for (const file of ["PageSkeleton.tsx", "EmptyState.tsx", "ErrorState.tsx"]) {
      expect(readFileSync(join(spaRoot, "components/state", file), "utf8")).not.toContain(
        'from "../../pages/PageNotice"',
      );
    }
  });

  test("no raw hex in the trio (token discipline — semantic utilities only)", () => {
    for (const file of ["PageSkeleton.tsx", "EmptyState.tsx", "ErrorState.tsx"]) {
      const source = readFileSync(join(spaRoot, "components/state", file), "utf8");
      expect(/#[0-9a-fA-F]{3,8}\b/.test(source), file).toBe(false);
    }
  });
});

describe("PageSkeleton (AD-582)", () => {
  test("role=status announces the localized loading line; pulse bars are aria-hidden", () => {
    for (const [locale, loading] of [
      ["en", "Loading…"],
      ["zh_CN", "加载中…"],
    ] as const) {
      const out = renderSkeleton("table", { locale });
      expect(out).toContain('role="status"');
      expect(out).toContain(`>${loading}</span>`);
      expect(out).toContain('aria-hidden="true"');
    }
  });

  test("every kind keeps the page heading placeholder", () => {
    for (const kind of ["table", "cards", "forms"] as const) {
      expect(count(renderSkeleton(kind), 'data-slot="skeleton-heading"'), kind).toBe(1);
    }
  });

  test("table idiom: header row + 5 body rows by default, composited from ui/skeleton bars", () => {
    const out = renderSkeleton("table");
    expect(count(out, 'data-slot="skeleton-table-header"')).toBe(1);
    expect(count(out, 'data-slot="skeleton-table-row"')).toBe(5);
    // 4 header cells + 5 rows × 4 cells — all Skeleton primitives.
    expect(count(out, 'data-slot="skeleton"')).toBe(24);
  });

  test("cards idiom: 3 card shells by default; forms idiom: 4 labeled input blocks", () => {
    expect(count(renderSkeleton("cards"), 'data-slot="skeleton-card"')).toBe(3);
    expect(count(renderSkeleton("forms"), 'data-slot="skeleton-form-field"')).toBe(4);
    // Input bars match the restyled control shape (h-9, control-tier radius).
    expect(renderSkeleton("forms")).toContain("h-9 w-full rounded-sm");
  });

  test("rows overrides the per-kind default", () => {
    expect(count(renderSkeleton("table", { rows: 2 }), 'data-slot="skeleton-table-row"')).toBe(2);
    expect(count(renderSkeleton("cards", { rows: 6 }), 'data-slot="skeleton-card"')).toBe(6);
    expect(count(renderSkeleton("forms", { rows: 1 }), 'data-slot="skeleton-form-field"')).toBe(1);
  });
});

describe("EmptyState (AD-582)", () => {
  test("composed guidance view on the Card surface — icon chip, title, description, action slot", () => {
    const out = emptyState({ icon: true, description: "Connect your first App.", action: true });
    expect(out).toContain("bg-card"); // restyled Card primitive surface
    expect(out).toContain("shadow-(--shadow-card)"); // v0.3 tinted elevation token
    expect(out).toContain('data-slot="empty-state-icon"');
    expect(out).toContain('data-testid="chosen-icon"'); // consumer-chosen node renders inside the chip
    expect(out).toContain('data-slot="empty-state-title"');
    expect(out).toContain("No Apps yet");
    expect(out).toContain('data-slot="empty-state-description"');
    expect(out).toContain('data-slot="empty-state-action"');
    expect(out).toContain(">Create GitHub App</button>");
  });

  test("description, icon, and action are optional — the title line always renders", () => {
    const out = emptyState({ title: "No members yet." });
    expect(out).toContain("No members yet.");
    expect(out).not.toContain('data-slot="empty-state-icon"');
    expect(out).not.toContain('data-slot="empty-state-description"');
    expect(out).not.toContain('data-slot="empty-state-action"');
  });
});

describe("ErrorState (AD-582)", () => {
  test("role=alert (WCAG 4.1.3, matching the PageNotice error face)", () => {
    expect(errorState()).toContain('role="alert"');
  });

  test("message falls back to common.loadFailed in both locales; explicit message wins", () => {
    expect(errorState()).toContain(`>${t("en", "common.loadFailed")}<`);
    expect(errorState({ locale: "zh_CN" })).toContain(`>${t("zh_CN", "common.loadFailed")}<`);
    expect(errorState({ message: "Rate limited." })).toContain(">Rate limited.<");
    expect(errorState({ message: "Rate limited." })).not.toContain(t("en", "common.loadFailed"));
  });

  test("retry button renders the common.retry label only when onRetry is wired", () => {
    const withRetry = errorState({ onRetry: true });
    expect(withRetry).toContain("data-variant=\"outline\"");
    expect(withRetry).toContain(">Retry</button>");
    const withoutRetry = errorState();
    expect(withoutRetry).not.toContain("<button");
    // Static markup cannot carry handlers — pin the wiring at the source.
    const source = readFileSync(join(spaRoot, "components/state/ErrorState.tsx"), "utf8");
    expect(source).toContain("onClick={onRetry}");
  });

  test("common.retry exists in both locales (en/zh parity, atomic addition)", () => {
    expect(t("en", "common.retry")).toBe("Retry");
    expect(t("zh_CN", "common.retry")).toBe("重试");
  });
});
