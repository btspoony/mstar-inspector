/**
 * Workspace creation page (plan 97 T3) — the signed-in landing for a login
 * that belongs to no workspace yet. Source-scan contract (no DOM runner), the
 * members/settings page precedent: the surface must offer exactly one action
 * (the creation POST) and must not invent an auto-join path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t, type DictionaryKey } from "../../src/i18n";

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

  test("success navigates back to the shell so the boot picks the new membership up", () => {
    expect(source).toContain('window.location.replace("/dashboard")');
  });
});
