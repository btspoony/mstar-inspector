/**
 * Unit tests for the gateway process entry guard (plan 01 fix round 1, QC F-A).
 *
 * Probot silently falls back to the public default HMAC secret "development"
 * when the webhook secret is falsy — the startup guard must fail closed for
 * both the empty case and the default value itself.
 *
 * Importing src/server.ts must not bind a port or exit the process
 * (`import.meta.main` guard); only the exported guard is exercised here.
 */

import { describe, expect, test } from "bun:test";
import { validateWebhookSecret } from "../../src/server";

describe("validateWebhookSecret (startup guard)", () => {
  test("rejects an empty WEBHOOK_SECRET", () => {
    expect(() => validateWebhookSecret("")).toThrow(/WEBHOOK_SECRET/);
  });

  test("rejects the Probot default secret 'development'", () => {
    expect(() => validateWebhookSecret("development")).toThrow(/WEBHOOK_SECRET/);
  });

  test("accepts a non-empty, non-default secret", () => {
    expect(() => validateWebhookSecret("a-real-webhook-secret")).not.toThrow();
  });
});
