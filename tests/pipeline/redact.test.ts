/**
 * Secret redaction tests (Phase 5 B2 / SEC-02) — the redaction is applied by
 * the consumer choke point before any model-produced text can reach the
 * public PR review body or D1 raw_output. Every secret-shaped pattern is
 * replaced with [REDACTED]; plain text passes through untouched.
 */

import { describe, expect, test } from "bun:test";
import { REDACTED, redactReviewOutput, redactSecrets } from "../../src/pipeline/redact";
import type { ReviewOutput } from "../../src/review/schema";

describe("redactSecrets", () => {
  test("redacts PEM private-key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0knMOmVG1RgE2nDn2\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe(REDACTED);
    expect(redactSecrets(pem)).not.toContain("MIIEow");
  });

  test("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer ghs_abcdef1234567890";
    const out = redactSecrets(text);
    expect(out).not.toContain("Bearer ghs_");
    expect(out).toContain(REDACTED);
  });

  test("redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/github_pat_)", () => {
    const out = redactSecrets(
      "tokens: ghp_abcdef1234567890 gho_abcdef1234567890 ghu_abcdef1234567890 ghs_abcdef1234567890 github_pat_abcdefghijklmnop",
    );
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("gho_");
    expect(out).not.toContain("ghu_");
    expect(out).not.toContain("ghs_");
    expect(out).not.toContain("github_pat_");
  });

  test("redacts OpenAI-style sk- keys", () => {
    const out = redactSecrets("key=sk-proj-abcdefghijklmnopqrstuvwx");
    expect(out).not.toContain("sk-proj-");
  });

  test("redacts AWS access key ids (AKIA…)", () => {
    const out = redactSecrets("AKIAIOSFODNN7EXAMPLE is an access key id");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain(REDACTED);
  });

  test("redacts key/secret assignment references", () => {
    const out = redactSecrets(
      "ARK_API_KEY=ark-abc123; API_KEY \"supersecret\"; TOKEN: sk-xyz; SECRET = hunter2",
    );
    expect(out).not.toContain("ark-abc123");
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("sk-xyz");
    expect(out).not.toContain("hunter2");
  });

  test("redacts long hex strings (40+ chars)", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(redactSecrets(hex)).toBe(REDACTED);
  });

  test("leaves ordinary prose untouched", () => {
    const text = "The token endpoint returned a 401 for the review comment.";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactReviewOutput", () => {
  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "blocked",
    summary_md: "Provider key leaked here: AKIAIOSFODNN7EXAMPLE",
    findings: [
      {
        mergeClass: "must-fix",
        category: "security",
        file_path: "src/auth.ts",
        line_start: 1,
        line_end: 1,
        title: "Leak",
        body: "secret = ghp_abcdef1234567890",
      },
    ],
  };

  test("redacts summary_md and every finding body, keeping structure", () => {
    const redacted = redactReviewOutput(output);
    expect(redacted.summary_md).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.findings[0]!.body).not.toContain("ghp_abcdef1234567890");
    expect(redacted.findings[0]!.title).toBe("Leak");
    expect(redacted.findings[0]!.mergeClass).toBe("must-fix");
    expect(redacted.verdict).toBe("blocked");
  });
});
