/**
 * The page's workspace API base. ONE derivation from `location.pathname`:
 * a workspace-scoped shell reads that workspace's API family, every legacy
 * page keeps the `/dashboard` mount. No document location (static render,
 * tests) is the legacy base.
 */
import { describe, expect, test } from "bun:test";
import { RESERVED_WORKSPACE_SLUGS } from "../../src/spa/routes";
import { apiBase } from "../../src/spa/workspace-base";

describe("apiBase", () => {
  test("a workspace-scoped page reads its own prefix", () => {
    expect(apiBase("/dashboard/acme/apps")).toBe("/dashboard/acme");
    expect(apiBase("/dashboard/acme/apps/acme-app")).toBe("/dashboard/acme");
    expect(apiBase("/dashboard/acme/apps/acme-app/settings")).toBe("/dashboard/acme");
  });

  test("legacy pages keep the /dashboard mount", () => {
    expect(apiBase("/dashboard")).toBe("/dashboard");
    expect(apiBase("/dashboard/apps")).toBe("/dashboard");
    expect(apiBase("/dashboard/apps/acme-app")).toBe("/dashboard");
    expect(apiBase("/dashboard/apps/acme-app/settings")).toBe("/dashboard");
    expect(apiBase("/dashboard/members")).toBe("/dashboard");
    expect(apiBase("/dashboard/login")).toBe("/dashboard");
    // A static asset hit is not a workspace page.
    expect(apiBase("/index.html")).toBe("/dashboard");
  });

  test("a reserved first segment is never a workspace prefix", () => {
    for (const word of RESERVED_WORKSPACE_SLUGS) {
      expect(apiBase(`/dashboard/${word}/apps`), word).toBe("/dashboard");
    }
  });

  test("without a document location the legacy base is the honest default", () => {
    expect(apiBase()).toBe("/dashboard");
  });
});
