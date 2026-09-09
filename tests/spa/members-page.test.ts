/**
 * Plan 34 T2: Members page rebuilt on shadcn Table + invite toolbox bar +
 * confirm dialogs. No DOM runner — same source-scan contract as
 * settings-layout.test.ts — plus dictionary interpolation in both locales.
 * Plan 45 T5 / F-07: the Joined column renders through the shared
 * relative-time helper, with the absolute stamp kept as a native tooltip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";

const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/MembersPage.tsx"), "utf8");

describe("members page shadcn rebuild (plan 34 T2)", () => {
  test("table, dropdown, dialog, select, input, button come from the ui kit — zero native controls", () => {
    for (const component of ["table", "dropdown-menu", "dialog", "select", "input", "button"]) {
      expect(source).toContain(`@/components/ui/${component}`);
    }
    // No CSS-modules classes or native controls on the rebuilt surface.
    expect(source).not.toContain("pages.module.css");
    expect(source).not.toMatch(/<button[\s>]/);
    expect(source).not.toMatch(/<input[\s>]/);
    expect(source).not.toMatch(/<select[\s>]/);
  });

  test("columns are login / role / joined / actions with the invite-only notice on top", () => {
    for (const key of [
      "members.tableLogin",
      "members.roleLabel",
      "members.tableJoined",
      "members.tableActions",
      "members.inviteOnlyNotice",
    ]) {
      expect(source).toContain(`"${key}"`);
    }
  });

  test("joined column renders the shared relative-time helper (plan 45 T5 / F-07)", () => {
    expect(source).toContain('from "../relative-time"');
    // Same call shape as AppsPage / SettingsPage: value first, locale second.
    expect(source).toContain("formatRelativeTime(member.created_at, locale)");
    // The absolute stamp survives as the cell's native tooltip, not the visible text.
    expect(source).toContain("title={member.created_at}");
  });

  test("invite posts login + role; role change and remove ride the pinned POST paths", () => {
    expect(source).toContain('postForm("/dashboard/members/invite", { login: trimmed, role: inviteRole })');
    expect(source).toContain('postForm("/dashboard/members/role", { userId: member.id, role: nextRole })');
    expect(source).toContain('postForm("/dashboard/members/remove", { userId: member.id })');
  });

  test("self row renders no actions; the last admin's demote/remove items are disabled client-side", () => {
    expect(source).toContain("members.you");
    expect(source).toContain('member.role === "admin" && adminCount === 1');
    expect(source).toContain("disabled={protectedAdmin}");
  });

  test("both confirm dialogs share one Dialog with destructive remove confirm", () => {
    expect(source).toContain("members.confirmRoleTitle");
    expect(source).toContain("members.confirmRemoveTitle");
    expect(source).toContain('pending.kind === "remove" ? "destructive" : "default"');
  });

  test("invite submit is single-flight and network failures surface a notice (QC S-001/S-002)", () => {
    expect(source).toContain('<Button type="submit" disabled={busy}>');
    expect(source).toContain("} catch {");
    expect(source).toContain('t(locale, "notice.error.inviteFailed", { login: trimmed })');
    expect(source).toContain('t(locale, "notice.error.roleChangeFailed", { login: member.github_login })');
    expect(source).toContain('t(locale, "notice.error.removeFailed", { login: member.github_login })');
  });

  test("page-level states ride the plan-57 trio; op notices keep the PageNotice channel (plan 58 T3)", () => {
    // Loading is the table skeleton; page-load failure is the composed
    // error with retry wired to the page's own load callback.
    expect(source).toContain('<PageSkeleton locale={locale} kind="table" />');
    expect(source).toContain('<ErrorState locale={locale} onRetry={() => void load()} />');
    expect(source).not.toContain("LoadingNotice");
    expect(source).not.toContain("LoadFailedNotice");
    // Channel boundary (AD-582): op-outcome notices stay on PageNotice.
    expect(source).toContain('<PageNotice kind={notice.kind} message={notice.message} />');
    expect(source).toContain('<PageNotice kind="error" message={t(locale, "members.adminOnly")} />');
  });

  test("op-triggered reloads are background — only the initial load gates the skeleton (plan 58 F-58-1)", () => {
    // Plan-38 background-reload contract (mirrors SettingsPage): `load` flips
    // to "loading" (the PageSkeleton gate) on foreground loads only.
    expect(source).toContain('if (!background) setState("loading")');
    // Both op paths (invite submit + dialog confirm) reload in the background.
    expect(source.split("load({ background: true })").length - 1).toBe(2);
    // No bare foreground await remains: a bare `await load()` would flip the
    // page into the skeleton state mid-op and blink out the op PageNotice.
    expect(source).not.toContain("await load()");
  });

  test("empty member list renders the no-action EmptyState guidance (plan 58 T3)", () => {
    expect(source).toContain('t(locale, "members.emptyTitle")');
    expect(source).toContain('t(locale, "members.emptyDescription")');
    const emptyCall = source.match(/<EmptyState[\s\S]*?\/>/);
    expect(emptyCall).not.toBeNull();
    // No action slot: the invite form above is the path.
    expect(emptyCall![0]).not.toContain("action=");
  });

  test("new copy interpolates in both locales", () => {
    const keys = [
      "common.cancel",
      "members.inviteOnlyNotice",
      "members.roleLabel",
      "members.tableLogin",
      "members.tableJoined",
      "members.tableActions",
      "members.actionsMenuLabel",
      "members.makeAdmin",
      "members.makeMember",
      "members.confirmRoleTitle",
      "members.confirmRoleBody",
      "members.confirmRoleButton",
      "members.confirmRemoveTitle",
      "members.confirmRemoveBody",
      "notice.success.roleChanged",
      "notice.error.inviteFailed",
      "notice.error.roleChangeFailed",
    ] as const;
    for (const key of keys) {
      const params = { login: "octocat", role: "admin" };
      const en = t("en", key, params);
      const zh = t("zh_CN", key, params);
      expect(en.length).toBeGreaterThan(0);
      expect(zh.length).toBeGreaterThan(0);
      expect(zh).not.toBe(en);
      expect(en).not.toContain("{");
      expect(zh).not.toContain("{");
    }
  });
});
