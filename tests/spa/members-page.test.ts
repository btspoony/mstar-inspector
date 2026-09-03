/**
 * Plan 34 T2: Members page rebuilt on shadcn Table + invite toolbox bar +
 * confirm dialogs. No DOM runner — same source-scan contract as
 * settings-layout.test.ts — plus dictionary interpolation in both locales.
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
    expect(source).toContain("member.created_at");
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
