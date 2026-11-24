import { describe, expect, test } from "bun:test";
import { act, createElement, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./dom";
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
  MembersList,
  postMemberWrite,
  showsPendingInvites,
} from "../../src/spa/pages/MembersPage";
import type { InviteRow, MemberRow, WorkspaceRole } from "../../src/spa/pages/data";

const invite = (): InviteRow => ({
  id: "i1",
  github_login: "hubot",
  role: "member",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-08T00:00:00Z",
});

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
    expect(showsPendingInvites("owner", [invite()])).toBe(true);
    expect(showsPendingInvites("admin", [invite()])).toBe(true);
    expect(showsPendingInvites("member", [invite()])).toBe(false);
    expect(showsPendingInvites(null, [invite()])).toBe(false);
    expect(showsPendingInvites("owner", [])).toBe(false);
  });

  test("the pending invite 409 surfaces as a warning, not a retryable error", () => {
    expect(inviteFailureNotice(409, "invite.pending_exists", false)).toEqual({
      kind: "warn",
      key: "notice.warn.invitePending",
    });
    expect(inviteFailureNotice(409, "invite.pending_exists", true).kind).toBe("warn");
    expect(inviteFailureNotice(409, "already a member", true).kind).toBe("warn");
    expect(inviteFailureNotice(500, "", false)).toEqual({
      kind: "error",
      key: "notice.error.inviteFailed",
    });
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

describe("members list (rendered)", () => {
  const ROW: MemberRow = {
    id: "u1",
    github_login: "octocat",
    role: "member",
    created_at: "2026-01-02T03:04:05.678Z",
  };

  test("one list row per member, carrying the login, role, join time and its absolute tooltip", () => {
    const relative = formatRelativeTime(ROW.created_at, "en");
    expect(relative).toMatch(/\d+ days ago$/);
    const html = renderToStaticMarkup(
      createElement(MembersList, {
        locale: "en",
        members: [ROW],
        viewerLogin: "octocat",
        memberRole: "owner",
        canInvite: true,
        onAction: () => {},
      }),
    );
    expect(html.match(/data-slot="list-row"/g)).toHaveLength(1);
    expect(html).toContain('data-slot="group-card"');
    expect(html).toContain(`>${ROW.github_login}`);
    expect(html).toContain(t("en", `members.role.${ROW.role}`));
    expect(html).toContain(`title="${ROW.created_at}"`);
    expect(html).toContain(`${t("en", "members.tableJoined")} · ${relative}`);
  });

  test("the viewer's own row renders no actions menu", () => {
    const html = renderToStaticMarkup(
      createElement(MembersList, {
        locale: "en",
        members: [ROW],
        viewerLogin: "octocat",
        memberRole: "owner",
        canInvite: true,
        onAction: () => {},
      }),
    );
    expect(html).toContain(`(${t("en", "members.you")})`);
    expect(html).not.toContain(t("en", "members.actionsMenuLabel", { login: ROW.github_login }));
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
      createElement(WorkspacePanel, {
        locale: "en",
        workspace: FREE,
        memberCount: 4,
        deploymentMode: "saas",
      }),
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
    expect(html).not.toMatch(/upgrade|price|billing|purchase/i);
  });

  test("pro drops the sub-label; a full workspace says No seats left", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        deploymentMode: "saas",
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

  test("the plan label is whatever the workspace prop says (P2 mode split guard)", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        deploymentMode: "saas",
        workspace: { ...FREE, plan: { id: "team", name: "Team plan" } },
        memberCount: 1,
      }),
    );
    expect(html).toContain("Team plan");
    expect(html).not.toContain(t("en", "members.planFreeHint"));
  });

  test("a pending invite occupies a seat: 4 members + 1 pending reads No seats left", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        deploymentMode: "saas",
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
        deploymentMode: "saas",
        workspace: { ...FREE, pendingInvites: 2 },
        memberCount: 2,
      }),
    );
    expect(html).toContain("2 pending invitations");
    expect(html).toContain("1 slot left");
  });

  test("self-hosted drops the plan card and the seat countdown; the meter stays", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        deploymentMode: "self-hosted",
        workspace: { ...FREE, memberLimit: null },
        memberCount: 4,
      }),
    );
    expect(html).toContain(t("en", "members.workspaceHeading"));
    expect(html).not.toContain(t("en", "members.planLabel"));
    expect(html).not.toContain("Free");
    expect(html).toContain(">4<");
    expect(html).toContain(t("en", "members.noMemberLimit"));
    expect(html).not.toContain("4 / 5");
    expect(html).not.toMatch(/slots? left|No seats left/);
    expect(html).toContain(t("en", "members.reviewAttemptsLabel"));
    expect(html).toContain("128");
  });

  test('a null limit reads as no limit in saas too — no arithmetic, no "null"', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        locale: "en",
        deploymentMode: "saas",
        workspace: { ...FREE, plan: { id: "unlimited", name: "Unlimited" }, memberLimit: null },
        memberCount: 4,
      }),
    );
    expect(html).toContain("Unlimited");
    expect(html).toContain(">4<");
    expect(html).toContain(t("en", "members.noMemberLimit"));
    expect(html).not.toContain("/ 5");
    expect(html).not.toContain("null");
    expect(html).not.toMatch(/slots? left|No seats left/);
    expect(html).toContain("128");
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
      expect(deleteRefusal(404)).toEqual({ next: "leave" });
      expect(await deleteWorkspace("/dashboard/acme")).toBe(404);
      expect(redirects).toEqual([]);
      expect(store.size).toBe(0);

      leaveWorkspaceForDashboard();
      expect(redirects).toEqual(["/dashboard"]);
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
      expect(calls).toEqual(["/dashboard/acme/api/workspace/delete"]);
    } finally {
      globalThis.fetch = realFetch;
      delete scope.window;
      delete scope.sessionStorage;
    }
  });

  test("a mounted shell keeps the flash until the pathname changes", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard");
    const paints: string[] = [];
    try {
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
      await render("/dashboard");
      const line = "Workspace deleted. Its Apps are not reviewed.";
      expect(paints[0]!.split(line).length - 1).toBe(1);
      expect(paints[1]!.split(line).length - 1).toBe(1);

      await render("/dashboard/apps");
      await render("/dashboard");
      expect(paints.at(-1)!.split(line).length - 1).toBe(0);
      await act(async () => root.unmount());
    } finally {
      cleanup();
    }
  });

  test("a refused delete picks copy and next move by status", () => {
    expect(deleteRefusal(403)).toEqual({
      next: "reload",
      kind: "warn",
      key: "members.deleteWorkspaceNotOwner",
    });
    expect(deleteRefusal(404)).toEqual({ next: "leave" });
    expect(t("en", "members.deleteWorkspaceNotOwner")).toBe("Only the workspace owner can delete it.");
    expect(t("en", "notice.warn.workspaceUnavailable")).toBe(
      "This workspace is no longer available to you.",
    );
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
