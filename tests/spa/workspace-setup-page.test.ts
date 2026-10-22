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
import { WorkspaceSetupPage, creationLanding } from "../../src/spa/pages/WorkspaceSetupPage";

const source = readFileSync(
  join(import.meta.dir, "../../src/spa/pages/WorkspaceSetupPage.tsx"),
  "utf8",
);

describe("workspace creation page", () => {
  test("posts the creation route and offers no second path into a workspace", () => {
    expect(source).toContain('postForm("/dashboard/api/workspaces"');
    // Creation is the only membership producer here: no invite-accept call, no
    // workspace listing, no auto-join on mount.
    expect(source).not.toContain("/api/members/invites");
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
