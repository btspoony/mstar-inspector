/**
 * Review trigger mode settings UI (spec review-trigger-policy §2/§3,
 * plan task 3): the segmented mode control + exact mention-string display
 * in the settings OpsCard, their i18n faces, and the save-flow contract.
 *
 * Harness: no DOM runner — SSR of the exported control (static markup,
 * the AppInfoCard/DraftChainPanel precedent) + source pins over
 * SettingsPage.tsx + pure-helper and dictionary pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isDictionaryKey, t } from "../../src/i18n";
import { REVIEW_TRIGGER_MODES as STORE_REVIEW_TRIGGER_MODES } from "../../src/dashboard/apps-store";
import { REVIEW_TRIGGER_MODES, isReviewTriggerMode, type ReviewTriggerMode } from "../../src/spa/pages/data";
import { ReviewTriggerControl, botMention } from "../../src/spa/pages/SettingsPage";

const settingsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");

const noopSave = (): Promise<{ kind: "success" | "error"; message: string }> =>
  Promise.resolve({ kind: "success", message: "unused" });

const controlHtml = (mode: ReviewTriggerMode, locale: "en" | "zh_CN" = "en", slug = "acme"): string =>
  renderToStaticMarkup(createElement(ReviewTriggerControl, { locale, slug, mode, onTriggerMode: noopSave }));

/** The one button-segment whose `title` carries the verbatim mode value. */
const segment = (html: string, mode: string): string => {
  const at = html.indexOf(`title="${mode}"`);
  expect(at, `segment title="${mode}"`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
};

describe("review trigger vocabulary (duplication lock + mention grammar)", () => {
  test("the SPA vocabulary mirrors the store's frozen migration-0022 enum (drift fails here)", () => {
    // Same duplication-lock convention as DEFAULT_CHAIN_NAME: src/spa/pages/
    // data.ts mirrors src/dashboard/apps-store.ts across the bundle boundary
    // (documented, deliberately not imported) — a one-sided rename here would
    // desync the wire values the control posts from the values the DB CHECK
    // admits. (Store declares `readonly ReviewTriggerMode[]`; the SPA copy is
    // the const tuple — the joined forms pin identical members in order.)
    expect(REVIEW_TRIGGER_MODES.join()).toBe("open,every_push,manual");
    expect(STORE_REVIEW_TRIGGER_MODES.join()).toBe("open,every_push,manual");
    expect(isReviewTriggerMode("open")).toBe(true);
    expect(isReviewTriggerMode("every_push")).toBe(true);
    expect(isReviewTriggerMode("manual")).toBe(true);
    // Radix's type="single" deselect emits "" — the guard must refuse it.
    expect(isReviewTriggerMode("")).toBe(false);
    expect(isReviewTriggerMode("EVERY_PUSH")).toBe(false);
    expect(isReviewTriggerMode("whenever")).toBe(false);
  });

  test("botMention is the exact canonical string @{slug}[bot] (spec §3 operator visibility)", () => {
    expect(botMention("acme")).toBe("@acme[bot]");
    // GitHub login continuation: hyphens ride the slug verbatim.
    expect(botMention("mstar-review")).toBe("@mstar-review[bot]");
  });
});

describe("trigger-mode segmented control (SSR)", () => {
  test("three segments render the verbatim values; the stored mode is the active one", () => {
    const html = controlHtml("every_push");
    // Verbatim wire values on every segment (the title attribute — Radix
    // does not render its `value` prop to the DOM).
    expect(html).toContain('title="open"');
    expect(html).toContain('title="every_push"');
    expect(html).toContain('title="manual"');
    // A radiogroup whose active segment is exactly the stored mode.
    expect(html).toContain('role="radiogroup"');
    expect(segment(html, "every_push")).toContain('data-state="on"');
    expect(segment(html, "open")).toContain('data-state="off"');
    expect(segment(html, "manual")).toContain('data-state="off"');
    // Active segment announces itself to AT.
    expect(segment(html, "every_push")).toContain('aria-checked="true"');
    expect(segment(html, "open")).toContain('aria-checked="false"');
  });

  test("a non-default stored mode is the active segment (open / manual)", () => {
    for (const mode of ["open", "manual"] as const) {
      const html = controlHtml(mode);
      expect(segment(html, mode)).toContain('data-state="on"');
      expect(segment(html, "every_push")).toContain('data-state="off"');
    }
  });

  test("segment labels localize; the verbatim values and mention string never do", () => {
    const en = controlHtml("every_push");
    expect(en).toContain("Review trigger");
    expect(en).toContain("First open");
    expect(en).toContain("Every push");
    expect(en).toContain("Manual");
    const zh = controlHtml("every_push", "zh_CN");
    expect(zh).toContain("评审触发");
    expect(zh).toContain("首次打开");
    expect(zh).toContain("每次推送");
    expect(zh).toContain("仅手动");
    // Both locales keep the same verbatim value set + mention form.
    for (const html of [en, zh]) {
      expect(html).toContain('title="every_push"');
      expect(html).toContain("@acme[bot]");
    }
  });
});

describe("mention-string display (spec §3 operator visibility, SSR)", () => {
  test("the exact string renders as one code node with the plain form in title + aria", () => {
    const en = controlHtml("every_push");
    // ONE text node — click-drag copies the exact string.
    expect(en).toContain(">@acme[bot]</code>");
    // Copy-friendly plain form in the title and the localized aria label.
    expect(en).toContain('title="@acme[bot]"');
    expect(en).toContain('aria-label="Bot mention: @acme[bot]"');
    expect(controlHtml("every_push", "zh_CN")).toContain('aria-label="机器人提及字符串：@acme[bot]"');
  });

  test("the mention derives from the App slug (one App's string never leaks to another)", () => {
    const html = controlHtml("every_push", "en", "mstar-review");
    expect(html).toContain(">@mstar-review[bot]</code>");
    expect(html).toContain('title="@mstar-review[bot]"');
    expect(html).not.toContain("@acme[bot]");
  });

  test("the mention copy sits in the control (near the mode segments, per the assignment)", () => {
    const html = controlHtml("every_push");
    expect(html.indexOf('role="radiogroup"')).toBeGreaterThan(-1);
    expect(html.indexOf("@acme[bot]")).toBeGreaterThan(html.indexOf('role="radiogroup"'));
    // The every-mode hint rides it (the spec's "works in every mode" face).
    expect(html).toContain("works in every mode");
  });
});

describe("save flow + 400 fallback contract (source pins)", () => {
  test("the control posts the verbatim mode to the pinned T1 route through the shared pinned-ops family", () => {
    // SettingsView wires the save through runPinnedWithBody — the family
    // whose 400 face resolves through settingsErrorMessage (key-first,
    // never-blank fallback; count pinned at 2 by settings-error-keys.test.ts
    // and unchanged here).
    expect(settingsPage).toContain(
      "runPinnedWithBody(`/dashboard/apps/${app.slug}/review-trigger-mode`, { mode })",
    );
    // OpsCard receives the saver and renders the control (beside the review
    // toggle, inside the ops card — before the pause/resume actions row).
    const opsBody = settingsPage.slice(
      settingsPage.indexOf("function OpsCard"),
      settingsPage.indexOf("The App's exact bot-mention string"),
    );
    expect(opsBody).toContain("onTriggerMode={onTriggerMode}");
    expect(opsBody).toContain("<ReviewTriggerControl");
    expect(opsBody).toContain("mode={app.review_trigger_mode}");
    const controlPos = opsBody.indexOf("<ReviewTriggerControl");
    expect(controlPos).toBeGreaterThan(-1);
    expect(opsBody.indexOf('onPending({ kind: "resume" })')).toBeGreaterThan(controlPos);
  });

  test("the deselect emit and a same-value click never reach the wire; the selection mirrors the payload", () => {
    const controlBody = settingsPage.slice(
      settingsPage.indexOf("export function ReviewTriggerControl"),
      settingsPage.indexOf("function ProvidersCard"),
    );
    // Radix type="single" emits "" on deselect; "" (and any off-vocabulary
    // value) is refused before any POST — and an already-selected segment is
    // a client-side no-op (the server's idempotent no-op stays reserved for
    // the stale-payload case).
    expect(controlBody).toContain("if (!isReviewTriggerMode(next) || next === selected) return;");
    // Server-state mirror (the sandbox-image editor discipline): after the
    // awaited background reload lands, the selection tracks the stored mode —
    // a failed save reverts instead of leaving the optimistic value.
    expect(controlBody).toContain("setSelected(mode);");
    expect(controlBody).toContain("}, [mode]);");
    // The save is busy-gated (one POST at a time) and reports into the
    // control's own region, never the card's dialog-ops region.
    expect(controlBody).toContain("disabled={busy}");
    expect(controlBody).toContain("<NoticeRegion notice={notice} />");
  });

  test("the keyed 400 key is a registered dictionary key with both locale faces (the resolver's input)", () => {
    expect(isDictionaryKey("settings.error.triggerModeUnknown")).toBe(true);
    expect(t("en", "settings.error.triggerModeUnknown", { mode: "whenever" })).toContain("whenever");
    expect(t("en", "settings.error.triggerModeUnknown", { mode: "whenever" })).toContain("open, every_push, or manual");
    expect(t("zh_CN", "settings.error.triggerModeUnknown", { mode: "whenever" })).toContain("whenever");
    expect(t("zh_CN", "settings.error.triggerModeUnknown", { mode: "whenever" })).toContain("不是有效的审查触发模式");
  });

  test("control copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.triggerMode")).toBe("Review trigger");
    expect(t("zh_CN", "settings.triggerMode")).toBe("评审触发");
    expect(t("en", "settings.triggerModeOpen")).toBe("First open");
    expect(t("zh_CN", "settings.triggerModeOpen")).toBe("首次打开");
    expect(t("en", "settings.triggerModeEveryPush")).toBe("Every push");
    expect(t("zh_CN", "settings.triggerModeEveryPush")).toBe("每次推送");
    expect(t("en", "settings.triggerModeManual")).toBe("Manual");
    expect(t("zh_CN", "settings.triggerModeManual")).toBe("仅手动");
    expect(t("en", "settings.triggerModeMention")).toContain("PR comment");
    expect(t("zh_CN", "settings.triggerModeMention")).toContain("PR 评论");
    expect(t("en", "settings.triggerModeMentionAria", { mention: "@a[bot]" })).toBe("Bot mention: @a[bot]");
    expect(t("zh_CN", "settings.triggerModeMentionAria", { mention: "@a[bot]" })).toBe("机器人提及字符串：@a[bot]");
  });
});
