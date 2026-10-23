/**
 * Workspace creation page — the signed-in landing for a login
 * that belongs to no workspace yet. Source-scan contract (no DOM runner), the
 * members/settings page precedent: the surface must offer exactly one action
 * (the creation POST) and must not invent an auto-join path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t, type DictionaryKey } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { WorkspaceSetupPage, creationLanding, inviteAcceptPath, inviteAcceptNotice, inviteLanding } from "../../src/spa/pages/WorkspaceSetupPage";

const source = readFileSync(
  join(import.meta.dir, "../../src/spa/pages/WorkspaceSetupPage.tsx"),
  "utf8",
);

describe("workspace creation page", () => {
  test("posts the creation route and mounts no background fetch", () => {
    expect(source).toContain('postForm("/dashboard/api/workspaces"');
    // The page loads nothing on mount: creation and the invite accepts are
    // the only membership producers, both user-triggered.
    expect(source).not.toContain("useEffect");
  });

  test("uses the ui kit (input + button + card), not native controls", () => {
    for (const component of ["input", "button", "card"]) {
      expect(source).toContain(`@/components/ui/${component}`);
    }
    expect(source).not.toMatch(/<button[\s>]/);
    expect(source).not.toMatch(/<input[\s>]/);
  });

  test("copy is single-sourced through the dictionary in both locales", () => {
    const keys: DictionaryKey[] = [
      "workspace.setupHeading",
      "workspace.setupDescription",
      "workspace.nameLabel",
      "workspace.create",
      "workspace.nameRequired",
      "workspace.nameTooLong",
      "workspace.createFailed",
    ];
    for (const key of keys) {
      expect(source).toContain(`"${key}"`);
      expect(t("en", key, { max: 80 }), `en ${key}`).toBeTruthy();
      expect(t("zh_CN", key, { max: 80 }), `zh_CN ${key}`).toBeTruthy();
    }
  });

  test("success lands on the workspace the response names, never on the bare root", () => {
    // The page cannot compute the target: it does not know the tenant mode.
    expect(creationLanding(201, JSON.stringify({ id: "ws_x", appsPath: "/dashboard/ws_x/apps" }))).toBe(
      "/dashboard/ws_x/apps",
    );
    // `off` serves no workspace routes; the server names the legacy list.
    expect(creationLanding(201, JSON.stringify({ id: "ws_x", appsPath: "/dashboard/apps" }))).toBe(
      "/dashboard/apps",
    );
    // A refusal or an unparseable body is a failure notice, never a navigation.
    expect(creationLanding(400, "")).toBeNull();
    expect(creationLanding(201, "not json")).toBeNull();
    expect(creationLanding(201, JSON.stringify({ id: "ws_x" }))).toBeNull();
  });

  /**
   * `emptyInstance` is the ONLY gate on the empty-instance guidance (2026-10):
   * the Worker decides it from `DEPLOYMENT_MODE` + an empty `users` table, and
   * the page renders the sentence from that flag alone. The flag's own matrix
   * lives in `tests/worker/deployment-mode.test.ts`; this pins that the flag —
   * and nothing else in the boot — controls the sentence.
   */
  test("renders the empty-instance guidance only when the boot carries emptyInstance", () => {
    const base: SpaBoot = { locale: "en", login: "founder", name: null, needsWorkspace: true };
    const plain = renderToStaticMarkup(createElement(WorkspaceSetupPage, { boot: base }));
    const empty = renderToStaticMarkup(
      createElement(WorkspaceSetupPage, { boot: { ...base, emptyInstance: true } }),
    );
    expect(plain).not.toContain("no accounts yet");
    expect(empty).toContain("no accounts yet");
  });
});

/**
 * MF-2 — the invitee's accept surface. The boot carries `pendingInvites`,
 * so the creation page (the `needsWorkspace` landing) must offer the Accept
 * action; a login with no invites still sees only the create form.
 */
describe("workspace creation page — pending invitations", () => {
  const inviteeBoot: SpaBoot = {
    locale: "en",
    login: "invitee",
    name: null,
    needsWorkspace: true,
    pendingInvites: [
      { workspaceRef: "acme", inviteId: "inv_1", role: "admin", expiresAt: "2099-01-01T00:00:00Z" },
      { workspaceRef: "beta", inviteId: "inv_2", role: "member", expiresAt: "2099-01-01T00:00:00Z" },
    ],
  };

  test("an invitee sees the invite list with workspace, role and Accept", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceSetupPage, { boot: inviteeBoot }));
    // Each invite names its workspace and invited role, with an Accept
    // action per row — and the create form stays below for the uninvited.
    expect(markup).toContain("acme");
    expect(markup).toContain("beta");
    expect(markup).toContain("admin");
    // "Accept" also appears in the description copy — count the buttons.
    expect(markup.match(/>Accept</g)).toHaveLength(2);
    expect(markup).toContain(t("en", "workspace.invitesHeading"));
  });

  test("a login with no invites sees the create form and no Accept action", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceSetupPage, {
        boot: { locale: "en", login: "founder", name: null, needsWorkspace: true },
      }),
    );
    expect(markup).toContain(t("en", "workspace.setupHeading"));
    expect(markup).not.toContain(t("en", "workspace.invitesHeading"));
    expect(markup).not.toContain(t("en", "workspace.inviteAccept"));
  });

  test("accept posts under the invited workspace's ref and lands on its Apps page", () => {
    // The invite row carries the ref — the `needsWorkspace` path names none,
    // so the POST must address the invite's workspace prefix.
    expect(inviteAcceptPath("acme", "inv_1")).toBe("/dashboard/acme/api/members/invites/inv_1/accept");
    expect(inviteLanding("acme")).toBe("/dashboard/acme/apps");
  });

  test("a failed accept maps the refusal body onto a dictionary notice", () => {
    // 409 `invite.expired` and 410 "no longer pending" keep their distinct
    // reasons; anything else is the generic failure face.
    expect(inviteAcceptNotice(409, "invite.expired")).toBe("workspace.inviteExpired");
    expect(inviteAcceptNotice(410, "invite is no longer pending")).toBe("workspace.inviteGone");
    expect(inviteAcceptNotice(500, "")).toBe("workspace.inviteAcceptFailed");
    for (const key of ["workspace.inviteExpired", "workspace.inviteGone", "workspace.inviteAcceptFailed"]) {
      expect(t("en", key as DictionaryKey)).toBeTruthy();
      expect(t("zh_CN", key as DictionaryKey)).toBeTruthy();
    }
  });
});
