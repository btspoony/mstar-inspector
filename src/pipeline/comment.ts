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
 * collapse; both chains share the scan/plan/verify mechanics (the shared
 * full-list scan + the bot-marker planners).
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
import type { Assessment, Coverage, Scope, Discussion } from "../contracts/recheck";
import type { LineIntent, VerifiedResolution } from "../store/finding-lifecycle";
import type { D1Like } from "../store/types";
import { listDiscussionWithOctokit, type ListDiscussionInput } from "./discussion-context";
import {
  buildLineBatchMarker,
  buildLineCommentBody,
  createReviewThreads,
  sha256Hex,
  stripInspectorMarkerSyntax,
  type DiscoveryResult,
  type GraphqlOctokit,
  type ResolveOutcome,
} from "./review-threads";

export type { ListDiscussionInput };
export type { DiscoveryResult, ResolveOutcome };

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
 * omitted-findings footer + optional closure section (plan 67 §7.10),
 * finally clamped to REVIEW_BODY_LIMIT (qc2 F-003 / qc3 F-304 — the API
 * never sees an over-limit body). `omittedFindings` is the count of findings
 * dropped by the consumer's merge-class cap (B4) — the footer tells readers
 * the review is a Top-N subset.
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
  closure?: string,
): string {
  const verdict = `**Verdict: ${output.verdict}**`;
  const tally = renderTally(output.tally, output.findings, previousFingerprints);
  const summary = truncateSummary(output.summary_md);
  const findings = renderFindings(output.findings, previousFingerprints);
  const head = tally ? `${verdict}\n\n${tally}` : verdict;
  const body = findings ? `${head}\n\n${summary}\n\n${findings}` : `${head}\n\n${summary}`;
  const withOmitted = omittedFindings > 0 ? `${body}\n\n*(+${omittedFindings} more findings omitted)*` : body;
  const withClosure = closure ? `${withOmitted}\n\n${closure}` : withOmitted;
  return withClosure.length <= REVIEW_BODY_LIMIT ? withClosure : `${withClosure.slice(0, REVIEW_BODY_LIMIT - 1)}…`;
}

// ---------------------------------------------------------------------------
// Closure section (plan 67, spec review-lifecycle §7.10): the per-round
// rendering of the prior-findings recheck. Single upsert only — remote
// resolution outcomes discovered after this publication appear in the NEXT
// round's closure, never a second closure-only comment.
// ---------------------------------------------------------------------------

/** §7.10: at most 25 selected prior rows are shown; the rest is a count. */
export const CLOSURE_MAX_ROWS = 25;

/** One closure table row (§7.10 columns: finding, disposition, evidence, thread). */
export type ClosureRow = {
  /** The ORIGINAL published concern title (never a paraphrase). */
  title: string;
  disposition: Assessment["disposition"];
  reason: Assessment["reason"];
  /** Evidence kind of an addressed verdict, else null. */
  evidenceKind: string | null;
  /**
   * Thread column: "not yet resolved" while the verified resolve is still
   * pending (a pending resolve renders not-yet-resolved, NOT a prediction),
   * "-" when no thread resolution is in flight this round.
   */
  thread: string;
};

export type ClosureCoverage = {
  totalOpen: number;
  selected: number;
  assessed: number;
  omitted: number;
  capped: number;
  contextCoverage: Coverage;
};

/**
 * Render the §7.10 closure section: one honest coverage line, then at most
 * `CLOSURE_MAX_ROWS` rows (finding / disposition / evidence / thread) plus
 * the overflow count. Deterministic; the caller re-clamps via
 * buildReviewBody's budget.
 */
export function buildClosureSection(coverage: ClosureCoverage, rows: ClosureRow[]): string {
  const shown = rows.slice(0, CLOSURE_MAX_ROWS);
  const overflow = rows.length - shown.length;
  const lines: string[] = [
    "## Prior findings recheck",
    "",
    `Reassessed ${coverage.assessed}/${coverage.selected} open prior finding(s) this round` +
      ` · ${coverage.omitted} omitted · ${coverage.capped} over cap · ${coverage.totalOpen} open` +
      ` · context coverage: ${coverage.contextCoverage}`,
  ];
  if (shown.length > 0) {
    lines.push(
      "",
      "| finding | disposition | evidence | thread |",
      "|---|---|---|---|",
      ...shown.map(
        (row) =>
          `| ${row.title.replace(/\|/g, "\\|").replace(/\n/g, " ")} ` +
          `| ${row.disposition} (${row.reason}) ` +
          `| ${row.evidenceKind ?? "-"} ` +
          `| ${row.thread} |`,
      ),
    );
  }
  if (overflow > 0) {
    lines.push("", `*(+${overflow} more prior finding(s) over the ${CLOSURE_MAX_ROWS}-row display cap)*`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prepared publication (plan 67, spec §7.7): the FINAL body is computed and
// durably staged BEFORE any GitHub mutation; the send publishes exactly the
// prepared upsert. The publication identity marker is appended to the round
// marker; model text is stripped of Inspector marker syntax first so the
// trusted markers are always ours (§7.5).
// ---------------------------------------------------------------------------

/**
 * The trusted publication identity marker appended to every prepared
 * publication body (spec §7.7: preserve the existing round marker and append
 * `<!-- mstar-inspector:publication:v1 id=<uuid> sha=<sha> kind=... -->`).
 */
export function buildPublicationMarker(input: { publicationId: string; headSha: string; kind: "review" | "degraded" }): string {
  return `<!-- mstar-inspector:publication:v1 id=${input.publicationId} sha=${input.headSha} kind=${input.kind} -->`;
}

/**
 * Assemble the prepared REVIEW publication body (spec §7.7): the round
 * marker line, the round header, the marker-stripped review body (findings +
 * closure — model text can never forge an Inspector marker), clamped so the
 * appended trusted publication marker stays intact under the body limit.
 */
export function buildPreparedReviewBody(input: {
  output: ReviewOutput;
  omittedFindings: number;
  round: number;
  headSha: string;
  previousFingerprints?: ReadonlySet<string>;
  closure?: string;
  publicationMarker: string;
}): string {
  const roundMarker = `<!-- mstar-inspector:review:v1 round=${input.round} -->`;
  const header = `第 ${input.round} 次 review · commit ${input.headSha.slice(0, 7)}`;
  const core = stripInspectorMarkerSyntax(
    buildReviewBody(input.output, input.omittedFindings, input.previousFingerprints, input.closure),
  );
  const reserve = roundMarker.length + header.length + input.publicationMarker.length + 8;
  const budget = REVIEW_BODY_LIMIT - reserve;
  const clamped = core.length <= budget ? core : `${core.slice(0, Math.max(0, budget - 1))}…`;
  return `${roundMarker}\n${header}\n\n${clamped}\n${input.publicationMarker}`;
}

/**
 * Assemble the prepared DEGRADED publication body (spec §7.7 degraded
 * payload): the degraded chain body (own redaction choke point), stripped of
 * Inspector marker syntax and clamped so the trusted publication marker
 * stays intact.
 */
export function buildPreparedDegradedBody(input: {
  error: string;
  rawOutput: string;
  round: number;
  publicationMarker: string;
}): string {
  const roundMarker = `${DEGRADED_MARKER_PREFIX} round=${input.round} -->`;
  const core = stripInspectorMarkerSyntax(
    buildDegradedBody({ error: input.error, rawOutput: input.rawOutput, round: input.round }),
  );
  const reserve = roundMarker.length + input.publicationMarker.length + 4;
  const budget = REVIEW_BODY_LIMIT - reserve;
  const clamped = core.length <= budget ? core : `${core.slice(0, Math.max(0, budget - 1))}…`;
  return `${roundMarker}\n${clamped}\n${input.publicationMarker}`;
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

// ---------------------------------------------------------------------------
// Purpose-scoped token boundary (plan 67 Task 2, spec §7.6): every mint is
// tied to a purpose + the exact repository, and the SANDBOX grant is checked
// against the RETURNED capabilities (RL-6) — the request is never presented
// as proof of the response. The unrestricted `getInstallationToken(
// installationId)` contract is deleted; every caller migrates to
// `getInstallationToken({ scope, purpose })`.
// ---------------------------------------------------------------------------

export type TokenPurpose = "sandbox-read" | "review-write";

export type InstallationTokenGrant = {
  token: string;
  permissions: Record<string, string>;
  repositoryIds?: number[];
  repositoryNames?: string[];
  repositorySelection?: string;
};

export type TokenInput = { scope: Scope; purpose: TokenPurpose };

/** Explicit requested permission set for the sandbox read grant (spec §7.6). */
export const SANDBOX_READ_PERMISSIONS: Record<string, string> = { contents: "read", metadata: "read" };
/** Explicit requested permission set for Worker review writes (68 adds checks:write). */
export const REVIEW_WRITE_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
};

function permissionsFor(purpose: TokenPurpose): Record<string, string> {
  return purpose === "sandbox-read" ? { ...SANDBOX_READ_PERMISSIONS } : { ...REVIEW_WRITE_PERMISSIONS };
}

/**
 * Returned-capability assertion for the sandbox read grant (spec §7.6 /
 * RL-6): nonempty token, contents+metadata read, EVERY other returned
 * permission read-only, `repositorySelection === "selected"`, and exactly
 * one returned repository equal to the requested one. A missing repository
 * list/selection or any broader grant fails closed — throws.
 */
export function assertSandboxGrant(grant: InstallationTokenGrant, expectedRepo: string): void {
  if (typeof grant.token !== "string" || grant.token.length === 0) {
    throw new Error("sandbox grant rejected: empty token");
  }
  const permissions = grant.permissions ?? {};
  if (permissions.contents !== "read" || permissions.metadata !== "read") {
    throw new Error("sandbox grant rejected: contents/metadata must be returned read");
  }
  for (const [name, value] of Object.entries(permissions)) {
    if (name === "contents" || name === "metadata") continue;
    if (value !== "read") {
      throw new Error(`sandbox grant rejected: returned permission ${name} is not read-only`);
    }
  }
  if (grant.repositorySelection !== "selected") {
    throw new Error(`sandbox grant rejected: repositorySelection must be "selected", got ${JSON.stringify(grant.repositorySelection ?? null)}`);
  }
  const names = grant.repositoryNames ?? [];
  if (names.length !== 1 || names[0] !== expectedRepo) {
    throw new Error(`sandbox grant rejected: exactly one returned repository equal to ${JSON.stringify(expectedRepo)} is required, got ${JSON.stringify(names)}`);
  }
}

/** Coordinates for one PR's marker-comment scans (plan faces + prepared sends). */
export type CommenterTargetInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
};

/**
 * Prepared-publication send input (plan 67 §7.7 step 8): the EXACT body was
 * durably staged before this call; `targetCommentId`/`round` come from the
 * pre-staging plan. The send validates the target's expected previous version
 * (or an already-matching exact body) and publishes the prepared body
 * verbatim — a newer publication is never overwritten.
 */
export type PostPreparedReviewInput = CommenterTargetInput & {
  headSha: string;
  round: number;
  /** The comment id the pre-staging plan targeted (null = create). */
  targetCommentId: number | null;
  body: string;
  publicationId: string;
};

export type PostPreparedDegradedInput = CommenterTargetInput & {
  headSha: string;
  round: number;
  targetCommentId: number | null;
  body: string;
  publicationId: string;
};

export type ReviewCommenter = {
  /**
   * Mint a PURPOSE-SCOPED, repository-scoped installation grant (plan 67
   * §7.6): `sandbox-read` requests {contents:read, metadata:read};
   * `review-write` requests the Worker write set. The grant is minted
   * through the single createAppAuth object (token cache keyed by
   * installation/repository/permissions) — callers on the sandbox path MUST
   * verify the RETURNED grant via `assertSandboxGrant` (RL-6).
   */
  getInstallationToken(input: TokenInput): Promise<InstallationTokenGrant>;
  /**
   * Pre-staging plan read (plan 67 §7.7: "Calculate round/target from the
   * authenticated App's current single comment BEFORE staging"): the same
   * bot-marker scan the upsert used, surfaced so the consumer can compute
   * round/targetCommentId and stage the exact prepared body. Read-only.
   */
  planReviewUpsert(input: CommenterTargetInput): Promise<UpsertPlan>;
  /** planReviewUpsert for the degraded chain (independent marker family). */
  planDegradedUpsert(input: CommenterTargetInput): Promise<UpsertPlan>;
  /**
   * Publish the EXACT prepared review body (§7.7 step 8): validate the
   * target's expected previous version (or an already-matching exact
   * marker/body — the replay case), send the prepared body verbatim, and
   * require the returned comment id (an unprovable publication is never
   * claimed). A newer publication is never overwritten — a target-version
   * mismatch throws.
   */
  postPreparedReview(input: PostPreparedReviewInput): Promise<{ commentId: number }>;
  /** postPreparedReview for the degraded chain; the id may be uncaptured (null). */
  postPreparedDegraded(input: PostPreparedDegradedInput): Promise<{ posted: boolean; commentId: number | null }>;
  /**
   * Delete stale bot-authored `review-degraded:v1` comments (Bugbot
   * finding — degraded-comment lifecycle): the success path calls this
   * best-effort once a real review supersedes the degradation. NEVER
   * throws — returns the outcome (deleted/skipped/errors) for the
   * consumer's warn-only log line.
   */
  deleteDegradedComment(input: PostDegradedInput): Promise<DegradedDeleteOutcome>;
  /**
   * Post the INTENT-prepared line-comments review (plan 67 §7.7 step 10):
   * ONE pulls.createReview with `event: "COMMENT"` (D4 event lock), the
   * line-batch marker body, and per-intent bodies carrying the trusted
   * thread marker (§7.5). Returns the §7.7 capture result: returned comment
   * ids mapped back to the intents' association ids. Throws on any Octokit
   * error — the consumer's never-throw guard is the catch site.
   */
  postLineComments(input: PostPreparedLineCommentsInput): Promise<PostedLineComments>;
  /**
   * Bounded discussion capture (plan 67 §7.8): newest-first GraphQL issue
   * comments (≤2 pages) + each known thread conversation (≤2 pages), with
   * three-valued coverage and §7.5 digests. API failure is `unavailable`.
   */
  listDiscussion(input: ListDiscussionInput): Promise<Discussion>;
  /**
   * §7.5 thread identity surface — present only when the commenter is
   * constructed with the thread store (`createReviewCommenter(env, { db })`);
   * absent (undefined) otherwise. `discoverThread` proves ownership from the
   * prepared association BEFORE any adoption; `resolveFindingThread` applies
   * the verified resolution behind the §7.5 fences. T4 owns the consumer
   * call ordering.
   */
  discoverThread?(input: { scope: Scope; intent: LineIntent; reviewId: number | null }): Promise<DiscoveryResult>;
  resolveFindingThread?(input: {
    scope: Scope;
    associationId: string;
    verified: VerifiedResolution;
  }): Promise<ResolveOutcome>;
};
/**
 * Structural auth surface for the createAppAuth strategy. `AuthInterface` is
 * not exported by @octokit/auth-app, so the surface is named here; the real
 * strategy is assignable (same pattern as the deleted worker/diff.ts
 * AppAuth, plan 04). With a factory the call resolves to the factory's
 * return (the octokit); without one it resolves to the installation access
 * grant — auth-app 8.3.0 maps the response's `permissions`,
 * `repository_selection` and `repositories[].id/name` into `permissions`,
 * `repositorySelection`, `repositoryIds`/`repositoryNames` (spec §7.6), and
 * its token cache is keyed by installation/repository/permissions.
 */
export type AppAuthStrategy = {
  /** App-level JWT (spec §7.5: JWT-authenticated `GET /app` identity proof). */
  (options: { type: "app" }): Promise<{ token: string }>;
  (options: {
    type: "installation";
    installationId: number;
    repositoryNames?: string[];
    permissions?: Record<string, string>;
  }): Promise<InstallationTokenGrant>;
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
     * Pulls surface for plan 67 Task 4 line comments: `createReview`
     * (COMMENT-event delivery of the prepared line intents). Optional and
     * guarded — the marker-comment chains never touch it, and the
     * line-comment path fails soft through the consumer's catch.
     */
    pulls?: {
      createReview?: (parameters: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

/** PR coordinates shared by both marker-comment chains. */
type CommentTarget = { owner: string; repo: string; prNumber: number };

/**
 * The full-comment-list scan behind every marker chain (WF-001:
 * `issues.listComments` caps at 100 per page — on a busy PR the app's marker
 * can sit beyond page 1, so every plan/send/delete scan paginates the FULL
 * list). Guards the octokit surface with the per-chain error noun.
 */
async function scanCommentsWithOctokit(octokit: PostOctokit, target: CommentTarget, surface: "review" | "degraded"): Promise<ReviewComment[]> {
  const issues = octokit.rest?.issues;
  if (!issues?.listComments || !issues?.updateComment || !issues?.createComment || typeof octokit.paginate !== "function") {
    throw new Error(
      `octokit is missing rest.issues comment methods / paginate — cannot upsert the ${surface} comment; check the injected auth surface`,
    );
  }
  return octokit.paginate(issues.listComments, {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.prNumber,
    per_page: 100,
  });
}

/**
 * Pre-staging plan read against a caller-provided octokit (plan 67 §7.7):
 * the same bot-marker scan the upsert used, exported for the consumer to
 * compute round/targetCommentId BEFORE staging the exact prepared body.
 * Read-only — no mutation.
 */
export async function planReviewUpsertWithOctokit(octokit: PostOctokit, input: CommenterTargetInput): Promise<UpsertPlan> {
  const comments = await scanCommentsWithOctokit(octokit, input, "review");
  return planUpsert(comments);
}

/** planReviewUpsertWithOctokit for the degraded chain (independent marker family). */
export async function planDegradedUpsertWithOctokit(octokit: PostOctokit, input: CommenterTargetInput): Promise<UpsertPlan> {
  const comments = await scanCommentsWithOctokit(octokit, input, "degraded");
  return planDegradedUpsert(comments);
}

/**
 * Publish the EXACT prepared review body against a caller-provided octokit
 * (plan 67 §7.7 step 8). Before sending, the target is RE-READ and must
 * show its expected previous version — or an already-matching exact
 * marker/body (the response-lost replay case, adopted without mutation):
 *   - update plan: the target comment must still be bot-authored with the
 *     expected round (= prepared round - 1). Deleted → create fallback with
 *     the SAME prepared body (the round never increments on retry). Changed
 *     (newer round / replaced body) → definitive rejection (throw) — a
 *     newer publication is never overwritten by an older send.
 *   - create plan: a bot review-marker comment appearing between plan and
 *     send is adopted only when it already carries the exact prepared body;
 *     any other marker is a definitive rejection.
 * The send publishes the prepared body VERBATIM; a create response without
 * an id is an unprovable publication and throws.
 */
export async function postPreparedReviewWithOctokit(octokit: PostOctokit, input: PostPreparedReviewInput): Promise<{ commentId: number }> {
  const issues = octokit.rest?.issues;
  if (!issues?.listComments || !issues?.updateComment || !issues?.createComment || typeof octokit.paginate !== "function") {
    throw new Error(
      "octokit is missing rest.issues comment methods / paginate — cannot publish the prepared review; check the injected auth surface",
    );
  }
  const comments = await scanCommentsWithOctokit(octokit, input, "review");
  const parsedRound = (body: string | null | undefined): number | null =>
    body ? parseReviewRound(body) : null;

  if (input.targetCommentId !== null) {
    const target = comments.find((c) => c.id === input.targetCommentId);
    if (target === undefined) {
      // The planned target is gone (deleted mid-flight) — create fallback
      // with the SAME prepared body; the prepared round is never recomputed.
      return createPreparedComment(issues, input);
    }
    if (target.body === input.body) {
      return { commentId: target.id }; // replay adoption — exact body already published
    }
    if (target.user?.type !== "Bot" || parsedRound(target.body) !== input.round - 1) {
      throw new Error(
        `prepared review target ${input.targetCommentId} no longer shows its expected previous version (round ${input.round - 1}) — refusing to overwrite (spec §7.7)`,
      );
    }
    try {
      await issues.updateComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: target.id,
        body: input.body,
      });
      return { commentId: target.id };
    } catch (err) {
      // qc2 F-002 parity with a STAGED body: 404 (deleted mid-flight) or 403
      // (foreign App's bot marker — we can never edit it) makes the target
      // dead; the prepared publication is NOT recomputed (a retry never
      // increments the round) and falls back to CREATE with the exact
      // prepared body. Any other error rethrows.
      const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
      if (status === 404 || status === 403) {
        return createPreparedComment(issues, input);
      }
      throw err;
    }
  }

  // Create plan: adopt an exact-body replay; any other bot review marker
  // that appeared since the plan is a definitive rejection.
  const markerComments = comments.filter((c) => c.user?.type === "Bot" && parsedRound(c.body) !== null);
  for (const marker of markerComments) {
    if (marker.body === input.body) return { commentId: marker.id };
    throw new Error(
      `a bot review marker (comment ${marker.id}) appeared after the pre-staging plan — refusing to create a second publication (spec §7.7)`,
    );
  }
  return createPreparedComment(issues, input);
}

/** Create with the exact prepared body; require the response id. */
async function createPreparedComment(
  issues: NonNullable<PostOctokit["rest"]>["issues"],
  input: PostPreparedReviewInput,
): Promise<{ commentId: number }> {
  const created = (await issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    body: input.body,
  })) as { data?: { id?: unknown } } | undefined;
  const id = created?.data?.id;
  if (typeof id !== "number") {
    throw new Error(
      "review comment create response carries no comment id — refusing to claim an unprovable publication (spec §7.7 step 8)",
    );
  }
  return { commentId: id };
}

/**
 * Publish the EXACT prepared degraded body (plan 67 §7.7 degraded payload).
 * Same target-version mechanics as the review chain; the degraded chain is
 * best-effort at the consumer, so a missing create-response id degrades to
 * `commentId: null` instead of throwing.
 */
export async function postPreparedDegradedWithOctokit(
  octokit: PostOctokit,
  input: PostPreparedDegradedInput,
): Promise<{ posted: boolean; commentId: number | null }> {
  const issues = octokit.rest?.issues;
  if (!issues?.listComments || !issues?.updateComment || !issues?.createComment || typeof octokit.paginate !== "function") {
    throw new Error(
      "octokit is missing rest.issues comment methods / paginate — cannot publish the prepared degraded comment; check the injected auth surface",
    );
  }
  const comments = await scanCommentsWithOctokit(octokit, input, "degraded");
  const degradedRoundOf = (body: string | null | undefined): number | null => {
    if (!body || !body.startsWith(DEGRADED_MARKER_PREFIX)) return null;
    return parseDegradedRound(body);
  };

  if (input.targetCommentId !== null) {
    const target = comments.find((c) => c.id === input.targetCommentId);
    if (target === undefined) {
      const created = (await issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.prNumber,
        body: input.body,
      })) as { data?: { id?: unknown } } | undefined;
      const id = created?.data?.id;
      return { posted: true, commentId: typeof id === "number" ? id : null };
    }
    if (target.body === input.body) return { posted: true, commentId: target.id };
    if (target.user?.type !== "Bot" || degradedRoundOf(target.body) !== input.round - 1) {
      throw new Error(
        `prepared degraded target ${input.targetCommentId} no longer shows its expected previous version (round ${input.round - 1}) — refusing to overwrite (spec §7.7)`,
      );
    }
    try {
      await issues.updateComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: target.id,
        body: input.body,
      });
      return { posted: true, commentId: target.id };
    } catch (err) {
      // Same dead-target parity as the review chain: 403/404 → create
      // fallback with the exact prepared body; other errors rethrow.
      const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
      if (status === 404 || status === 403) {
        const created = (await issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.prNumber,
          body: input.body,
        })) as { data?: { id?: unknown } } | undefined;
        const id = created?.data?.id;
        return { posted: true, commentId: typeof id === "number" ? id : null };
      }
      throw err;
    }
  }

  for (const marker of comments.filter((c) => c.user?.type === "Bot" && degradedRoundOf(c.body) !== null)) {
    if (marker.body === input.body) return { posted: true, commentId: marker.id };
    throw new Error(
      `a bot degraded marker (comment ${marker.id}) appeared after the pre-staging plan — refusing to create a second publication (spec §7.7)`,
    );
  }
  const created = (await issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    body: input.body,
  })) as { data?: { id?: unknown } } | undefined;
  const id = created?.data?.id;
  return { posted: true, commentId: typeof id === "number" ? id : null };
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
  const comments = await scanCommentsWithOctokit(octokit, input, "degraded");
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
 * The marker-LESS per-finding comment text (title + merge-class tag +
 * finding body, clamped to the FINDING_BODY_MAX budget). This is the
 * `LineIntent.body` payload — the TRUSTED thread marker is appended later by
 * the §7.5 `buildLineCommentBody` at send time (plan 67 Task 4: the legacy
 * marker-less posting path is replaced by the intent-driven path, so thread
 * discovery has a marker to pin).
 */
export function renderLineCommentText(finding: ReviewFinding): string {
  const tag = `${REVIEW_EMOJI[finding.mergeClass]} ${finding.mergeClass}`;
  const body = `**${finding.title}** · ${tag}\n\n${finding.body}`;
  return body.length <= FINDING_BODY_MAX ? body : `${body.slice(0, FINDING_BODY_MAX - 1)}…`;
}

/**
 * §7.7 line-comment capture result (plan 67 Task 4): the returned review
 * comments mapped back to the posted intents. `posted[].associationId` is
 * the intent's association id (every posted comment carries a trusted
 * thread marker now). `ambiguous` lists `path:line` descriptors that could
 * not be uniquely matched to a returned comment; `captured` is true only
 * when the response carried the created comments and every intent mapped.
 * `reviewId` is the created review's REST id (null when not returned) — the
 * value `discoverThread` pins discovery to.
 */
export type PostedLineComments = {
  posted: { associationId: string; commentId: number; path: string; line: number }[];
  ambiguous: string[];
  captured: boolean;
  reviewId: number | null;
};

export type PostPreparedLineCommentsInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** The round the prepared review publication posted. */
  round: number;
  /** The staged publication id — the line-batch marker pins to it (§7.5). */
  publicationId: string;
  /** Prepared line intents (≥ 1 or NO call), pre-built by the consumer. */
  intents: LineIntent[];
};

/**
 * Post the INTENT-prepared line-comments review against a caller-provided
 * octokit (plan 67 §7.7 step 10 / §7.5): ONE pulls.createReview,
 * `event: "COMMENT"` (D4 permanent event lock — never APPROVE/
 * REQUEST_CHANGES), `commit_id` pinned to the review's head sha, the
 * REQUIRED top-level body carrying the trusted line-batch marker
 * (`mstar-inspector:line-batch:v1`), and per-intent comments whose bodies
 * come from the §7.5 `buildLineCommentBody` — untrusted intent text stripped
 * of Inspector marker syntax, trusted thread marker appended. The intents'
 * bodies/digests were durably staged before any mutation (§7.7 step 7).
 *
 * Returns the §7.7 capture result: returned comment ids matched back to the
 * intents by exact path+line; a non-unique match lands in `ambiguous` and
 * is never fabricated. Empty intent set → zero API calls.
 */
export async function postLineCommentsWithOctokit(
  octokit: PostOctokit,
  input: PostPreparedLineCommentsInput,
): Promise<PostedLineComments> {
  if (input.intents.length === 0) {
    return { posted: [], ambiguous: [], captured: true, reviewId: null };
  }
  const createReview = octokit.rest?.pulls?.createReview;
  if (!createReview) {
    throw new Error(
      "octokit is missing rest.pulls.createReview — cannot post line comments; check the injected auth surface",
    );
  }
  const response = (await createReview({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    commit_id: input.headSha,
    event: "COMMENT",
    body: `mstar-inspector line comments · round ${input.round} · ${input.headSha.slice(0, 7)}\n${buildLineBatchMarker(input.publicationId)}`,
    comments: input.intents.map((intent) => ({
      path: intent.path,
      side: "RIGHT",
      line: intent.line,
      body: buildLineCommentBody({
        body: intent.body,
        publicationId: intent.publicationId,
        associationId: intent.associationId,
      }),
    })),
  })) as {
    data?: { id?: unknown; comments?: Array<{ id?: unknown; path?: unknown; line?: unknown }> | null };
  } | undefined;

  const returned = Array.isArray(response?.data?.comments) ? response!.data!.comments! : null;
  const reviewIdRaw = response?.data?.id;
  const reviewId = typeof reviewIdRaw === "number" ? reviewIdRaw : null;
  const posted: PostedLineComments["posted"] = [];
  const ambiguous: string[] = [];
  if (returned === null) {
    // No returned comments in the response — nothing can be captured.
    return { posted: [], ambiguous: [], captured: false, reviewId };
  }
  for (const intent of input.intents) {
    const matches = returned.filter(
      (c) => c.path === intent.path && c.line === intent.line && typeof c.id === "number",
    );
    if (matches.length === 1) {
      posted.push({
        associationId: intent.associationId,
        commentId: matches[0]!.id as number,
        path: intent.path,
        line: intent.line,
      });
    } else {
      ambiguous.push(`${intent.path}:${intent.line}`);
    }
  }
  return { posted, ambiguous, captured: ambiguous.length === 0 && posted.length === input.intents.length, reviewId };
}

/**
 * Production commenter: createAppAuth (APP_ID + normalized PRIVATE_KEY) —
 * the ONLY createAppAuth construction point in the pipeline (architect lock
 * L4, plan 13): every credential enters through the `CommenterEnv`
 * parameter — every per-App instance (consumer-side appRef resolution,
 * src/pipeline/consumer.ts) is built here, one instance per credential so
 * each App keeps its own installation-token cache. Octokit construction
 * stays inside this module; call sites never duplicate it.
 *
 * Purpose-scoped clients (plan 67 §7.6): every octokit is built from a
 * minted grant — `auth({type:"installation", repositoryNames:[repo],
 * permissions})` through the memoized auth object, then a token-
 * authenticated `Octokit({auth: grant.token})` for that exact
 * purpose/repository. The old unrestricted factory auto-auth
 * (`factory: (options) => new Octokit({authStrategy: createAppAuth, …})`)
 * is deleted — no client refreshes or widens its own grant, and a token
 * client never leaves the Worker. auth-app's cache is keyed by
 * installation/repository/permissions, so the two purpose families never
 * cross-reuse tokens.
 */
export function createReviewCommenter(env: CommenterEnv, threads?: { db: D1Like; nowMs?: () => number }): ReviewCommenter {
  let appAuth: AppAuthStrategy | null = null;
  async function getAppAuth(): Promise<AppAuthStrategy> {
    // Local capture: the closure variable's null state cannot be narrowed
    // across awaits by TS. The cast is the documented AppAuthStrategy seam —
    // auth-app's AuthInterface overloads are not structurally writable to the
    // named surface, but the runtime strategy satisfies it.
    let auth = appAuth;
    if (auth === null) {
      auth = createAppAuth({ appId: env.APP_ID, privateKey: normalizePrivateKey(env.PRIVATE_KEY) }) as unknown as AppAuthStrategy;
      appAuth = auth;
    }
    return auth;
  }

  /**
   * Mint the purpose-scoped grant (the single mint path — the returned
   * grant's capabilities are the GitHub response, not the request).
   */
  async function mintGrant(input: { installationId: number; repo: string; purpose: TokenPurpose }): Promise<InstallationTokenGrant> {
    const auth = await getAppAuth();
    return auth({
      type: "installation",
      installationId: input.installationId,
      repositoryNames: [input.repo],
      permissions: permissionsFor(input.purpose),
    });
  }

  /**
   * Token-authenticated octokit for the exact purpose/repository. The real
   * Octokit satisfies PostOctokit at runtime (paginate is bundled with
   * @octokit/rest); the cast bridges the overloaded plugin-paginate-rest
   * types to the minimal surface above.
   */
  async function getOctokit(input: { installationId: number; repo: string }): Promise<PostOctokit> {
    const grant = await mintGrant({ ...input, purpose: "review-write" });
    return new Octokit({ auth: grant.token }) as unknown as PostOctokit;
  }

  /**
   * JWT-authenticated `GET /app` identity proof (spec §7.5): the numeric
   * App id + nonblank slug of the LIVE App behind THIS instance's
   * credentials — never an installation-token `viewer.login` assumption.
   * Memoized per credential identity (this instance is one App's
   * credential pair — never shared across Apps).
   */
  let cachedIdentity: { githubAppId: number; slug: string } | null | undefined;
  async function getAppIdentity(): Promise<{ githubAppId: number; slug: string } | null> {
    if (cachedIdentity !== undefined) return cachedIdentity;
    try {
      const auth = await getAppAuth();
      const { token } = await auth({ type: "app" });
      // The installed rest-endpoint types omit `apps.get` on this Octokit
      // build — the runtime method exists; the cast pins only the response
      // fields consumed below (identity proof, spec §7.5).
      const octokit = new Octokit({ auth: token });
      const { data } = await (octokit.rest.apps as unknown as { get: () => Promise<{ data: { id?: unknown; slug?: unknown } }> }).get();
      cachedIdentity =
        typeof data?.id === "number" && typeof data?.slug === "string" && data.slug.length > 0
          ? { githubAppId: data.id, slug: data.slug }
          : null;
    } catch {
      cachedIdentity = null; // identity unavailable fails closed downstream
    }
    return cachedIdentity;
  }

  /** Purpose-scoped review-write client exposing the existing graphql(). */
  async function getGraphqlOctokit(input: { installationId: number; repo: string }): Promise<GraphqlOctokit> {
    return (await getOctokit(input)) as unknown as GraphqlOctokit;
  }

  // §7.5 adapter (plan 67 Task 2): wired only when the caller binds the
  // thread store — the two optional methods stay undefined otherwise.
  const threadSurface = threads
    ? createReviewThreads({
        db: threads.db,
        nowMs: threads.nowMs ?? (() => Date.now()),
        getAppIdentity: async () => getAppIdentity(),
        getOctokit: async ({ installationId, repo }) => getGraphqlOctokit({ installationId, repo }),
      })
    : null;

  return {
    ...(threadSurface
      ? {
          discoverThread: (input: { scope: Scope; intent: LineIntent; reviewId: number | null }) =>
            threadSurface.discoverThread(input),
          resolveFindingThread: (input: { scope: Scope; associationId: string; verified: VerifiedResolution }) =>
            threadSurface.resolveFindingThread(input),
        }
      : {}),
    async getInstallationToken(input) {
      return mintGrant({
        installationId: input.scope.installationId,
        repo: input.scope.repo,
        purpose: input.purpose,
      });
    },
    async planReviewUpsert(input) {
      return planReviewUpsertWithOctokit(await getOctokit({ installationId: input.installationId, repo: input.repo }), input);
    },
    async planDegradedUpsert(input) {
      return planDegradedUpsertWithOctokit(await getOctokit({ installationId: input.installationId, repo: input.repo }), input);
    },
    async postPreparedReview(input) {
      return postPreparedReviewWithOctokit(await getOctokit({ installationId: input.installationId, repo: input.repo }), input);
    },
    async postPreparedDegraded(input) {
      return postPreparedDegradedWithOctokit(await getOctokit({ installationId: input.installationId, repo: input.repo }), input);
    },
    async deleteDegradedComment(input) {
      return deleteDegradedCommentWithOctokit(await getOctokit({ installationId: input.installationId, repo: input.repo }), input);
    },
    async postLineComments(input) {
      return postLineCommentsWithOctokit(await getOctokit({ installationId: input.installationId, repo: input.repo }), input);
    },
    async listDiscussion(input) {
      const octokit = await getOctokit({ installationId: input.installationId, repo: input.repo });
      return listDiscussionWithOctokit(octokit as unknown as GraphqlOctokit, input);
    },
  };
}
