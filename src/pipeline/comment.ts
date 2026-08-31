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
 *   - the overall body carries NO per-line comment fields — anchored line
 *     comments are a SEPARATE chain (pulls.createReview COMMENT, see
 *     "Line comments" below);
 *   - verdict rendered VERBATIM as text in the body header (`**Verdict:
 *     ship it**` / `needs fixes` / `blocked` — never M1 vocab, never a
 *     GitHub review event).
 *
 * Posting (T5): single-comment UPSERT via the Issues comments API
 * (@octokit/rest + createAppAuth — same deps and pattern as the deleted
 * worker/diff.ts, plan 04; the auth factory is invoked separately here
 * because pipeline MUST NOT import src/worker/** and no shared module is
 * extracted per plan). The first line of the body is a hidden HTML marker
 * (`<!-- mstar-inspector:review:v1 round=N -->`); the app locates its own
 * previous comment via issues.listComments (marker prefix match AND
 * bot-authorship — qc2 F-002: a human-planted marker is a miss, and a
 * 403/404 on the PATCH replans past the dead comment or creates) and
 * PATCHes it with round = N + 1, or creates a new comment with round = 1. This
 * replaces the old pulls.createReview posting (one review per round — the
 * comment-duplication root cause). The model verdict is prompt-injectable,
 * so it is NEVER mapped onto GitHub APPROVE/REQUEST_CHANGES — the Issues
 * comments API has no review event at all, and the verdict is rendered as
 * text in the body header (SEC-01 guarantee, structurally).
 *
 * Degraded chain (plan 18 Task 2 / architect AL-1): a parse-fail review
 * posts a summary-only "Review degraded" comment on a SEPARATE marker
 * family (`<!-- mstar-inspector:review-degraded:v1 round=N -->`) with an
 * independent round counter — the real review chain is untouched. The
 * body carries the redacted parse error line plus a redacted
 * (redactSecrets), ≤1000-char raw-output excerpt behind a details
 * collapse; both chains share the scan/upsert/403-404-replan mechanics
 * (upsertMarkerComment).
 *
 * Secrets: the CommenterEnv APP_ID/PRIVATE_KEY pair (same literal names as
 * the retired Worker env secrets) is populated by consumer.ts
 * resolveCommenter from the D1 row's decrypted per-App credentials, never
 * from the env; the installation token is minted in memory and never
 * logged or stored (compass D).
 * Model-produced text (summary/finding bodies) is redacted BEFORE it reaches
 * this module (consumer choke point, SEC-02 fix) so a prompt-injected token
 * can never appear in the public review body or D1 raw_output. The DEGRADED
 * chain is the exception: raw runner stdout and the parse error line arrive
 * UNREDACTED (the consumer must not pre-cut them), so buildDegradedBody is
 * the in-module redaction choke point — both are redactSecrets'd BEFORE the
 * truncation cut, keeping a straddling or zod-`received`-embedded token out
 * of the public body.
 *
 * Line comments (plan 18 Task 3 / architect AL-3, layered delivery):
 * qualifying findings (file_path non-empty, line_end ≥ 1, inside a
 * right-side hunk of the prefetched PR diff) are anchored as ONE
 * pulls.createReview call with `event: "COMMENT"` (D4 permanent event lock —
 * never APPROVE/REQUEST_CHANGES) and `comments: [{path, side: "RIGHT",
 * line, body}]`. The top-level `body` is REQUIRED for COMMENT events
 * (installed octokit schema) and is a short marker line only
 * (`mstar-inspector line comments · round N · <short sha>`) — never a copy
 * of the overall review body. The consumer prefetches the diff via
 * `pulls.get` + `mediaType: { format: "diff" }` on this module's extended
 * PostOctokit surface (pattern originated from the deleted worker/diff.ts,
 * plan 24 — NOT imported, pipeline ↛ worker isolation holds), prefilters
 * with the pure `parseDiffHunkRanges` (createReview is atomic: one invalid
 * line → whole request 422), attempts the review, and on residual 422/any
 * Octokit error falls back to overall-comment-only (structured log, never
 * throws after the overall comment succeeded). Empty qualifying set → zero
 * API calls. No `start_line` this iteration; old rounds' line comments
 * stay in place.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { MERGE_CLASSES, REVIEW_EMOJI } from "@mstar-harness/engine";
import { FINDING_BODY_MAX, type ReviewFinding, type ReviewOutput } from "../review/schema";
import { redactSecrets } from "./redact";
import { computeFindingFingerprint } from "../store/fingerprint";

/** summary_md budget for the overall review body (plan Task 3). */
export const SUMMARY_MD_LIMIT = 8000;

/**
 * Hard ceiling on the assembled review body (qc2 F-003 / qc3 F-304): GitHub
 * Issues comments cap the body at 65536 chars — an over-limit body would
 * fail at createComment/updateComment AFTER the container model run, and
 * every queue retry would fail again (→ DLQ). The ceiling leaves room for
 * the upsert marker + round header (~80 chars) on top.
 */
export const REVIEW_BODY_LIMIT = 65000;

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
 *
 * Plan 21 Task 3 (AL-21-2): when a previous-round fingerprint set is
 * provided, a finding whose fingerprint appeared in the previous round is
 * marked `*(repeat)*` — still listed, but excluded from the tally's new
 * counts (display-layer semantics; envelope/persist untouched).
 */
export function renderFindings(findings: ReviewFinding[], previousFingerprints?: ReadonlySet<string>): string {
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
      const repeat =
        previousFingerprints !== undefined && previousFingerprints.has(computeFindingFingerprint(finding))
          ? " *(repeat)*"
          : "";
      return `${index + 1}. **${finding.title}**${category} — ${location}${repeat}${body}`;
    });
    return `### ${REVIEW_EMOJI[mergeClass]} ${mergeClass}\n\n${items.join("\n\n")}`;
  }).filter((section) => section !== null);
  return `## Findings\n\n${sections.join("\n\n")}`;
}

/**
 * Tally line from the envelope's PrTallyResult; empty when absent (§3).
 * Plan 21 Task 3 (AL-21-2): with a non-empty previous-round fingerprint
 * set, each class count is recomputed as the number of NON-repeat findings
 * in the rendered (capped) array — repeats are still listed but no longer
 * re-voted. unverified is a fingerprint-less independent list and keeps the
 * envelope value; verdict/scorePct are never rendered here.
 *
 * Invariant (B4): the recomputed counts run over the SAME capped array that
 * renderFindings renders (the consumer's shared capped array feeds both the
 * post and the put) — the tally always describes the visible findings, never
 * the pre-cap envelope counts; a cap that dropped findings is surfaced by
 * the omitted-findings footer, not by the tally.
 */
function renderTally(
  tally: ReviewOutput["tally"],
  findings: ReviewFinding[],
  previousFingerprints?: ReadonlySet<string>,
): string {
  if (tally === undefined) return "";
  const { mustFix, shouldFix, nit, unverified } = tally.tally;
  if (previousFingerprints !== undefined && previousFingerprints.size > 0) {
    const countNew = (mergeClass: string) =>
      findings.filter(
        (finding) => finding.mergeClass === mergeClass && !previousFingerprints.has(computeFindingFingerprint(finding)),
      ).length;
    return (
      `**Tally:** ${REVIEW_EMOJI["must-fix"]} must-fix ${countNew("must-fix")} · ` +
      `${REVIEW_EMOJI["should-fix"]} should-fix ${countNew("should-fix")} · ` +
      `${REVIEW_EMOJI.nit} nit ${countNew("nit")} · ${REVIEW_EMOJI.unverified} unverified ${unverified}`
    );
  }
  return (
    `**Tally:** ${REVIEW_EMOJI["must-fix"]} must-fix ${mustFix} · ` +
    `${REVIEW_EMOJI["should-fix"]} should-fix ${shouldFix} · ` +
    `${REVIEW_EMOJI.nit} nit ${nit} · ${REVIEW_EMOJI.unverified} unverified ${unverified}`
  );
}

/**
 * Assemble the overall review body: verdict header (verbatim) + tally line
 * (when present) + truncated summary + findings-by-class section + optional
 * omitted-findings footer, finally clamped to REVIEW_BODY_LIMIT (qc2 F-003 /
 * qc3 F-304 — the API never sees an over-limit body). `omittedFindings` is
 * the count of findings dropped by the consumer's merge-class cap (B4) —
 * the footer tells readers the review is a Top-N subset.
 *
 * Plan 21 Task 3 (AL-21-2): `previousFingerprints` is the repeat-dedup data
 * channel — assembly INPUT only (the consumer queries the store; this module
 * never does). Publication structure (marker/header/line comments) is
 * untouched.
 */
export function buildReviewBody(
  output: ReviewOutput,
  omittedFindings = 0,
  previousFingerprints?: ReadonlySet<string>,
): string {
  const verdict = `**Verdict: ${output.verdict}**`;
  const tally = renderTally(output.tally, output.findings, previousFingerprints);
  const summary = truncateSummary(output.summary_md);
  const findings = renderFindings(output.findings, previousFingerprints);
  const head = tally ? `${verdict}\n\n${tally}` : verdict;
  const body = findings ? `${head}\n\n${summary}\n\n${findings}` : `${head}\n\n${summary}`;
  const full = omittedFindings > 0 ? `${body}\n\n*(+${omittedFindings} more findings omitted)*` : body;
  return full.length <= REVIEW_BODY_LIMIT ? full : `${full.slice(0, REVIEW_BODY_LIMIT - 1)}…`;
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
 * Minimal issues.listComments item shape the upsert scan needs. `user.type`
 * is how GitHub distinguishes app-authored comments ("Bot" — the identity
 * our installation posts as) from human ones ("User").
 */
export type ReviewComment = { id: number; body?: string | null; user?: { type?: string } | null };

/**
 * Find OUR review comment in an issues.listComments response (qc2 F-002):
 * the first BOT-AUTHORED comment whose body starts with the marker prefix.
 * Any PR participant can plant the marker text on a human account, and
 * GitHub refuses issues.updateComment on a foreign author's comment (403)
 * — so a marker comment is only a match when a bot account wrote it.
 * `excludeIds` skips comments already known dead (403/404 recovery replan).
 * Returns null when no eligible comment carries the marker.
 */
export function findReviewComment(
  comments: ReviewComment[],
  excludeIds?: ReadonlySet<number>,
): { id: number; body: string } | null {
  for (const comment of comments) {
    if (excludeIds?.has(comment.id)) continue;
    if (comment.user?.type !== "Bot") continue;
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
 * Decide create vs update for the review comment (T5 + qc2 F-002):
 *   - no bot-authored marker comment → create with round=1;
 *   - bot marker comment with a well-formed round N → update that comment
 *     with round = N + 1;
 *   - marker comment with a MALFORMED round → treated as a miss: create a
 *     new comment with round=1;
 *   - `excludeIds` removes dead comments from the scan (recovery replan).
 */
export function planUpsert(comments: ReviewComment[], excludeIds?: ReadonlySet<number>): UpsertPlan {
  const existing = findReviewComment(comments, excludeIds);
  if (existing === null) return { action: "create", round: 1 };
  const round = parseReviewRound(existing.body);
  if (round === null) return { action: "create", round: 1 };
  return { action: "update", commentId: existing.id, round: round + 1 };
}

/**
 * Assemble the upsert body: hidden marker line (round), the「第 N 次 review ·
 * commit <short sha>」header, then the existing buildReviewBody rendering.
 * Plan 21 Task 3 (AL-21-2): `previousFingerprints` is the repeat-dedup
 * assembly input (marker/header structure untouched — D4 lock).
 */
export function buildUpsertBody(
  output: ReviewOutput,
  omittedFindings: number,
  round: number,
  headSha: string,
  previousFingerprints?: ReadonlySet<string>,
): string {
  const marker = `<!-- mstar-inspector:review:v1 round=${round} -->`;
  const header = `第 ${round} 次 review · commit ${headSha.slice(0, 7)}`;
  return `${marker}\n${header}\n\n${buildReviewBody(output, omittedFindings, previousFingerprints)}`;
}
// ---------------------------------------------------------------------------
// Degraded comment chain (plan 18 Task 2 / architect AL-1): the parse-fail
// visibility chain. A SEPARATE marker family from the real review upsert —
// `review-degraded:v1` never starts with the `review:v1` prefix and vice
// versa, so the two scans and their round counters stay independent (the
// real chain is untouched). One degraded comment per PR, upserted with the
// same create-on-miss / PATCH-on-hit mechanics.
// ---------------------------------------------------------------------------

/** Hidden HTML marker prefix — the first line of every degraded comment body. */
export const DEGRADED_MARKER_PREFIX = "<!-- mstar-inspector:review-degraded:v1";

/** Full marker regex: `<!-- mstar-inspector:review-degraded:v1 round=N -->`. */
const DEGRADED_MARKER_RE = /^<!-- mstar-inspector:review-degraded:v1 round=(\d+) -->/;

/**
 * Parse the round number from a degraded comment body. Returns null when the
 * body does not start with a well-formed degraded marker (malformed →
 * treated as a miss by planDegradedUpsert).
 */
export function parseDegradedRound(body: string): number | null {
  const match = DEGRADED_MARKER_RE.exec(body);
  return match ? Number(match[1]) : null;
}

/**
 * Find OUR degraded comment in an issues.listComments response: the first
 * BOT-AUTHORED comment whose body starts with the degraded marker prefix.
 * Same bot-authorship gate as findReviewComment (qc2 F-002) — a
 * human-planted marker is a miss. Real review-chain markers (`review:v1`)
 * are NOT matched: the chains never cross.
 */
export function findDegradedComment(
  comments: ReviewComment[],
  excludeIds?: ReadonlySet<number>,
): { id: number; body: string } | null {
  for (const comment of comments) {
    if (excludeIds?.has(comment.id)) continue;
    if (comment.user?.type !== "Bot") continue;
    if (comment.body?.startsWith(DEGRADED_MARKER_PREFIX)) {
      return { id: comment.id, body: comment.body };
    }
  }
  return null;
}

/**
 * Collect ALL bot-authored `review-degraded:v1` matches in an
 * issues.listComments response (Bugbot round-2 fix): the delete path must
 * clean every stale marker, not just the first — after a 403/404
 * miss-and-replan recovery the PR can carry TWO bot markers (a foreign
 * App's and ours). Same bot-authorship gate + prefix restriction as
 * findDegradedComment; real review-chain markers (`review:v1`) never match.
 */
export function findDegradedComments(
  comments: ReviewComment[],
  excludeIds?: ReadonlySet<number>,
): Array<{ id: number; body: string }> {
  const matches: Array<{ id: number; body: string }> = [];
  for (const comment of comments) {
    if (excludeIds?.has(comment.id)) continue;
    if (comment.user?.type !== "Bot") continue;
    if (comment.body?.startsWith(DEGRADED_MARKER_PREFIX)) {
      matches.push({ id: comment.id, body: comment.body });
    }
  }
  return matches;
}

/**
 * planUpsert-equivalent for the degraded chain, restricted to bodies
 * starting with the degraded prefix: create with round=1 on a miss (or a
 * malformed marker), update with round=N+1 on a hit.
 */
export function planDegradedUpsert(comments: ReviewComment[], excludeIds?: ReadonlySet<number>): UpsertPlan {
  const existing = findDegradedComment(comments, excludeIds);
  if (existing === null) return { action: "create", round: 1 };
  const round = parseDegradedRound(existing.body);
  if (round === null) return { action: "create", round: 1 };
  return { action: "update", commentId: existing.id, round: round + 1 };
}

/** Raw-excerpt budget for the degraded body (AL-1: ≤1000 chars, redacted). */
export const DEGRADED_EXCERPT_LIMIT = 1000;

export type DegradedBodyInput = {
  /**
   * The parseReviewOutput error (engine/zod violation vocabulary — it never
   * embeds raw stdout, but a zod/engine `received` span CAN echo a
   * model-emitted token, e.g. an enum failure on `verdict: "ghp_…"`).
   * Redacted via redactSecrets, then clamped to the summary budget so the
   * total body stays under REVIEW_BODY_LIMIT by construction.
   */
  error: string;
  /** Raw runner stdout — redacted via redactSecrets, then truncated to the excerpt budget. */
  rawOutput: string;
  /** The degraded-chain round (independent counter from the real review chain). */
  round: number;
};

/**
 * Assemble the degraded body (AL-1): hidden marker line (degraded round),
 * the fixed "Review degraded" headline, the parse error line, then the raw
 * excerpt behind a details collapse. BOTH the error line and the excerpt
 * are REDACTED FIRST (redactSecrets — the raw-string face, redact.ts) and
 * truncated AFTER, so a secret straddling the 1000-char cut is already gone
 * before the slice (a truncated-before-redact secret could evade the
 * patterns and leak a partial token). The code fence is sized past the
 * excerpt's longest backtick run — runner output routinely prints fenced
 * ```json blocks.
 */
export function buildDegradedBody(input: DegradedBodyInput): string {
  const marker = `${DEGRADED_MARKER_PREFIX} round=${input.round} -->`;
  const error = truncateSummary(redactSecrets(input.error));
  const redacted = redactSecrets(input.rawOutput);
  const excerpt =
    redacted.length <= DEGRADED_EXCERPT_LIMIT
      ? redacted
      : `${redacted.slice(0, DEGRADED_EXCERPT_LIMIT - 1)}…`;
  const longestRun = Math.max(0, ...[...excerpt.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${marker}
**Review degraded: output failed schema validation**

${error}

<details>
<summary>Raw output excerpt (redacted, ≤${DEGRADED_EXCERPT_LIMIT} chars)</summary>

${fence}
${excerpt}
${fence}

</details>`;
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
 * algorithm as the deleted worker/diff.ts, plan 04; duplicated here because
 * pipeline ↛ worker and no shared module is extracted per plan).
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
  /**
   * Previous-round fingerprint set (plan 21 Task 3 / AL-21-2): the consumer
   * queries it BEFORE the post (the current sha row does not exist yet) and
   * passes it here — assembly INPUT only. Findings whose fingerprint is in
   * the set are marked repeat and excluded from the tally's new counts.
   */
  previousFingerprints?: ReadonlySet<string>;
};

export type ReviewCommenter = {
  /** Mint an installation access token (injected as GH_TOKEN into exec env). */
  getInstallationToken(installationId: number): Promise<string>;
  /**
   * Upsert one overall review comment (Issues comments API; T5): create with
   * round=1 on a miss, PATCH the app's own marker comment with round=N+1 on
   * a hit. Returns the round just posted — the consumer pins the
   * line-comments marker body (plan 18 Task 3) to the SAME round, single
   * source: the upsert scan.
   */
  postReview(input: PostReviewInput): Promise<number>;
  /**
   * Upsert the degraded comment (plan 18 Task 2 / AL-1): the parse-fail
   * visibility chain — a SEPARATE marker family (`review-degraded:v1`) with
   * an independent round counter from postReview's real review chain. The
   * consumer calls it best-effort on the degrade path: a rejection is a
   * structured log line, never a mask for the ack.
   */
  postDegraded(input: PostDegradedInput): Promise<void>;
  /**
   * Delete stale bot-authored `review-degraded:v1` comments (Bugbot
   * finding — degraded-comment lifecycle): the success path calls this
   * best-effort once a real review supersedes the degradation. NEVER
   * throws — returns the outcome (deleted/skipped/errors) for the
   * consumer's warn-only log line.
   */
  deleteDegradedComment(input: PostDegradedInput): Promise<DegradedDeleteOutcome>;
  /**
   * Fetch the PR diff as a unified-diff string (plan 18 Task 3 / AL-3):
   * `pulls.get` + `mediaType: { format: "diff" }` — the hunk prefilter input.
   * Throws on a missing surface or a non-diff response; the consumer treats
   * any failure as "prefetch failed → base-filter attempt".
   */
  fetchPrDiff(input: FetchPrDiffInput): Promise<string>;
  /**
   * Post the line-comments review (plan 18 Task 3 / AL-3): ONE
   * pulls.createReview with `event: "COMMENT"` (D4 event lock) and the
   * pre-filtered qualifying findings as `comments[]`. Throws on any Octokit
   * error — the consumer's never-throw guard is the catch site.
   */
  postLineComments(input: PostLineCommentsInput): Promise<void>;
};
/**
 * Structural auth surface for the createAppAuth strategy. `AuthInterface` is
 * not exported by @octokit/auth-app, so the surface is named here; the real
 * strategy is assignable (same pattern as the deleted worker/diff.ts
 * AppAuth, plan 04). With a factory the call resolves to the factory's
 * return (the octokit); without one it resolves to the installation access
 * token.
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
  paginate: (route: unknown, parameters: Record<string, unknown>) => Promise<ReviewComment[]>;
  rest: {
    issues: {
      listComments: (parameters: Record<string, unknown>) => Promise<{ data: ReviewComment[] }>;
      updateComment: (parameters: Record<string, unknown>) => Promise<unknown>;
      createComment: (parameters: Record<string, unknown>) => Promise<unknown>;
      /**
       * Issues comments delete (Bugbot finding — degraded-comment
       * lifecycle): the success path removes a stale bot-authored
       * `review-degraded:v1` comment once a real review supersedes it.
       * Optional and guarded — the marker-comment chains never touch it.
       */
      deleteComment?: (parameters: Record<string, unknown>) => Promise<unknown>;
    };
    /**
     * Pulls surface for plan 18 Task 3 line comments: `get` with
     * `mediaType: { format: "diff" }` (diff prefetch for the hunk prefilter)
     * and `createReview` (COMMENT-event delivery). Optional and per-method
     * guarded — the marker-comment chains never touch it, and the
     * line-comment path fails soft through the consumer's catch.
     */
    pulls?: {
      get?: (parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
      createReview?: (parameters: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

/** PR coordinates shared by both marker-comment chains. */
type CommentTarget = { owner: string; repo: string; prNumber: number };

/**
 * Shared marker-comment upsert behind BOTH public chains (the T5 review
 * upsert and the plan-18 degraded chain): guard the octokit surface, scan
 * the FULL comment list (WF-001: `issues.listComments` caps at 100 per
 * page — on a busy PR the app's marker can sit beyond page 1, and a
 * page-1-only scan would treat it as a miss and create a duplicate round=1
 * comment), then create-on-miss / PATCH-on-hit with the 403/404
 * dead-comment replan (WF-003 / qc2 F-002: 404 = the marker was deleted
 * mid-flight; 403 = the marker belongs to another author — only
 * bot-authored comments are matched, but another app's bot can still plant
 * one. Both are treated as a MISS: re-plan with that comment excluded —
 * the next bot marker wins, else a fresh round=1 is created. Each replan
 * permanently excludes one id, so the loop always terminates). The chain
 * the scan matches is the caller's `planComment` choice — the recovery
 * semantics must never drift between the two chains. Returns the round
 * just posted (the caller's `buildBody` round) — the line-comments marker
 * (plan 18 Task 3) pins itself to the review chain's round.
 */
async function upsertMarkerComment(
  octokit: PostOctokit,
  target: CommentTarget,
  planComment: (comments: ReviewComment[], excludeIds?: ReadonlySet<number>) => UpsertPlan,
  buildBody: (round: number) => string,
  /** Which marker chain is posting — names the missing-surface error per chain. */
  surface: "review" | "degraded",
): Promise<number> {
  const issues = octokit.rest?.issues;
  if (
    !issues?.listComments ||
    !issues?.updateComment ||
    !issues?.createComment ||
    typeof octokit.paginate !== "function"
  ) {
    throw new Error(
      `octokit is missing rest.issues comment methods / paginate — cannot upsert the ${surface} comment; check the injected auth surface`,
    );
  }
  const comments = await octokit.paginate(issues.listComments, {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.prNumber,
    per_page: 100,
  });
  const dead = new Set<number>();
  for (;;) {
    const planned = planComment(comments, dead);
    const body = buildBody(planned.round);
    if (planned.action === "create") {
      await issues.createComment({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.prNumber,
        body,
      });
      return planned.round;
    }
    try {
      await issues.updateComment({
        owner: target.owner,
        repo: target.repo,
        comment_id: planned.commentId,
        body,
      });
      return planned.round;
    } catch (err) {
      // A RequestError from octokit carries `.status` (duck-typed so the
      // mock-octokit tests can reject with a plain { status: N }).
      const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
      if (status === 404 || status === 403) {
        dead.add(planned.commentId);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Upsert the overall review comment against a caller-provided octokit
 * (T5 + WF-001/WF-003). Exported so tests can drive the full wiring with a
 * mock octokit (SG-001); the production commenter builds the real octokit
 * and delegates here.
 *
 * The Issues comments API has no review event — the model verdict is
 * prompt-injectable and is rendered as text only (SEC-01, structural).
 *
 * Returns the round just posted (plan 18 Task 3: the line-comments marker
 * body carries `round N` from THIS source, never a re-scan).
 */
export async function postReviewWithOctokit(octokit: PostOctokit, input: PostReviewInput): Promise<number> {
  return upsertMarkerComment(
    octokit,
    input,
    planUpsert,
    (round) =>
      buildUpsertBody(input.output, input.omittedFindings ?? 0, round, input.headSha, input.previousFingerprints),
    "review",
  );
}

export type PostDegradedInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  /** The parseReviewOutput error line (redacted + truncated inside buildDegradedBody). */
  error: string;
  /** Raw runner stdout — redacted + truncated inside buildDegradedBody. */
  rawOutput: string;
};

/**
 * Upsert the degraded comment against a caller-provided octokit (plan 18
 * Task 2 / AL-1): the parse-fail visibility chain. Same scan/replan
 * mechanics as the real review upsert, but the scan is restricted to the
 * `review-degraded:v1` marker prefix — the real review chain (`review:v1`)
 * and its round counter stay independent.
 */
export async function postDegradedWithOctokit(octokit: PostOctokit, input: PostDegradedInput): Promise<void> {
  await upsertMarkerComment(
    octokit,
    input,
    planDegradedUpsert,
    (round) => buildDegradedBody({ error: input.error, rawOutput: input.rawOutput, round }),
    "degraded",
  );
}

/** Degraded-comment delete outcome (Bugbot round-2 fix): the consumer logs
 * this instead of catching — the delete step is best-effort and never
 * throws. `skipped` counts 403/404 (foreign App's marker or already gone)
 * and any other per-match error; `errors` carries the non-403/404
 * messages so the warn line stays actionable.
 */
export type DegradedDeleteOutcome = {
  deleted: number;
  skipped: number;
  errors: string[];
};

/**
 * Delete stale bot-authored `review-degraded:v1` comments (Bugbot finding —
 * degraded-comment lifecycle, round-2 fix): scan the FULL comment list
 * (same WF-001 pagination as the upsert — the marker can sit beyond page 1
 * on a busy PR), collect EVERY bot-authored degraded marker (after a
 * 403/404 miss-and-replan recovery the PR can carry TWO — a foreign App's
 * and ours), and DELETE each via the Issues comments API. The successful
 * review supersedes the degradation, so stale "Review degraded" comments
 * must not outlive it. App-authored only (findDegradedComments' bot-
 * authorship gate) — a human-planted marker is never touched. No degraded
 * comment → no API call. NEVER throws: 403/404 on a match (foreign or
 * already gone) → skip and continue; any other error → skip that match and
 * surface the message in the outcome, still attempting the remaining
 * deletes. The consumer logs the outcome (warn-only, best-effort).
 */
export async function deleteDegradedCommentWithOctokit(
  octokit: PostOctokit,
  input: PostDegradedInput,
): Promise<DegradedDeleteOutcome> {
  const issues = octokit.rest?.issues;
  if (
    !issues?.listComments ||
    !issues?.deleteComment ||
    typeof octokit.paginate !== "function"
  ) {
    return {
      deleted: 0,
      skipped: 0,
      errors: [
        "octokit is missing rest.issues.listComments/deleteComment / paginate — cannot delete the degraded comment; check the injected auth surface",
      ],
    };
  }
  const comments = await octokit.paginate(issues.listComments, {
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    per_page: 100,
  });
  const matches = findDegradedComments(comments);
  const outcome: DegradedDeleteOutcome = { deleted: 0, skipped: 0, errors: [] };
  for (const match of matches) {
    try {
      await issues.deleteComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: match.id,
      });
      outcome.deleted += 1;
    } catch (err) {
      // A RequestError from octokit carries `.status` (duck-typed so the
      // mock-octokit tests can reject with a plain { status: N }).
      const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
      if (status === 403 || status === 404) {
        outcome.skipped += 1;
        continue;
      }
      outcome.skipped += 1;
      outcome.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Line comments (plan 18 Task 3 / architect AL-3, layered delivery): a pure
// hunk-range parser over the prefetched PR diff, the layered qualifying
// filter, and the pulls.createReview COMMENT poster. The consumer
// orchestrates prefetch → filter → attempt; THIS module never decides
// fallback policy — it throws and the consumer's never-throw guard logs
// `line_comments_fallback=true` and proceeds.
// ---------------------------------------------------------------------------

/** Hunk header: `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@`. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The b-side (new-file) path of a `+++ ` header line: `/dev/null` (deleted
 * file) → null; the `b/` prefix is stripped; C-style-quoted paths (spaces or
 * special chars) are unquoted best-effort — a path we cannot unquote simply
 * never matches a finding's file_path and the finding is excluded.
 */
function bSidePath(target: string): string | null {
  if (target === "/dev/null") return null;
  let path = target.startsWith("b/") ? target.slice(2) : target;
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      /* keep the raw path — exact-match against findings still applies */
    }
  }
  return path;
}

/**
 * Parse a unified diff into right-side (b-side / new-file) line ranges per
 * path: for every `@@ -a,b +c,d @@` hunk the covered new-file range is
 * `[c, c + d - 1]` (d omitted → 1). Multi-file diffs, renames (the `+++ b/…`
 * header carries the NEW path), and multiple hunks per file are all
 * supported; binary files (no hunks) and deleted files (`+++ /dev/null`)
 * end up with no ranges → excluded by the filter.
 *
 * Hunk bodies are consumed by COUNT (old-side and new-side line tallies
 * from the header), not by prefix guessing — an added content line starting
 * with `++ ` can otherwise masquerade as a `+++ ` file header.
 */
export function parseDiffHunkRanges(diff: string): Map<string, Array<[number, number]>> {
  const rangesByPath = new Map<string, Array<[number, number]>>();
  /** Ranges of the file whose hunks are being read; null = between files. */
  let current: Array<[number, number]> | null = null;
  /** Remaining hunk-body lines (old/new tallies); 0/0 = between hunks. */
  let remainingOld = 0;
  let remainingNew = 0;
  for (const line of diff.split("\n")) {
    if (remainingOld > 0 || remainingNew > 0) {
      // Inside a hunk body: consume counted lines; header-like content lines
      // (e.g. an added "++ x" rendered as "+++ x") are NEVER misparsed.
      const marker = line.charAt(0);
      if (marker === " " || marker === "-") remainingOld -= 1;
      if (marker === " " || marker === "+") remainingNew -= 1;
      // "\" ("\ No newline at end of file") consumes neither tally.
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = null; // wait for the +++ header to bind the b-side path
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = bSidePath(line.slice(4).trim());
      if (path === null) {
        current = null;
        continue;
      }
      let ranges = rangesByPath.get(path);
      if (ranges === undefined) {
        ranges = [];
        rangesByPath.set(path, ranges);
      }
      current = ranges;
      continue;
    }
    if (current === null) continue;
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk !== null) {
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      current.push([newStart, newStart + newCount - 1]);
      remainingOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      remainingNew = newCount;
    }
  }
  return rangesByPath;
}

/**
 * Layered qualifying filter (AL-3):
 *   - base layer (always): `file_path` non-empty AND `line_end` an integer
 *     ≥ 1 (runtime check: `typeof line_end === "number" && line_end >= 1`;
 *     the integer guarantee comes from the schema's `z.number().int()`
 *     upstream) — findings without a position can never anchor;
 *   - hunk layer (only when the prefetched diff is available): the b-side
 *     path must exact-match a diff file AND `line_end` must fall inside one
 *     of its right-side hunk ranges (binary/deleted files have no right
 *     hunks → excluded).
 * With `diff` undefined (prefetch failed) the base layer alone decides —
 * draft-attempt semantics: GitHub's own validation is the backstop.
 */
export function filterLineCommentFindings(findings: ReviewFinding[], diff?: string): ReviewFinding[] {
  const base = findings.filter(
    (finding) =>
      typeof finding.file_path === "string" &&
      finding.file_path !== "" &&
      typeof finding.line_end === "number" &&
      finding.line_end >= 1,
  );
  if (diff === undefined) return base;
  const hunksByPath = parseDiffHunkRanges(diff);
  return base.filter((finding) => {
    const ranges = hunksByPath.get(finding.file_path ?? "");
    if (ranges === undefined) return false;
    const line = finding.line_end ?? 0;
    return ranges.some(([start, end]) => line >= start && line <= end);
  });
}

/**
 * One line-comment body: title + merge-class tag (engine emoji + class
 * verbatim, the renderFindings vocabulary) + finding body, clamped to the
 * FINDING_BODY_MAX budget (clampFindingSizes bounds title/body
 * individually; the ASSEMBLED comment can still exceed it).
 */
export function buildLineCommentBody(finding: ReviewFinding): string {
  const tag = `${REVIEW_EMOJI[finding.mergeClass]} ${finding.mergeClass}`;
  const body = `**${finding.title}** · ${tag}\n\n${finding.body}`;
  return body.length <= FINDING_BODY_MAX ? body : `${body.slice(0, FINDING_BODY_MAX - 1)}…`;
}

export type FetchPrDiffInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
};

export type PostLineCommentsInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /**
   * The round the overall-comment upsert just posted (postReview's return
   * value) — the required top-level marker body pins itself to it.
   */
  round: number;
  /** Qualifying findings, pre-filtered by the consumer (≥ 1 or NO call). */
  findings: ReviewFinding[];
};

/**
 * Extract the unified-diff string from a `pulls.get` diff-mediaType response
 * (pattern originated from the deleted worker/diff.ts extractDiff — pipeline
 * ↛ worker isolation holds): octokit returns the diff as `data` (string)
 * or nested `data.data`. A non-diff response is a prefetch failure — the
 * consumer falls back to the base-filter attempt.
 */
function extractDiffText(data: unknown): string {
  const candidate = typeof data === "string" ? data : (data as { data?: unknown } | null)?.data;
  if (typeof candidate !== "string" || candidate.length === 0 || !candidate.startsWith("diff --git")) {
    throw new Error(
      "pulls.get did not return a unified diff (expected non-empty string starting with 'diff --git'); check the Accept/mediaType header",
    );
  }
  return candidate;
}

/**
 * Fetch the PR diff against a caller-provided octokit (plan 18 Task 3):
 * `pulls.get` with `mediaType: { format: "diff" }` — the
 * GitHub-schema-documented pattern for validating review-comment positions
 * (same-mode precedent: the deleted worker/diff.ts:226-256, pattern only).
 */
export async function fetchPrDiffWithOctokit(octokit: PostOctokit, input: FetchPrDiffInput): Promise<string> {
  const pullsGet = octokit.rest?.pulls?.get;
  if (!pullsGet) {
    throw new Error(
      "octokit is missing rest.pulls.get — cannot fetch the PR diff for line comments; check the injected auth surface",
    );
  }
  const response = await pullsGet({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    mediaType: { format: "diff" },
  });
  return extractDiffText(response.data);
}

/**
 * Post the line-comments review against a caller-provided octokit (plan 18
 * Task 3 / AL-3): ONE pulls.createReview, `event: "COMMENT"` (D4 permanent
 * event lock — never APPROVE/REQUEST_CHANGES), `commit_id` pinned to the
 * review's head sha, per-comment `{path, side: "RIGHT", line: line_end,
 * body}`. The top-level `body` is REQUIRED for COMMENT events (installed
 * octokit schema: "Required when using REQUEST_CHANGES or COMMENT") and is
 * a marker short line only — never a copy of the overall review body.
 * Empty qualifying set → zero API calls (byte-compat). No `start_line`
 * this iteration; old rounds' line comments stay in place.
 */
export async function postLineCommentsWithOctokit(
  octokit: PostOctokit,
  input: PostLineCommentsInput,
): Promise<void> {
  if (input.findings.length === 0) return;
  const createReview = octokit.rest?.pulls?.createReview;
  if (!createReview) {
    throw new Error(
      "octokit is missing rest.pulls.createReview — cannot post line comments; check the injected auth surface",
    );
  }
  await createReview({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    commit_id: input.headSha,
    event: "COMMENT",
    body: `mstar-inspector line comments · round ${input.round} · ${input.headSha.slice(0, 7)}`,
    comments: input.findings.map((finding) => ({
      path: finding.file_path,
      side: "RIGHT",
      line: finding.line_end,
      body: buildLineCommentBody(finding),
    })),
  });
}

/**
 * Production commenter: createAppAuth (APP_ID + normalized PRIVATE_KEY) →
 * per-installation octokit via the documented factory pattern. The
 * createAppAuth instance is memoized so its installation-token cache is
 * shared across calls (auth-app default: tokens cached until expiry).
 *
 * This factory is the ONLY createAppAuth construction point in the pipeline
 * (architect lock L4, plan 13): every credential enters through the
 * `CommenterEnv` parameter — every per-App instance (consumer-side appRef
 * resolution, src/pipeline/consumer.ts) is built here, one instance per
 * credential so each App keeps its own installation-token cache. Octokit
 * construction stays inside this module; call sites never duplicate it.
 */
export function createReviewCommenter(env: CommenterEnv): ReviewCommenter {
  let appAuth: AppAuthStrategy | null = null;
  async function getAppAuth(): Promise<AppAuthStrategy> {
    if (appAuth === null) {
      appAuth = createAppAuth({ appId: env.APP_ID, privateKey: normalizePrivateKey(env.PRIVATE_KEY) });
    }
    return appAuth;
  }

  /**
   * Per-installation octokit via the documented factory pattern. The real
   * Octokit satisfies PostOctokit at runtime (paginate is bundled with
   * @octokit/rest); the cast bridges the overloaded plugin-paginate-rest
   * types to the minimal surface above.
   */
  async function getOctokit(installationId: number): Promise<PostOctokit> {
    const auth = await getAppAuth();
    const octokit = await auth({
      type: "installation",
      installationId,
      factory: (options: unknown) => new Octokit({ authStrategy: createAppAuth, auth: options }),
    });
    return octokit as unknown as PostOctokit;
  }

  return {
    async getInstallationToken(installationId) {
      const auth = await getAppAuth();
      const installation = await auth({ type: "installation", installationId });
      return installation.token;
    },
    async postReview(input) {
      return postReviewWithOctokit(await getOctokit(input.installationId), input);
    },
    async postDegraded(input) {
      await postDegradedWithOctokit(await getOctokit(input.installationId), input);
    },
    async deleteDegradedComment(input) {
      return deleteDegradedCommentWithOctokit(await getOctokit(input.installationId), input);
    },
    async fetchPrDiff(input) {
      return fetchPrDiffWithOctokit(await getOctokit(input.installationId), input);
    },
    async postLineComments(input) {
      await postLineCommentsWithOctokit(await getOctokit(input.installationId), input);
    },
  };
}
