/**
 * Members page rebuilt on shadcn Table + invite toolbox bar +
 * confirm dialogs.
 *
 * Executed contract: the page's read/refusal/visibility seams
 * (`loadMembersPage`, `postMemberWrite`, `inviteFailureNotice`,
 * `showsPendingInvites`), the dictionary copy they surface, and the rendered
 * member row (`MembersTable`). The previous ui-kit / column source pins were
 * deleted — they red-lined refactors without proving behaviour, and a
 * component whose state lives in `useState` renders as the loading skeleton
 * under SSR, so the page itself has no executable face here. The rendered
 * contract therefore hangs off the extracted `MembersTable`, which is the
 * page's own markup with the state supplied.
 *
 * Every read and write hangs off the page's workspace base, and the page
 * carries pending invitations with revoke.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useLayoutEffect, useRef } from "react";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { FLASH_STORAGE_KEY, takeFlash } from "../../src/spa/flash";
import { Layout } from "../../src/spa/Layout";
import { formatRelativeTime } from "../../src/spa/relative-time";
import {
  DeleteWorkspaceAction,
  WorkspacePanel,
  deleteRefusal,
  deleteWorkspace,
  inviteFailureNotice,
  leaveWorkspaceForDashboard,
  loadMembersPage,
  MembersTable,
  postMemberWrite,
  showsPendingInvites,
} from "../../src/spa/pages/MembersPage";
import type { InviteRow, MemberRow, WorkspaceRole } from "../../src/spa/pages/data";

const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/MembersPage.tsx"), "utf8");

const invite = (): InviteRow => ({
  id: "i1",
  github_login: "hubot",
  role: "member",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-08T00:00:00Z",
});

/** The members payload's workspace summary — one free workspace, two attempts. */
const WORKSPACE = {
  plan: { id: "free", name: "Free" },
  memberLimit: 5,
  reviewAttemptsThisMonth: 2,
  pendingInvites: 0,
};

describe("members page shadcn rebuild", () => {
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
            workspace: WORKSPACE,
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
        workspace: WORKSPACE,
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
        JSON.stringify({ viewer: { role: "owner" }, workspace: WORKSPACE, members: [] }),
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
    // Every op path (invite submit, dialog confirm, refused delete) reloads in
    // the background.
    expect(source.split("load({ background: true })").length - 1).toBe(3);
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

describe("members table (rendered)", () => {
  const ROW: MemberRow = {
    id: "u1",
    github_login: "octocat",
    role: "member",
    created_at: "2026-01-02T03:04:05.678Z",
  };

  test("the Joined cell shows the relative stamp and keeps the absolute one as its tooltip", () => {
    // Day granularity: the bucket cannot roll over inside one test run.
    const relative = formatRelativeTime(ROW.created_at, "en");
    expect(relative).toMatch(/\d+ days ago$/);
    const html = renderToStaticMarkup(
      createElement(MembersTable, {
        locale: "en",
        members: [ROW],
        viewerLogin: "octocat",
        memberRole: "owner",
        canInvite: true,
        onAction: () => {},
      }),
    );
    // Both faces of the same cell: the copy a reader sees, and the exact
    // stamp the tooltip must still expose (losing the title is the silent
    // regression this covers).
    expect(html).toContain(`title="${ROW.created_at}"`);
    expect(html).toContain(`>${relative}<`);
    expect(html).toContain(t("en", "members.tableJoined"));
  });
});

describe("workspace settings block", () => {
  const FREE = {
    plan: { id: "free", name: "Free" },
    memberLimit: 5,
    reviewAttemptsThisMonth: 128,
    pendingInvites: 0,
  };

  test("the labels carry the Product copy; a free workspace shows BYOK only", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, { locale: "en", workspace: FREE, memberCount: 4 }),
    );
    expect(html).toContain(t("en", "members.workspaceHeading"));
    expect(html).toContain(t("en", "members.planLabel"));
    expect(html).toContain("Free");
    expect(html).toContain("BYOK only");
    expect(html).toContain("4 / 5");
    expect(html).toContain("1 slot left");
    expect(html).toContain(t("en", "members.reviewAttemptsLabel"));
    expect(html).toContain("128");
    expect(html).toContain("Counted, not limited.");
    // The upgrade position stays empty by design — no price, purchase or billing.
    expect(html).not.toMatch(/upgrade|price|billing|purchase/i);
  });

  test("pro drops the sub-label; a full workspace says No seats left", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        workspace: {
          plan: { id: "pro", name: "Pro" },
          memberLimit: 5,
          reviewAttemptsThisMonth: 0,
          pendingInvites: 0,
        },
        memberCount: 5,
      }),
    );
    expect(html).toContain("Pro");
    expect(html).not.toContain("BYOK only");
    expect(html).toContain("5 / 5");
    expect(html).toContain("No seats left");
    expect(html).not.toContain("slots left");
  });

  test("a pending invite occupies a seat: 4 members + 1 pending reads No seats left", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        workspace: { ...FREE, pendingInvites: 1 },
        memberCount: 4,
      }),
    );
    expect(html).toContain("4 / 5");
    expect(html).toContain("1 pending invitation");
    expect(html).toContain("No seats left");
    expect(html).not.toContain("slots left");
  });

  test("the pending line pluralizes and the slot count subtracts it", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        workspace: { ...FREE, pendingInvites: 2 },
        memberCount: 2,
      }),
    );
    expect(html).toContain("2 pending invitations");
    expect(html).toContain("1 slot left");
  });

  test("the delete entry renders for the owner only", () => {
    const render = (role: WorkspaceRole | null) =>
      renderToStaticMarkup(
        createElement(DeleteWorkspaceAction, { locale: "en", role, busy: false, onDelete: () => {} }),
      );
    expect(render("owner")).toContain("Delete workspace");
    for (const role of ["admin", "member", null] as const) expect(render(role)).toBe("");
  });

  test("the confirmation title, body and button are the Product copy verbatim", () => {
    expect(t("en", "members.deleteWorkspaceTitle")).toBe("Delete this workspace?");
    expect(t("en", "members.deleteWorkspaceBody")).toBe(
      "This cannot be undone. Members will lose access, pending invites will be cancelled, and Apps in this workspace will no longer be reviewed. A review that has already started is not cancelled.",
    );
    expect(t("en", "members.deleteWorkspace")).toBe("Delete workspace");
    expect(t("en", "notice.success.workspaceDeleted")).toBe(
      "Workspace deleted. Its Apps are not reviewed.",
    );
    expect(t("zh_CN", "notice.success.workspaceDeleted")).toBe("工作区已删除，其 App 不再接受审查。");
  });

  test("confirm posts to the workspace delete route, then lands on /dashboard", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const redirects: string[] = [];
    const realFetch = globalThis.fetch;
    const scope = globalThis as {
      window?: { location: { assign: (url: string) => void } };
      sessionStorage?: Storage;
    };
    const store = new Map<string, string>();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    scope.window = { location: { assign: (url: string) => redirects.push(url) } };
    scope.sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
    try {
      expect(await deleteWorkspace("/dashboard/acme")).toBe(200);
      expect(calls).toEqual([{ url: "/dashboard/acme/api/workspace/delete", method: "POST" }]);
      expect(redirects).toEqual(["/dashboard"]);

      // F-2: the boot read consumes the flash; the landing shell renders it
      // through the notice exactly once, then nothing remains.
      const line = "Workspace deleted. Its Apps are not reviewed.";
      const landing = renderToStaticMarkup(
        createElement(Layout, {
          boot: { locale: "en", login: "octocat", name: null },
          pathname: "/dashboard",
          flash: takeFlash(),
          children: createElement("p", null, "page"),
        }),
      );
      expect(landing.split(line).length - 1).toBe(1);
      expect(store.has(FLASH_STORAGE_KEY)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      delete scope.window;
      delete scope.sessionStorage;
    }
  });

  test("a 404 delete leaves for the dashboard carrying the one-shot unavailable flash", async () => {
    const redirects: string[] = [];
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    const scope = globalThis as {
      window?: { location: { assign: (url: string) => void } };
      sessionStorage?: Storage;
    };
    const store = new Map<string, string>();
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    scope.window = { location: { assign: (url: string) => redirects.push(url) } };
    scope.sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
    try {
      // The refusal is terminal and the write itself neither navigates nor
      // flashes — the page's 404 branch hands over to the terminal move below.
      expect(deleteRefusal(404)).toEqual({ next: "leave" });
      expect(await deleteWorkspace("/dashboard/acme")).toBe(404);
      expect(redirects).toEqual([]);
      expect(store.size).toBe(0);

      leaveWorkspaceForDashboard();
      expect(redirects).toEqual(["/dashboard"]);
      // The landing states it once from the flash and consumes the key.
      const line = "This workspace is no longer available to you.";
      const landing = renderToStaticMarkup(
        createElement(Layout, {
          boot: { locale: "en", login: "octocat", name: null },
          pathname: "/dashboard",
          flash: takeFlash(),
          children: createElement("p", null, "page"),
        }),
      );
      expect(landing.split(line).length - 1).toBe(1);
      expect(store.has(FLASH_STORAGE_KEY)).toBe(false);
      // No reload: the delete was the only request issued.
      expect(calls).toEqual(["/dashboard/acme/api/workspace/delete"]);
    } finally {
      globalThis.fetch = realFetch;
      delete scope.window;
      delete scope.sessionStorage;
    }
  });

  test("a mounted shell keeps the flash until the pathname changes", async () => {
    const win = new Window({ url: "http://localhost/dashboard" });
    const scope = globalThis as unknown as Record<string, unknown>;
    const installed = {
      window: win,
      document: win.document,
      navigator: win.navigator,
      HTMLElement: win.HTMLElement,
      Element: win.Element,
      Node: win.Node,
      Event: win.Event,
      MutationObserver: win.MutationObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    Object.assign(scope, installed);
    const paints: string[] = [];
    try {
      // The one module that must load AFTER the browser globals exist: React
      // DOM caches `canUseDOM` at evaluation, so a static import here would
      // take the server path. Every other module is a normal static import.
      const { createRoot } = await import("react-dom/client");

      // Records every committed paint: layout effects run after the DOM
      // mutation and before the flash-clearing passive effect, so the first
      // paint stays observable even though act() flushes effects on return.
      function Shell({ pathname }: { pathname: string }) {
        const ref = useRef<HTMLDivElement>(null);
        useLayoutEffect(() => {
          paints.push(ref.current?.innerHTML ?? "");
        });
        return createElement(
          "div",
          { ref },
          createElement(Layout, {
            boot: { locale: "en", login: "octocat", name: null },
            pathname,
            flash: "workspaceDeleted",
            children: createElement("p", null, "page"),
          }),
        );
      }

      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      const render = (pathname: string) =>
        act(async () => root.render(createElement(Shell, { pathname })));

      await render("/dashboard");
      // A plain re-render of the same pathname must keep showing it: the copy
      // is cleared by navigation, never by a mount/render pass.
      await render("/dashboard");
      const line = "Workspace deleted. Its Apps are not reviewed.";
      expect(paints[0]!.split(line).length - 1).toBe(1);
      expect(paints[1]!.split(line).length - 1).toBe(1);

      // The first move away spends it, so the walk back shows nothing.
      await render("/dashboard/apps");
      await render("/dashboard");
      expect(paints.at(-1)!.split(line).length - 1).toBe(0);
      await act(async () => root.unmount());
    } finally {
      for (const key of Object.keys(installed)) delete scope[key];
      win.close();
    }
  });

  test("a refused delete picks copy and next move by status", () => {
    // 403: not the owner — stay, reload in the background, name the cause.
    expect(deleteRefusal(403)).toEqual({
      next: "reload",
      kind: "warn",
      key: "members.deleteWorkspaceNotOwner",
    });
    // 404: the workspace is gone OR this viewer lost the membership — leave
    // for the dashboard; the copy rides the flash instead of an inline notice.
    expect(deleteRefusal(404)).toEqual({ next: "leave" });
    expect(t("en", "members.deleteWorkspaceNotOwner")).toBe("Only the workspace owner can delete it.");
    expect(t("en", "notice.warn.workspaceUnavailable")).toBe(
      "This workspace is no longer available to you.",
    );
    // A 5xx keeps the generic wording and leaves the page untouched; a network
    // failure throws before it ever reaches this mapping.
    expect(deleteRefusal(500)).toEqual({
      next: "stay",
      kind: "error",
      key: "members.deleteWorkspaceFailed",
    });
  });

  test("a refused delete keeps the page in place and flashes nothing", async () => {
    const redirects: string[] = [];
    const realFetch = globalThis.fetch;
    const scope = globalThis as {
      window?: { location: { assign: (url: string) => void } };
      sessionStorage?: Storage;
    };
    const store = new Map<string, string>();
    globalThis.fetch = (async () => new Response("owner only", { status: 403 })) as unknown as typeof fetch;
    scope.window = { location: { assign: (url: string) => redirects.push(url) } };
    scope.sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
    try {
      expect(await deleteWorkspace("/dashboard/acme")).toBe(403);
      expect(redirects).toEqual([]);
      expect(store.size).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      delete scope.window;
      delete scope.sessionStorage;
    }
  });
});
