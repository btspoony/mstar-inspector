/**
 * Review comment assembly + posting (plan 06 Task 3).
 *
 * Assembly (pure, unit-tested):
 *   - summary_md truncated to 8000 chars (plan Task 3 budget);
 *   - findings rendered as a markdown list with severity/category rendered
 *     VERBATIM from the schema enums (plan Global Constraints: the Comment
 *     must not rewrite enum semantics);
 *   - NO line-comment fields: the body is a single overall review comment
 *     (plan Done criteria: the posting path uses the Reviews API, not the
 *     line-comments API);
 *   - verdict rendered as text in the body header (`**Verdict: …**`).
 *
 * Posting: GitHub Reviews API via @octokit/rest + createAppAuth (same deps
 * and pattern as 04's diff.ts — the auth factory is invoked separately here
 * because pipeline MUST NOT import src/worker/** and no shared module is
 * extracted per plan). Every review is posted with event "COMMENT" (SEC-01
 * fix): the model verdict can be prompt-injected, so it must NEVER map onto
 * GitHub APPROVE/REQUEST_CHANGES (merge-gate/block privileges). The model
 * verdict is rendered as text in the body header instead.
 *
 * Secrets: APP_ID/PRIVATE_KEY come from the Worker env; the installation
 * token is minted in memory and never logged or stored (compass D).
 * Model-produced text (summary/finding bodies) is redacted BEFORE it reaches
 * this module (consumer choke point, SEC-02 fix) so a prompt-injected token
 * can never appear in the public review body or D1 raw_output.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { ReviewFinding, ReviewOutput } from "../review/schema";

/** GitHub review event for every posting (SEC-01 fix — never APPROVE/REQUEST_CHANGES). */
export const REVIEW_EVENT = "COMMENT" as const;

/** summary_md budget for the overall review body (plan Task 3). */
export const SUMMARY_MD_LIMIT = 8000;

/** Truncate summary_md to the body budget (char-based; GitHub counts chars). */
export function truncateSummary(md: string, limit: number = SUMMARY_MD_LIMIT): string {
  return md.length <= limit ? md : `${md.slice(0, limit - 1)}…`;
}

/**
 * Render findings as a markdown list. Severity/category are emitted verbatim
 * (enum SSOT); location is `file_path[:line_start]` or "repo-wide" when the
 * finding is not file-scoped. Empty findings → empty string (no section).
 */
export function renderFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((finding, index) => {
    const location = finding.file_path
      ? `${finding.file_path}${finding.line_start != null ? `:${finding.line_start}` : ""}`
      : "repo-wide";
    const body = finding.body ? `\n\n${finding.body}` : "";
    return `${index + 1}. **[${finding.severity}] ${finding.title}** (${finding.category}) — ${location}${body}`;
  });
  return `## Findings\n\n${lines.join("\n\n")}`;
}

/**
 * Assemble the overall review body: verdict header + truncated summary +
 * findings section + optional omitted-findings footer. `omittedFindings` is
 * the count of findings dropped by the consumer's severity cap (B4) — the
 * footer tells readers the review is a Top-N subset.
 */
export function buildReviewBody(output: ReviewOutput, omittedFindings = 0): string {
  const verdict = `**Verdict: ${output.verdict}**`;
  const summary = truncateSummary(output.summary_md);
  const findings = renderFindings(output.findings);
  const body = findings ? `${verdict}\n\n${summary}\n\n${findings}` : `${verdict}\n\n${summary}`;
  return omittedFindings > 0 ? `${body}\n\n*(+${omittedFindings} more findings omitted)*` : body;
}

// ---------------------------------------------------------------------------
// Auth + posting (self-contained; pipeline ↛ worker, no shared module).
// ---------------------------------------------------------------------------

/** DER tag for a SEQUENCE (0x30). */
const DER_SEQUENCE = 0x30;
/** DER tag for an OCTET STRING (0x04). */
const DER_OCTET_STRING = 0x04;
/** DER tag for an INTEGER (0x02). */
const DER_INTEGER = 0x02;
/** DER tag for an OBJECT IDENTIFIER (0x06). */
const DER_OID = 0x06;
/** DER tag for NULL (0x05). */
const DER_NULL = 0x05;
/** rsaEncryption OID (1.2.840.113549.1.1.1) — the only algorithm PKCS#1 keys use. */
const RSA_ENCRYPTION_OID = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
/** PKCS#8 version 0 (single-version, no attributes). */
const PKCS8_VERSION_ZERO = new Uint8Array([0x00]);

/** DER length encoding: short form (< 0x80) or long form (0x80 | byte count). */
function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** DER TLV element: tag byte + length + body. */
function derElement(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** Concatenate byte arrays (DER building blocks). */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Base64 → bytes (PEM body decoding; `atob` is available in Bun and workerd). */
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Bytes → base64 (PEM body encoding). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Wrap a PKCS#1 RSA private key DER in a PKCS#8 `PrivateKeyInfo` container
 * (version 0, rsaEncryption algorithm, OCTET STRING payload). Pure JS — no
 * `node:crypto` — so Bun and workerd behave identically. The output is
 * byte-identical to `openssl pkcs8 -topk8 -nocrypt` for RSA keys (same
 * algorithm as 04's diff.ts; duplicated here because pipeline ↛ worker and
 * no shared module is extracted per plan).
 */
export function pkcs1ToPkcs8(pkcs1Pem: string): string {
  const body = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1Der = base64ToBytes(body);
  const algorithm = derElement(
    DER_SEQUENCE,
    concatBytes(derElement(DER_OID, RSA_ENCRYPTION_OID), derElement(DER_NULL, new Uint8Array(0))),
  );
  const wrappedKey = derElement(DER_OCTET_STRING, pkcs1Der);
  const pkcs8Der = derElement(
    DER_SEQUENCE,
    concatBytes(derElement(DER_INTEGER, PKCS8_VERSION_ZERO), algorithm, wrappedKey),
  );
  const b64 = bytesToBase64(pkcs8Der);
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Normalize a private key PEM to PKCS#8 (the only format workerd WebCrypto
 * `importKey` accepts): PKCS#1 → wrapped; PKCS#8 → as-is; OpenSSH → hard
 * error with the conversion command.
 */
export function normalizePrivateKey(pem: string): string {
  if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return pkcs1ToPkcs8(pem);
  }
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    throw new Error(
      "PRIVATE_KEY is in OpenSSH format, which WebCrypto cannot sign with. Convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in <key> -out <key>.pkcs8.pem",
    );
  }
  return pem;
}

export type CommenterEnv = { APP_ID: string; PRIVATE_KEY: string };

export type PostReviewInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  output: ReviewOutput;
  /** Findings dropped by the severity cap (B4) — rendered as a body footer. */
  omittedFindings?: number;
};

export type ReviewCommenter = {
  /** Mint an installation access token (injected as GH_TOKEN into exec env). */
  getInstallationToken(installationId: number): Promise<string>;
  /** Post one overall review comment (Reviews API; no line comments). */
  postReview(input: PostReviewInput): Promise<void>;
};
/**
 * Structural auth surface for the createAppAuth strategy. `AuthInterface` is
 * not exported by @octokit/auth-app, so the surface is named here; the real
 * strategy is assignable (same pattern as 04's diff.ts AppAuth). With a
 * factory the call resolves to the factory's return (the octokit); without
 * one it resolves to the installation access token.
 */
export type AppAuthStrategy = {
  (options: { type: "installation"; installationId: number }): Promise<{ token: string }>;
  <T>(options: { type: "installation"; installationId: number; factory: (options: unknown) => T }): Promise<T>;
};

/**
 * Production commenter: createAppAuth (APP_ID + normalized PRIVATE_KEY) →
 * per-installation octokit via the documented factory pattern. The
 * createAppAuth instance is memoized so its installation-token cache is
 * shared across calls (auth-app default: tokens cached until expiry).
 */
export function createReviewCommenter(env: CommenterEnv): ReviewCommenter {
  let appAuth: AppAuthStrategy | null = null;
  async function getAppAuth(): Promise<AppAuthStrategy> {
    if (appAuth === null) {
      appAuth = createAppAuth({ appId: env.APP_ID, privateKey: normalizePrivateKey(env.PRIVATE_KEY) });
    }
    return appAuth;
  }

  return {
    async getInstallationToken(installationId) {
      const auth = await getAppAuth();
      const installation = await auth({ type: "installation", installationId });
      return installation.token;
    },
    async postReview(input) {
      const auth = await getAppAuth();
      const octokit = await auth({
        type: "installation",
        installationId: input.installationId,
        factory: (options: unknown) => new Octokit({ authStrategy: createAppAuth, auth: options }),
      });
      const createReview = octokit.rest?.pulls?.createReview;
      if (!createReview) {
        throw new Error(
          "octokit is missing rest.pulls.createReview — cannot post the review; check the injected auth surface",
        );
      }
      await createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        commit_id: input.headSha,
        // SEC-01 fix: always COMMENT — the model verdict is prompt-injectable
        // and must never drive GitHub's APPROVE/REQUEST_CHANGES privileges.
        event: REVIEW_EVENT,
        body: buildReviewBody(input.output, input.omittedFindings),
      });
    },
  };
}
