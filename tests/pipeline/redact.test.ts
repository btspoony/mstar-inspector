/**
 * Secret redaction tests (Phase 5 B2 / SEC-02) — the redaction is applied by
 * the consumer choke point before any model-produced text can reach the
 * public PR review body or D1 raw_output. Every secret-shaped pattern is
 * replaced with [REDACTED]; plain text passes through untouched.
 */

import { describe, expect, test } from "bun:test";
import {
  REDACTED,
  redactDocument,
  redactExactSecrets,
  redactReviewOutput,
  redactReviewOutputExact,
  redactSecrets,
  secretTransforms,
  skippedSecrets,
} from "../../src/pipeline/redact";
import { buildReviewBody } from "../../src/pipeline/comment";
import type { ReviewOutput } from "../../src/review/schema";
import { sk, gh, AWS_CANARY_KEY, pemBanner } from "../helpers/fake-secrets";

describe("redactSecrets", () => {
  test("redacts PEM private-key blocks", () => {
    const pem =
      pemBanner("BEGIN", "RSA PRIVATE KEY") + "\nMIIEowIBAAKCAQEA0knMOmVG1RgE2nDn2\n" + pemBanner("END", "RSA PRIVATE KEY");
    expect(redactSecrets(pem)).toBe(REDACTED);
    expect(redactSecrets(pem)).not.toContain("MIIEow");
  });

  test("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer " + gh("s", "abcdef1234567890");
    const out = redactSecrets(text);
    expect(out).not.toContain("Bearer ghs_");
    expect(out).toContain(REDACTED);
  });

  test("redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/github_pat_)", () => {
    const out = redactSecrets(
      "tokens: " + gh("p", "abcdef1234567890") + " " + gh("o", "abcdef1234567890") + " " + "ghu_" + "abcdef1234567890" + " " + gh("s", "abcdef1234567890") + " github_" + "pat_abcdefghijklmnop",
    );
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("gho_");
    expect(out).not.toContain("ghu_");
    expect(out).not.toContain("ghs_");
    expect(out).not.toContain("github_pat_");
  });

  test("redacts OpenAI-style sk- keys", () => {
    const out = redactSecrets("key=" + sk("proj-abcdefghijklmnopqrstuvwx"));
    expect(out).not.toContain(sk("proj-"));
  });

  test("redacts AWS access key ids (AKIA…)", () => {
    const out = redactSecrets(AWS_CANARY_KEY + " is an access key id");
    expect(out).not.toContain(AWS_CANARY_KEY);
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

describe("redactDocument", () => {
  const SECRET = "sk-live/paid-session-secret-01";
  const forms = secretTransforms(SECRET);

  test("secretTransforms is the bounded set and carries no escape form", () => {
    const one = secretTransforms("p/a b");
    expect(one.raw).toBe("p/a b");
    expect(one.urlEncoded).toBe("p%2Fa%20b");
    expect(one.base64).toBe("cC9hIGI=");
    expect(one.base64url).toBe("cC9hIGI");
    expect(one.hex).toBe("702f612062");
    // JSON escaping is the PARSER's job: no `\uXXXX`/`\/` form exists here.
    expect(Object.keys(one).sort()).toEqual(["base64", "base64url", "hex", "raw", "urlEncoded"]);
  });

  test("removes every transform from nested leaves, leaving non-strings untouched", () => {
    const injected = [forms.raw, forms.urlEncoded, forms.base64, forms.base64url, forms.hex];
    const payload = {
      findings: [{ body: injected.join(" ") }],
      rejected: new Set(injected.map((form, index) => `row${index}:${form}`)),
      report: null,
      passed: true,
      score: 0.5,
    };

    const outcome = redactDocument(payload, [SECRET], "text");

    expect(outcome.value.findings[0]?.body).toBe(Array(5).fill("[redacted]").join(" "));
    expect([...outcome.value.rejected]).toEqual(injected.map((_, index) => `row${index}:[redacted]`));
    expect(outcome.value.passed).toBe(true);
    expect(outcome.value.score).toBe(0.5);
    expect(outcome.value.report).toBeNull();
    expect(outcome.replaced).toBe(10);
  });

  test("a forged identity field in model text is redacted; the host path is not", () => {
    const secret = "abcdefgh";
    const envelope = JSON.stringify({
      target: { head_sha: secret },
      summary_md: `{"head_sha":"${secret}"}`,
      findings: [{ body: `only ${secret}` }],
    });

    const outcome = redactDocument(envelope, [secret], "run");
    // Fixture shape is ours: the envelope serialized above.
    const redacted = JSON.parse(outcome.value) as {
      target: { head_sha: string };
      summary_md: string;
      findings: { body: string }[];
    };

    // The host-written path is byte-identical.
    expect(redacted.target.head_sha).toBe(secret);
    // Forged text — in a string and inside an array — is redacted like any leaf.
    expect(redacted.summary_md).toBe('{"head_sha":"[redacted]"}');
    expect(redacted.findings[0]?.body).toBe("only [redacted]");
  });

  test("the recheck document protects its identity paths and redacts everything else", () => {
    const secret = "abcdefgh";
    const recheck = {
      doc: {
        schema: "mstar.recheck/v1",
        headSha: secret,
        results: [
          {
            rowId: secret,
            disposition: "addressed",
            reason: "verified-fix",
            evidence: { sliceId: secret, startLine: 1, endLine: 2, quote: secret },
          },
        ],
      },
      docFailure: null,
      rejected: new Set([`row:${secret}`]),
      anonymousRejectedRows: 0,
      status: { schema: "mstar.recheck-status/v1", headSha: secret },
    };

    const outcome = redactDocument(recheck, [secret], "recheck");

    expect(outcome.value.doc.headSha).toBe(secret);
    expect(outcome.value.doc.results[0]?.rowId).toBe(secret);
    expect(outcome.value.doc.results[0]?.evidence.sliceId).toBe(secret);
    expect(outcome.value.status.headSha).toBe(secret);
    // Everything off the table is model text.
    expect(outcome.value.doc.results[0]?.evidence.quote).toBe("[redacted]");
    expect([...outcome.value.rejected]).toEqual(["row:[redacted]"]);
  });

  test("a model-printed marker shields nothing and the marker survives", () => {
    const outcome = redactDocument("x[redacted]abcdefgh", ["abcdefgh"], "text");

    expect(outcome.value).toBe("x[redacted][redacted]");
    expect(outcome.replaced).toBe(1);
  });

  test("a mixed escape echo decodes before matching (`\\u002f`, `\\/`)", () => {
    const unicodeEcho = '{"summary_md":"abc\\u002fdefg"}';
    const slashEcho = '{"summary_md":"abc\\/defg"}';

    expect(redactDocument(unicodeEcho, ["abc/defg"], "run").value).toBe(
      '{"summary_md":"[redacted]"}',
    );
    expect(redactDocument(slashEcho, ["abc/defg"], "run").value).toBe(
      '{"summary_md":"[redacted]"}',
    );
  });

  test("a whitespace-padded document is decoded, and keeps its bytes when nothing matches", () => {
    const envelope = '\n  {"summary_md":"abc\\u002fdefg"}\n';

    const outcome = redactDocument(envelope, ["abc/defg"], "run");
    expect(outcome.replaced).toBe(1);
    // Documented consequence: a re-serialized document loses that padding.
    expect(outcome.value).toBe('{"summary_md":"[redacted]"}');

    expect(redactDocument(envelope, ["sk-unrelated-credential-0001"], "run").value).toBe(envelope);
  });

  test("is idempotent for the sequences that failed before", () => {
    const secrets = ["x[redact", "abcdefgh"];
    const first = redactDocument({ text: "xabcdefgh" }, secrets, "text");
    expect(first.value).toEqual({ text: "x[redacted]" });
    const second = redactDocument(first.value, secrets, "text");
    expect(second.value).toEqual(first.value);
    expect(second.replaced).toBe(0);

    // The marker is a fixed point too: parking it means nothing matches inside.
    const marked = redactDocument({ text: "x[redacted]abcdefgh" }, secrets, "text");
    const again = redactDocument(marked.value, secrets, "text");
    expect(again.value).toEqual(marked.value);
    expect(again.replaced).toBe(0);
  });

  test("a short credential is never applied and is counted once per distinct value", () => {
    expect(skippedSecrets(["abc"])).toBe(1);
    expect(skippedSecrets(["abc", "abc", "", "abcdefgh"])).toBe(1);

    const envelope = JSON.stringify({
      target: { head_sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca" },
      note: "abc",
    });
    const outcome = redactDocument(envelope, ["abc"], "run");
    expect(outcome.value).toBe(envelope);
    expect(outcome.replaced).toBe(0);
  });

  test("a payload with no secret present keeps its exact bytes", () => {
    const envelope = JSON.stringify({
      target: { head_sha: "a".repeat(40) },
      score: 0.5,
      ok: true,
    });

    // The runner's document round-trips byte-for-byte, so nothing is reshaped.
    expect(JSON.stringify(JSON.parse(envelope))).toBe(envelope);
    expect(redactDocument(envelope, [], "run").value).toBe(envelope);
    const unrelated = redactDocument(envelope, ["sk-unrelated-credential-0001"], "run");
    expect(unrelated.value).toBe(envelope);
    expect(unrelated.replaced).toBe(0);
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
    summary_md: "Provider key leaked here: " + AWS_CANARY_KEY,
    tally: {
      verdict: "blocked",
      scorePct: 0,
      tally: { mustFix: 1, shouldFix: 0, nit: 0 },
      chatHeader: "chat: " + gh("p", "abcdef1234567890"),
    },
    findings: [
      {
        mergeClass: "must-fix",
        category: "security",
        file_path: "src/auth.ts",
        line_start: 1,
        line_end: 1,
        title: "Leak",
        body: "secret = " + gh("p", "abcdef1234567890"),
      },
      {
        mergeClass: "should-fix",
        title: "Exfil via TOKEN " + sk("proj-abcdefghijklmnopqrstuvwx"),
        body: "Bearer " + gh("s", "zzz") + " at " + AWS_CANARY_KEY,
        category: AWS_CANARY_KEY + " leak",
        file_path: "evil/" + AWS_CANARY_KEY + "/x.ts",
        fingerprint_hint: "x.ts:1 " + gh("p", "abcdef1234567890"),
      },
    ],
  };

  test("redacts every model-controlled field, keeping structure", () => {
    const redacted = redactReviewOutput(output);
    expect(redacted.summary_md).not.toContain(AWS_CANARY_KEY);
    expect(redacted.findings[0]!.body).not.toContain(gh("p", "abcdef1234567890"));
    expect(redacted.findings[1]!.title).not.toContain(sk("proj-"));
    expect(redacted.findings[1]!.body).not.toContain(AWS_CANARY_KEY);
    expect(redacted.findings[1]!.category).not.toContain(AWS_CANARY_KEY);
    expect(redacted.findings[1]!.file_path).not.toContain(AWS_CANARY_KEY);
    expect(redacted.findings[1]!.fingerprint_hint).not.toContain(gh("p", "abcdef1234567890"));
    expect(redacted.tally!.chatHeader).not.toContain(gh("p", "abcdef1234567890"));
    expect(redacted.findings[0]!.mergeClass).toBe("must-fix");
    expect(redacted.findings[0]!.line_start).toBe(1);
    expect(redacted.tally!.tally.mustFix).toBe(1);
    expect(redacted.verdict).toBe("blocked");
  });

  // F-001: the `incomplete` fact is model-controlled text — buildReviewBody
  // interpolates `reason` and `unscanned` into the public comment and the
  // consumer stores the same object in D1, so both fields pass this choke
  // point (envelope fact AND its tally echo).
  test("redacts the incomplete fact's reason, every unscanned entry and its tally echo", () => {
    const token = gh("p", "abcdef1234567890");
    const fact = { reason: `provider key ${token} expired`, unscanned: ["src/auth.ts", `tools/${token}/x.ts`] };
    const stopped: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "incomplete",
      summary_md: "Run stopped early.",
      tally: {
        verdict: "incomplete",
        scorePct: 0,
        tally: { mustFix: 0, shouldFix: 0, nit: 0 },
        chatHeader: "chat",
        incomplete: fact,
      },
      incomplete: { reason: fact.reason, unscanned: [...fact.unscanned] },
      findings: [],
    };

    const redacted = redactReviewOutput(stopped);
    expect(redacted.incomplete!.reason).toBe(`provider key ${REDACTED} expired`);
    // No entry is trimmed, dropped or reordered: only the secret span goes.
    expect(redacted.incomplete!.unscanned).toEqual([`src/auth.ts`, `tools/${REDACTED}/x.ts`]);
    expect(redacted.tally!.incomplete!.reason).toBe(`provider key ${REDACTED} expired`);
    expect(redacted.tally!.incomplete!.unscanned).toEqual([`src/auth.ts`, `tools/${REDACTED}/x.ts`]);
    // The rendered public comment carries the redacted strings only.
    expect(buildReviewBody(redacted)).not.toContain(token);
  });

  test("keeps an absent fact absent and an empty unscanned list empty", () => {
    const accepted = redactReviewOutput(output);
    expect(Object.hasOwn(accepted, "incomplete")).toBe(false);
    expect(Object.hasOwn(accepted.tally!, "incomplete")).toBe(false);

    const emptyScope = redactReviewOutput({
      schema: "mstar.review/v1",
      verdict: "incomplete",
      summary_md: "Timed out.",
      incomplete: { reason: "provider request timed out", unscanned: [] },
      findings: [],
    });
    expect(emptyScope.incomplete).toEqual({ reason: "provider request timed out", unscanned: [] });
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

  // F-001: a credential that evades every shape pattern in reason/unscanned
  // is still removed verbatim, at the envelope fact and its tally echo.
  test("removes the session's actual secret values from the incomplete fact and its tally echo", () => {
    const uuid = "3f2a1b4c-9d8e-4f6a-b7c2-1e0d9a8b7c6d";
    const fact = { reason: `cache key ${uuid} rejected`, unscanned: [`a/${uuid}.ts`, "src/clean.ts"] };
    const stopped: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "incomplete",
      summary_md: "Run stopped early.",
      tally: {
        verdict: "incomplete",
        scorePct: 0,
        tally: { mustFix: 0, shouldFix: 0, nit: 0 },
        chatHeader: "chat",
        incomplete: fact,
      },
      incomplete: { reason: fact.reason, unscanned: [...fact.unscanned] },
      findings: [],
    };

    const redacted = redactReviewOutputExact(stopped, [uuid]);
    expect(redacted.incomplete!.reason).toBe(`cache key ${REDACTED} rejected`);
    expect(redacted.incomplete!.unscanned).toEqual([`a/${REDACTED}.ts`, "src/clean.ts"]);
    expect(redacted.tally!.incomplete!.reason).toBe(`cache key ${REDACTED} rejected`);
    expect(redacted.tally!.incomplete!.unscanned).toEqual([`a/${REDACTED}.ts`, "src/clean.ts"]);
    expect(buildReviewBody(redacted)).not.toContain(uuid);
  });
});
