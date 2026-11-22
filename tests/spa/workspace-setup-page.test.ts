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
    expect(source).not.toContain("useEffect");
  });

  test("uses the ui kit (input + button + flow section), not native controls", () => {
    const imported = /import \{([^}]*)\} from "@design-system";/.exec(source)?.[1] ?? "";
    for (const component of ["Button", "Input", "FlowSection"]) {
      expect(imported, component).toContain(component);
    }
    expect(source).not.toMatch(/<button[\s>]/);
    expect(source).not.toMatch(/<input[\s>]/);
  });

  test("composes the page header and the shared section flow", () => {
    expect(source).toContain("<PageHeader");
    expect(source).toContain("<FlowSection");
    expect(source).toContain("<ListRow");
    expect(source).not.toContain("text-(length:--typo-heading-24-size)");
    expect(source).not.toContain("text-(length:--typo-heading-16-size)");
    expect(source).not.toContain("CardTitle className=");
    expect(source).not.toContain("bg-card");
    expect(source).not.toContain("rounded-lg");
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
    expect(
      creationLanding(201, JSON.stringify({ id: "ws_x", homePath: "/dashboard/ws_x/repos" })),
    ).toBe("/dashboard/ws_x/repos");
    expect(creationLanding(400, "")).toBeNull();
    expect(creationLanding(201, "not json")).toBeNull();
    expect(creationLanding(201, JSON.stringify({ id: "ws_x" }))).toBeNull();
  });

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
    expect(markup).toContain("acme");
    expect(markup).toContain("beta");
    expect(markup).toContain("admin");
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

  test("accept posts under the invited workspace's ref and lands on its repository overview", () => {
    expect(inviteAcceptPath("acme", "inv_1")).toBe("/dashboard/acme/api/members/invites/inv_1/accept");
    expect(inviteLanding("acme")).toBe("/dashboard/acme/repos");
  });

  test("a failed accept maps the refusal body onto a dictionary notice", () => {
    expect(inviteAcceptNotice(409, "invite.expired")).toBe("workspace.inviteExpired");
    expect(inviteAcceptNotice(410, "invite is no longer pending")).toBe("workspace.inviteGone");
    expect(inviteAcceptNotice(500, "")).toBe("workspace.inviteAcceptFailed");
    for (const key of ["workspace.inviteExpired", "workspace.inviteGone", "workspace.inviteAcceptFailed"]) {
      expect(t("en", key as DictionaryKey)).toBeTruthy();
      expect(t("zh_CN", key as DictionaryKey)).toBeTruthy();
    }
  });
});
