/**
 * Members page rebuilt on shadcn Table + invite toolbox bar +
 * confirm dialogs. Mixed contract: static source pins for the presentational
 * shape (no DOM runner, the settings-layout.test.ts precedent) plus executed
 * assertions over the page's own read/refusal seams, so a wiring regression
 * fails here without pinning the code's spelling.
 * F-07: the Joined column renders through the shared
 * relative-time helper, with the absolute stamp kept as a native tooltip.
 *
 * Every read and write hangs off the page's workspace base, and the page
 * carries pending invitations with revoke.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import {
  inviteFailureNotice,
  loadMembersPage,
  postMemberWrite,
  showsPendingInvites,
} from "../../src/spa/pages/MembersPage";
import type { InviteRow } from "../../src/spa/pages/data";

const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/MembersPage.tsx"), "utf8");

const invite = (): InviteRow => ({
  id: "i1",
  github_login: "hubot",
  role: "member",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-08T00:00:00Z",
});

describe("members page shadcn rebuild", () => {
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

  test("columns are login / role / joined / actions with the visibility notice on top", () => {
    for (const key of [
      "members.tableLogin",
      "members.roleLabel",
      "members.tableJoined",
      "members.tableActions",
      "members.visibleToMembers",
    ]) {
      expect(source).toContain(`"${key}"`);
    }
  });

  test("joined column renders the shared relative-time helper (F-07)", () => {
    expect(source).toContain('from "../relative-time"');
    // Same call shape as AppsPage / SettingsPage: value first, locale second.
    expect(source).toContain("formatRelativeTime(member.created_at, locale)");
    // The absolute stamp survives as the cell's native tooltip, not the visible text.
    expect(source).toContain("title={member.created_at}");
  });

  test("every read hangs off the workspace base", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/members")) {
        return new Response(
          JSON.stringify({
            viewer: { role: "member" },
            members: [{ id: "u1", github_login: "octocat", role: "member", created_at: "2026-01-01T00:00:00Z" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ invites: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      // A plain member costs ONE request: the manager-only pending list is
      // never asked for, so no 403 reaches the page.
      const member = await loadMembersPage("/dashboard/acme");
      expect(member).toEqual({
        members: [{ id: "u1", github_login: "octocat", role: "member", created_at: "2026-01-01T00:00:00Z" }],
        role: "member",
        invites: [],
      });
      expect(calls).toEqual(["/dashboard/acme/api/members"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("every member write posts under the workspace base, never a retired root path", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await postMemberWrite("/dashboard/acme", { kind: "invite", login: "hubot", role: "admin" });
      await postMemberWrite("/dashboard/acme", { kind: "revoke", inviteId: "i1" });
      await postMemberWrite("/dashboard/acme", { kind: "role", userId: "u1", nextRole: "admin" });
      await postMemberWrite("/dashboard/acme", { kind: "remove", userId: "u1" });
      expect(calls).toEqual([
        { url: "/dashboard/acme/api/members/invites", method: "POST" },
        { url: "/dashboard/acme/api/members/invites/i1/revoke", method: "POST" },
        { url: "/dashboard/acme/members/role", method: "POST" },
        { url: "/dashboard/acme/members/remove", method: "POST" },
      ]);
      // The workspace-only route family dropped the deployment-level copies;
      // posting there would answer 404.
      for (const { url } of calls) {
        expect(url.startsWith("/dashboard/acme/")).toBe(true);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a manager's load adds the pending list on the same base", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/members/invites")) {
        return new Response(
          JSON.stringify({
            invites: [
              {
                id: "i1",
                github_login: "hubot",
                role: "admin",
                created_at: "2026-01-01T00:00:00Z",
                expires_at: "2026-01-08T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ viewer: { role: "owner" }, members: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const loaded = await loadMembersPage("/dashboard/acme");
      expect(loaded?.invites.map((invite) => invite.github_login)).toEqual(["hubot"]);
      expect(calls).toEqual(["/dashboard/acme/api/members", "/dashboard/acme/api/members/invites"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the pending table is a manager-only, non-empty affordance", () => {
    // Behaviour, not the render expression: only owner/admin see the section,
    // and never an empty one.
    expect(showsPendingInvites("owner", [invite()])).toBe(true);
    expect(showsPendingInvites("admin", [invite()])).toBe(true);
    expect(showsPendingInvites("member", [invite()])).toBe(false);
    expect(showsPendingInvites(null, [invite()])).toBe(false);
    expect(showsPendingInvites("owner", [])).toBe(false);
  });

  test("the pending invite 409 surfaces as a warning, not a retryable error", () => {
    // The server's refusal grammar decides the notice, not the code spelling.
    expect(inviteFailureNotice(409, "invite.pending_exists", false)).toEqual({
      kind: "warn",
      key: "notice.warn.invitePending",
    });
    expect(inviteFailureNotice(409, "invite.pending_exists", true).kind).toBe("warn");
    // An already-member target warns; anything else is a real failure.
    expect(inviteFailureNotice(409, "already a member", true).kind).toBe("warn");
    expect(inviteFailureNotice(500, "", false)).toEqual({
      kind: "error",
      key: "notice.error.inviteFailed",
    });
  });

  test("self row renders no actions; the sole owner's demote/remove items are disabled client-side", () => {
    expect(source).toContain("members.you");
    expect(source).toContain('member.role === "owner" && ownerCount === 1');
    expect(source).toContain("disabled={protectedMember}");
  });

  test("the confirm dialogs share one Dialog with destructive remove/revoke confirm", () => {
    expect(source).toContain("members.confirmRoleTitle");
    expect(source).toContain("members.confirmRemoveTitle");
    expect(source).toContain('pending.kind === "role" ? "default" : "destructive"');
  });

  test("invite submit is single-flight and network failures surface a notice (QC S-001/S-002)", () => {
    expect(source).toContain('<Button type="submit" disabled={busy}>');
    expect(source).toContain("} catch {");
    expect(source).toContain('t(locale, "notice.error.inviteFailed", { login: trimmed })');
    expect(source).toContain('t(locale, "notice.error.roleChangeFailed", { login: member.github_login })');
    expect(source).toContain('t(locale, "notice.error.removeFailed", { login: member.github_login })');
    expect(source).toContain('t(locale, "notice.error.revokeFailed", { login: invite.github_login })');
  });

  test("page-level states ride the shared state trio; op notices keep the PageNotice channel", () => {
    // Loading is the table skeleton; page-load failure is the composed
    // error with retry wired to the page's own load callback.
    expect(source).toContain('<PageSkeleton locale={locale} kind="table" />');
    expect(source).toContain('<ErrorState locale={locale} onRetry={() => void load()} />');
    expect(source).not.toContain("LoadingNotice");
    expect(source).not.toContain("LoadFailedNotice");
    // Channel boundary (AD-582): op-outcome notices stay on PageNotice.
    expect(source).toContain('<PageNotice kind={notice.kind} message={notice.message} />');
  });

  test("no page-level admin-only face: the member list is visible to every member", () => {
    // Plan AC4 — a plain member sees the list; only the manager actions and
    // the pending list are gated (client-side mirror; the server decides).
    expect(source).not.toContain("members.adminOnly");
    expect(source).toContain("emptyDescriptionMember");
  });

  test("op-triggered reloads are background — only the initial load gates the skeleton (F-58-1)", () => {
    // background-reload contract (mirrors SettingsPage): `load` flips
    // to "loading" (the PageSkeleton gate) on foreground loads only.
    expect(source).toContain('if (!background) setState("loading")');
    // Both op paths (invite submit + dialog confirm) reload in the background.
    expect(source.split("load({ background: true })").length - 1).toBe(2);
    // No bare foreground await remains: a bare `await load()` would flip the
    // page into the skeleton state mid-op and blink out the op PageNotice.
    expect(source).not.toContain("await load()");
  });

  test("empty member list renders the no-action EmptyState guidance", () => {
    expect(source).toContain('t(locale, "members.emptyTitle")');
    // The description differs for a manager (an invite form is present) and a
    // plain member (it is not), so it is chosen by the same capability guard.
    expect(source).toContain(
      'canInvite ? "members.emptyDescription" : "members.emptyDescriptionMember"',
    );
    const emptyCall = source.match(/<EmptyState[\s\S]*?\/>/);
    expect(emptyCall).not.toBeNull();
    // No action slot: the invite form above is the path.
    expect(emptyCall![0]).not.toContain("action=");
  });

  test("new copy interpolates in both locales", () => {
    const keys = [
      "common.cancel",
      "members.visibleToMembers",
      "members.roleLabel",
      "members.tableLogin",
      "members.tableJoined",
      "members.tableExpires",
      "members.tableActions",
      "members.actionsMenuLabel",
      "members.makeAdmin",
      "members.makeMember",
      "members.confirmRoleTitle",
      "members.confirmRoleBody",
      "members.confirmRoleButton",
      "members.confirmRemoveTitle",
      "members.confirmRemoveBody",
      "members.pendingHeading",
      "members.confirmRevokeTitle",
      "members.confirmRevokeBody",
      "members.revoke",
      "members.role.owner",
      "members.role.admin",
      "members.role.member",
      "notice.success.roleChanged",
      "notice.success.revoked",
      "notice.warn.invitePending",
      "notice.error.inviteFailed",
      "notice.error.roleChangeFailed",
      "notice.error.revokeFailed",
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
