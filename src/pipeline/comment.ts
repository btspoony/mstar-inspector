/**
 * Review comment assembly + posting (plan 06 Task 3 + postdeploy feedback T5).
 *
 * Assembly (pure, unit-tested):
 *   - summary_md truncated to 8000 chars (plan Task 3 budget);
 *   - findings grouped and listed BY merge class, category verbatim
 *     (mapping spec §3: findings 按 merge class 列出 — class原文写入, never
 *     rewritten to M1 severity);
 *   - tally line rendered when the envelope carries one (must-fix /
 *     should-fix / nit / unverified counts, engine REVIEW_EMOJI);
 *   - NO line-comment fields: the body is a single overall review comment;
 *   - verdict rendered VERBATIM as text in the body header (`**Verdict:
 *     ship it**` / `needs fixes` / `blocked` — never M1 vocab, never a
 *     GitHub review event).
 *
 * Posting (T5): single-comment UPSERT via the Issues comments API
 * (@octokit/rest + createAppAuth — same deps and pattern as 04's diff.ts;
 * the auth factory is invoked separately here because pipeline MUST NOT
 * import src/worker/** and no shared module is extracted per plan). The
 * first line of the body is a hidden HTML marker
 * (`<!-- mstar-inspector:review:v1 round=N -->`); the app locates its own
 * previous comment via issues.listComments (marker prefix match) and PATCHes
 * it with round = N + 1, or creates a new comment with round = 1. This
 * replaces the old pulls.createReview posting (one review per round — the
 * comment-duplication root cause). The model verdict is prompt-injectable,
 * so it is NEVER mapped onto GitHub APPROVE/REQUEST_CHANGES — the Issues
 * comments API has no review event at all, and the verdict is rendered as
 * text in the body header (SEC-01 guarantee, structurally).
 *
 * Secrets: APP_ID/PRIVATE_KEY come from the Worker env; the installation
 * token is minted in memory and never logged or stored (compass D).
 * Model-produced text (summary/finding bodies) is redacted BEFORE it reaches
 * this module (consumer choke point, SEC-02 fix) so a prompt-injected token
 * can never appear in the public review body or D1 raw_output.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { MERGE_CLASSES, REVIEW_EMOJI } from "@mstar-harness/engine";
import type { ReviewFinding, ReviewOutput } from "../review/schema";

/** summary_md budget for the overall review body (plan Task 3). */
export const SUMMARY_MD_LIMIT = 8000;

/** Truncate summary_md to the body budget (char-based; GitHub counts chars). */
export function truncateSummary(md: string, limit: number = SUMMARY_MD_LIMIT): string {
  return md.length <= limit ? md : `${md.slice(0, limit - 1)}…`;
}

/**
 * Render findings grouped BY merge class (mapping spec §3), fixed engine
 * order (must-fix → should-fix → nit; empty classes omitted). Category is
 * emitted verbatim when present; location is `file_path[:line_start]` or
 * "repo-wide" when the finding is not file-scoped. Empty findings → empty
 * string (no section).
 */
export function renderFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "";
  const sections = MERGE_CLASSES.map((mergeClass) => {
    const inClass = findings.filter((finding) => finding.mergeClass === mergeClass);
    if (inClass.length === 0) return null;
    const items = inClass.map((finding, index) => {
      const location = finding.file_path
        ? `${finding.file_path}${finding.line_start != null ? `:${finding.line_start}` : ""}`
        : "repo-wide";
      const body = finding.body ? `\n\n${finding.body}` : "";
      const category = finding.category !== undefined ? ` (${finding.category})` : "";
      return `${index + 1}. **${finding.title}**${category} — ${location}${body}`;
    });
    return `### ${REVIEW_EMOJI[mergeClass]} ${mergeClass}\n\n${items.join("\n\n")}`;
  }).filter((section) => section !== null);
  return `## Findings\n\n${sections.join("\n\n")}`;
}

/** Tally line from the envelope's PrTallyResult; empty when absent (§3). */
function renderTally(tally: ReviewOutput["tally"]): string {
  if (tally === undefined) return "";
  const { mustFix, shouldFix, nit, unverified } = tally.tally;
  return (
    `**Tally:** ${REVIEW_EMOJI["must-fix"]} must-fix ${mustFix} · ` +
    `${REVIEW_EMOJI["should-fix"]} should-fix ${shouldFix} · ` +
    `${REVIEW_EMOJI.nit} nit ${nit} · ${REVIEW_EMOJI.unverified} unverified ${unverified}`
  );
}

/**
 * Assemble the overall review body: verdict header (verbatim) + tally line
 * (when present) + truncated summary + findings-by-class section + optional
 * omitted-findings footer. `omittedFindings` is the count of findings
 * dropped by the consumer's merge-class cap (B4) — the footer tells readers
 * the review is a Top-N subset.
 */
export function buildReviewBody(output: ReviewOutput, omittedFindings = 0): string {
  const verdict = `**Verdict: ${output.verdict}**`;
  const tally = renderTally(output.tally);
  const summary = truncateSummary(output.summary_md);
  const findings = renderFindings(output.findings);
  const head = tally ? `${verdict}\n\n${tally}` : verdict;
  const body = findings ? `${head}\n\n${summary}\n\n${findings}` : `${head}\n\n${summary}`;
  return omittedFindings > 0 ? `${body}\n\n*(+${omittedFindings} more findings omitted)*` : body;
}
// ---------------------------------------------------------------------------
// Single-comment upsert (postdeploy feedback T5)
// ---------------------------------------------------------------------------

/** Hidden HTML marker prefix — the first line of every review comment body. */
export const REVIEW_MARKER_PREFIX = "<!-- mstar-inspector:review:v1";

/** Full marker regex: `<!-- mstar-inspector:review:v1 round=N -->`. */
const REVIEW_MARKER_RE = /^<!-- mstar-inspector:review:v1 round=(\d+) -->/;

/**
 * Parse the round number from a review comment body. Returns null when the
 * body does not start with a well-formed marker (malformed → treated as a
 * miss by planUpsert).
 */
export function parseReviewRound(body: string): number | null {
  const match = REVIEW_MARKER_RE.exec(body);
  return match ? Number(match[1]) : null;
}

/**
 * Find the app's own review comment in an issues.listComments response:
 * the first comment whose body starts with the marker prefix. Returns null
 * when no comment carries the marker.
 */
export function findReviewComment(
  comments: Array<{ id: number; body?: string | null }>,
): { id: number; body: string } | null {
  for (const comment of comments) {
    if (comment.body?.startsWith(REVIEW_MARKER_PREFIX)) {
      return { id: comment.id, body: comment.body };
    }
  }
  return null;
}

export type UpsertPlan =
  | { action: "create"; round: 1 }
  | { action: "update"; commentId: number; round: number };

/**
 * Decide create vs update for the review comment (T5):
 *   - no marker comment → create with round=1;
 *   - marker comment with a well-formed round N → update that comment with
 *     round = N + 1;
 *   - marker comment with a MALFORMED round → treated as a miss: create a
 *     new comment with round=1.
 */
export function planUpsert(
  comments: Array<{ id: number; body?: string | null }>,
): UpsertPlan {
  const existing = findReviewComment(comments);
  if (existing === null) return { action: "create", round: 1 };
  const round = parseReviewRound(existing.body);
  if (round === null) return { action: "create", round: 1 };
  return { action: "update", commentId: existing.id, round: round + 1 };
}

/**
 * Assemble the upsert body: hidden marker line (round), the「第 N 次 review ·
 * commit <short sha>」header, then the existing buildReviewBody rendering.
 */
export function buildUpsertBody(
  output: ReviewOutput,
  omittedFindings: number,
  round: number,
  headSha: string,
): string {
  const marker = `<!-- mstar-inspector:review:v1 round=${round} -->`;
  const header = `第 ${round} 次 review · commit ${headSha.slice(0, 7)}`;
  return `${marker}\n${header}\n\n${buildReviewBody(output, omittedFindings)}`;
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
  /** Findings dropped by the merge-class cap (B4) — rendered as a body footer. */
  omittedFindings?: number;
};

export type ReviewCommenter = {
  /** Mint an installation access token (injected as GH_TOKEN into exec env). */
  getInstallationToken(installationId: number): Promise<string>;
  /**
   * Upsert one overall review comment (Issues comments API; T5): create with
   * round=1 on a miss, PATCH the app's own marker comment with round=N+1 on
   * a hit. No line comments, no review events.
   */
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
 * Minimal octokit surface `postReview` consumes: `paginate` (from
 * plugin-paginate-rest, bundled with @octokit/rest) plus the three Issues
 * comments methods. The real Octokit satisfies this structurally at
 * runtime; the cast at the call site bridges plugin-paginate-rest's
 * overloaded types to this minimal interface (SG-001 mock seam).
 */
export type PostOctokit = {
  paginate: (
    route: unknown,
    parameters: Record<string, unknown>,
  ) => Promise<Array<{ id: number; body?: string | null }>>;
  rest: {
    issues: {
      listComments: (
        parameters: Record<string, unknown>,
      ) => Promise<{ data: Array<{ id: number; body?: string | null }> }>;
      updateComment: (parameters: Record<string, unknown>) => Promise<unknown>;
      createComment: (parameters: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

/**
 * Upsert the overall review comment against a caller-provided octokit
 * (T5 + WF-001/WF-003). Exported so tests can drive the full wiring with a
 * mock octokit (SG-001); the production commenter builds the real octokit
 * and delegates here.
 *
 * The Issues comments API has no review event — the model verdict is
 * prompt-injectable and is rendered as text only (SEC-01, structural).
 */
export async function postReviewWithOctokit(octokit: PostOctokit, input: PostReviewInput): Promise<void> {
  const issues = octokit.rest?.issues;
  if (
    !issues?.listComments ||
    !issues?.updateComment ||
    !issues?.createComment ||
    typeof octokit.paginate !== "function"
  ) {
    throw new Error(
      "octokit is missing rest.issues comment methods / paginate — cannot upsert the review comment; check the injected auth surface",
    );
  }
  // WF-001: scan the FULL comment list. `issues.listComments` caps at 100
  // per page — on a busy PR the app's marker can sit beyond page 1, and a
  // page-1-only scan would treat it as a miss and create a duplicate
  // round=1 comment (round counter resets, old marker orphaned).
  const comments = await octokit.paginate(issues.listComments, {
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    per_page: 100,
  });
  const plan = planUpsert(comments);
  const body = buildUpsertBody(input.output, input.omittedFindings ?? 0, plan.round, input.headSha);
  if (plan.action === "update") {
    try {
      await issues.updateComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: plan.commentId,
        body,
      });
    } catch (err) {
      // WF-003 soft recovery: between listComments and updateComment the
      // marker can be deleted by a human or another bot — the PATCH then
      // 404s. The marker is gone, so POST a fresh round=1 comment (new
      // marker) instead of letting the error bubble into a queue retry
      // that would re-create round=1 anyway but only AFTER the retry
      // delay. The round counter legitimately resets across the gap —
      // the deleted comment no longer exists to chain from.
      // A RequestError from octokit carries `.status` (duck-typed so the
      // mock-octokit tests can reject with a plain { status: 404 }).
      if (typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404) {
        await issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.prNumber,
          body: buildUpsertBody(input.output, input.omittedFindings ?? 0, 1, input.headSha),
        });
        return;
      }
      throw err;
    }
    return;
  }
  await issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    body,
  });
}

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
      // The real Octokit satisfies PostOctokit at runtime (paginate is
      // bundled with @octokit/rest); the cast bridges the overloaded
      // plugin-paginate-rest types to the minimal surface above.
      await postReviewWithOctokit(octokit as unknown as PostOctokit, input);
    },
  };
}
