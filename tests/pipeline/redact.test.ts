/**
 * Secret redaction tests (Phase 5 B2 / SEC-02) — the redaction is applied by
 * the consumer choke point before any model-produced text can reach the
 * public PR review body or D1 raw_output. Every secret-shaped pattern is
 * replaced with [REDACTED]; plain text passes through untouched.
 */

import { describe, expect, test } from "bun:test";
import { REDACTED, redactExactSecrets, redactReviewOutput, redactReviewOutputExact, redactSecrets } from "../../src/pipeline/redact";
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

  test("redacts provider-key assignment lines (SEC-01): GEMINI_/GROQ_/XAI_/AZURE_OPENAI_", () => {
    const out = redactSecrets(
      "GEMINI_API_KEY=AIzaSyDummyDummyDummyDummyDummyDummyDummy; GROQ_API_KEY=gsk_dummyDummyDummyDummyDummyDummy; XAI_API_KEY=xai-dummyDummyDummyDummyDummyDummy; AZURE_OPENAI_API_KEY=az-key-123456",
    );
    expect(out).not.toContain("AIzaSyDummy");
    expect(out).not.toContain("gsk_dummy");
    expect(out).not.toContain("xai-dummy");
    expect(out).not.toContain("az-key-123456");
    expect(out).toContain(REDACTED);
  });

  test("redacts forwarded-provider value shapes (SEC-01): AIza…/gsk_…/xai-…", () => {
    const out = redactSecrets(
      "leaked AIzaSyDummyDummyDummyDummyDummyDummyDummyDummy and gsk_dummyDummyDummyDummyDummyDummyDummy and xai-dummyDummyDummyDummyDummyDummyDummy",
    );
    expect(out).not.toContain("AIzaSyDummy");
    expect(out).not.toContain("gsk_dummy");
    expect(out).not.toContain("xai-dummy");
    expect(out).toContain(REDACTED);
  });

  test("redacts long hex strings (40+ chars)", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(redactSecrets(hex)).toBe(REDACTED);
  });
});

describe("redactExactSecrets", () => {
  test("replaces every occurrence of each distinct non-empty value", () => {
    const out = redactExactSecrets(
      "key=abc123 and again abc123; other=xyz789",
      ["abc123", "xyz789"],
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz789");
    expect(out).toContain(REDACTED);
  });

  test("empty value list → text unchanged; empty values skipped", () => {
    expect(redactExactSecrets("plain text", [])).toBe("plain text");
    expect(redactExactSecrets("plain text", ["", "  "])).toBe("plain text");
  });

  test("a UUID-shaped value that evades every shape pattern is still removed", () => {
    const uuid = "3f2a1b4c-9d8e-4f6a-b7c2-1e0d9a8b7c6d";
    const out = redactExactSecrets(`leaked ${uuid} here`, [uuid]);
    expect(out).not.toContain(uuid);
    expect(out).toContain(REDACTED);
  });
});

describe("redactReviewOutput", () => {
  // F-001: EVERY model-controlled string that reaches the public comment or
  // the D1 envelope passes through redactSecrets — including finding
  // title/category/file_path/fingerprint_hint and tally.chatHeader, not
  // just summary_md/finding bodies.
  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "blocked",
    summary_md: "Provider key leaked here: AKIAIOSFODNN7EXAMPLE",
    tally: {
      verdict: "blocked",
      scorePct: 0,
      tally: { mustFix: 1, shouldFix: 0, nit: 0, unverified: 0 },
      chatHeader: "chat: ghp_abcdef1234567890",
    },
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
      {
        mergeClass: "should-fix",
        title: "Exfil via TOKEN sk-proj-abcdefghijklmnopqrstuvwx",
        body: "Bearer ghs_zzz at AKIAIOSFODNN7EXAMPLE",
        category: "AKIAIOSFODNN7EXAMPLE leak",
        file_path: "evil/AKIAIOSFODNN7EXAMPLE/x.ts",
        fingerprint_hint: "x.ts:1 ghp_abcdef1234567890",
      },
    ],
  };

  test("redacts every model-controlled field, keeping structure", () => {
    const redacted = redactReviewOutput(output);
    expect(redacted.summary_md).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.findings[0]!.body).not.toContain("ghp_abcdef1234567890");
    expect(redacted.findings[1]!.title).not.toContain("sk-proj-");
    expect(redacted.findings[1]!.body).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.findings[1]!.category).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.findings[1]!.file_path).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.findings[1]!.fingerprint_hint).not.toContain("ghp_abcdef1234567890");
    expect(redacted.tally!.chatHeader).not.toContain("ghp_abcdef1234567890");
    expect(redacted.findings[0]!.mergeClass).toBe("must-fix");
    expect(redacted.findings[0]!.line_start).toBe(1);
    expect(redacted.tally!.tally.mustFix).toBe(1);
    expect(redacted.verdict).toBe("blocked");
  });
});

describe("redactReviewOutputExact", () => {
  test("exact-value second pass removes the session's actual secret values from every model-controlled field", () => {
    const uuid = "3f2a1b4c-9d8e-4f6a-b7c2-1e0d9a8b7c6d";
    const withSecret: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "blocked",
      summary_md: `key ${uuid} leaked`,
      findings: [
        {
          mergeClass: "must-fix",
          title: `token ${uuid}`,
          body: `body ${uuid}`,
          category: uuid,
          file_path: `x/${uuid}.ts`,
          fingerprint_hint: uuid,
        },
      ],
    };
    const redacted = redactReviewOutputExact(withSecret, [uuid]);
    expect(redacted.summary_md).not.toContain(uuid);
    expect(redacted.findings[0]!.title).not.toContain(uuid);
    expect(redacted.findings[0]!.body).not.toContain(uuid);
    expect(redacted.findings[0]!.category).not.toContain(uuid);
    expect(redacted.findings[0]!.file_path).not.toContain(uuid);
    expect(redacted.findings[0]!.fingerprint_hint).not.toContain(uuid);
    expect(redacted.verdict).toBe("blocked");
    expect(redacted.findings[0]!.mergeClass).toBe("must-fix");
  });

  test("empty value list → output unchanged", () => {
    const clean: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "blocked",
      summary_md: "clean summary",
      findings: [{ mergeClass: "nit", title: "Note", body: "Body." }],
    };
    const redacted = redactReviewOutputExact(clean, []);
    expect(redacted.summary_md).toBe(clean.summary_md);
    expect(redacted.findings[0]!.title).toBe(clean.findings[0]!.title);
  });
});
