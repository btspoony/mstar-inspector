import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { REVIEW_EMOJI, renderReviewMarkdown } from "@mstar-harness/engine";
import {
  FINDING_BODY_MAX,
  dropAllSuggestionFences,
  dropUnsafeFences,
  type ReviewFinding,
  type ReviewOutput,
} from "../review/schema";
import { redactSecrets } from "./redact";
import { isBudgetRefusal } from "../contracts/recovery-budget";
import type { Assessment, Coverage, Scope, Discussion } from "../../packages/shared/src/recheck-wire";
import { ASSESSMENT_TARGET_CAP } from "../../packages/shared/src/recheck-wire";
import type { ReportDoc } from "../../packages/shared/src/report-wire";
import { partialSeatCoverageLine, type ReviewCoverage } from "../../packages/shared/src/coverage-wire";
import { claimDegradedTarget, hasUnprovenDegradedPublication, releaseDegradedTarget, type Lease, type LineIntent, type VerifiedResolution } from "../store/finding-lifecycle";
import type { D1Like } from "../store/types";
import { listDiscussionWithOctokit, type ListDiscussionInput } from "./discussion-context";
import {
  buildLineBatchMarker,
  buildLineCommentBody,
  createReviewThreads,
  parseLineBatchMarker,
  parseLineMarker,
  sha256Hex,
  stripInspectorMarkerSyntax,
  type DiscoveryResult,
  type GraphqlOctokit,
  type ResolveOutcome,
} from "./review-threads";
import { createChecksAdapter, openPublicationFence, type ChecksAdapter, type ChecksOctokit, type PublicationFence } from "./checks";
import {
  DEGRADED_MARKER_PREFIX,
  DEGRADED_MARKER_RE,
  REVIEW_MARKER_PREFIX,
  REVIEW_MARKER_RE,
} from "./review-markers";
import { classifyGithubRateLimit } from "../contracts/failure-stages";

export type { ListDiscussionInput };
export type { DiscoveryResult, ResolveOutcome };

/** summary_md budget for the overall review body. */
export const SUMMARY_MD_LIMIT = 8000;

/**
 * Hard ceiling on the assembled review body (qc2 F-003 / qc3 F-304): GitHub
 * Issues comments cap the body at 65536 chars — an over-limit body would
 * fail at createComment/updateComment AFTER the container model run, and
 * every queue retry would fail again (→ DLQ). The ceiling leaves room for
 * the upsert marker + round header (~80 chars) on top.
 */
export const REVIEW_BODY_LIMIT = 65000;

function openFoldCount(text: string): number {
  return (text.match(/<details>/g) ?? []).length - (text.match(/<\/details>/g) ?? []).length;
}

/**
 * Truncate summary_md to the body budget (char-based; GitHub counts chars).
 * A narrative may carry its own fence or `<details>`; left open, the rest of
 * the body renders inside it, so the cut closes both and pays for them. The
 * closers count against `limit` in EVERY branch: an untouched narrative that
 * fits with its closers is returned whole, otherwise it is shortened again.
 */
export function truncateSummary(md: string, limit: number = SUMMARY_MD_LIMIT): string {
  const closers = closersFor(md);
  if (md.length + closers.length <= limit) return `${md}${closers}`;
  let head = sliceWithoutSplittingPair(md, limit - 1);
  for (;;) {
    const headClosers = closersFor(head);
    const next = sliceWithoutSplittingPair(head, Math.max(0, limit - 1 - headClosers.length));
    if (next === head) return `${head}${headClosers}…`;
    head = next;
  }
}


const FACT_LINE_BUDGET = 500;

function sliceWithoutSplittingPair(text: string, end: number): string {
  const lastKept = text.charCodeAt(end - 1);
  return text.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? end - 1 : end);
}

function boundFactLine(text: string): string {
  return text.length <= FACT_LINE_BUDGET ? text : `${sliceWithoutSplittingPair(text, FACT_LINE_BUDGET - 1)}…`;
}

function boundIncomplete(fact: { reason: string; unscanned: readonly string[] }): {
  reason: string;
  unscanned: string[];
} {
  const reason = boundFactLine(fact.reason);
  if (fact.unscanned.length === 0) return { reason, unscanned: [] };
  const full = fact.unscanned.join(", ");
  if (full.length <= FACT_LINE_BUDGET) return { reason, unscanned: [full] };
  const kept: string[] = [];
  for (const scope of fact.unscanned) {
    const droppedIfAdded = fact.unscanned.length - kept.length - 1;
    const candidate = [...kept, scope].join(", ");
    const marker = droppedIfAdded > 0 ? `, (+${droppedIfAdded} more)` : "";
    if (candidate.length + marker.length > FACT_LINE_BUDGET) break;
    kept.push(scope);
  }
  if (kept.length === 0) {
    kept.push(`${sliceWithoutSplittingPair(fact.unscanned[0]!, FACT_LINE_BUDGET - 12)}…`);
  }
  const dropped = fact.unscanned.length - kept.length;
  const line = kept.join(", ");
  const withCount = dropped === 0 ? line : `${line}, (+${dropped} more)`;
  return { reason, unscanned: [boundFactLine(withCount)] };
}

function closerForOpenFence(text: string): string {
  let open: { ch: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) continue;
    const run = fence[1]!;
    const ch = run[0]!;
    const info = fence[2] ?? "";
    if (open === null) {
      if (ch === "~" || !info.includes("`")) open = { ch, len: run.length };
    } else if (ch === open.ch && run.length >= open.len && info.trim() === "") {
      open = null;
    }
  }
  return open === null ? "" : `\n${open.ch.repeat(open.len)}`;
}

function closersFor(text: string): string {
  return closerForOpenFence(text) + "\n\n</details>".repeat(Math.max(0, openFoldCount(text)));
}

function clampKeepingHead(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = sliceWithoutSplittingPair(text, Math.max(0, budget - 1));
  const closers = closersFor(head);
  const room = budget - 1 - closers.length;
  if (closers === "" || room <= 0) return `${head}…`;
  return `${sliceWithoutSplittingPair(head, room)}${closers}…`;
}

function stripFactEcho(
  narrative: string,
  raw: { reason: string; unscanned: readonly string[] },
  bounded: { reason: string; unscanned: readonly string[] },
): string {
  const echo = new Set<string>();
  for (const fact of [raw, bounded]) {
    echo.add(`cause: ${fact.reason}`);
    echo.add(fact.unscanned.length === 0 ? "unscanned: none" : `unscanned: ${fact.unscanned.join(", ")}`);
  }
  return narrative.split("\n").filter((line) => !echo.has(line)).join("\n");
}

/**
 * Assemble the overall review body: the engine's own layout, then the two
 * facts it has no vocabulary for — the omitted-findings footer (merge-class
 * cap) and the report sections — clamped to `limit` (qc2 F-003 / qc3 F-304 —
 * the API never sees an over-limit body).
 * `omittedFindings` is the count dropped by the consumer's merge-class cap
 * (B4): the footer tells readers the review is a Top-N subset.
 *
 * The omitted-findings footer and the report tail are reserved BEFORE the
 * clamp: the clamp keeps the head, so a part appended first would be the first
 * thing lost on a long body. The core is what gets shortened; the tail is only
 * degraded when it cannot fit alone. `limit` lets the prepared body pass its
 * marker-reserved ceiling, so the two clamps agree on what the tail may consume.
 */
export function buildReviewBody(
  output: ReviewOutput,
  omittedFindings = 0,
  reportParts?: { report: ReportDoc | null; revalidated: string },
  limit = REVIEW_BODY_LIMIT,
  seatCoverage?: ReviewCoverage | null,
): string {
  let rendered = output;
  if (output.incomplete !== undefined) {
    const bounded = boundIncomplete(output.incomplete);
    rendered = { ...rendered, incomplete: bounded };
    if (rendered.tally !== undefined) {
      rendered = { ...rendered, tally: { ...rendered.tally, incomplete: bounded } };
    }
    if (rendered.summary_md !== undefined) {
      rendered = { ...rendered, summary_md: stripFactEcho(rendered.summary_md, output.incomplete, bounded) };
    }
  }
  rendered = {
    ...rendered,
    summary_md: rendered.summary_md === undefined ? undefined : dropAllSuggestionFences(rendered.summary_md),
    findings: rendered.findings.map((fnd) => ({ ...fnd, body: dropAllSuggestionFences(fnd.body) })),
  };
  if (rendered.summary_md !== undefined) {
    rendered = { ...rendered, summary_md: truncateSummary(rendered.summary_md) };
  }
  let core = renderReviewMarkdown(rendered);
  const closure = reportParts === undefined ? "" : reportParts.revalidated;
  // The seat-coverage statement sits directly under the review core: a partial
  // round says what it did NOT cover before anything else in the tail.
  const seatLine = partialSeatCoverageLine(seatCoverage);
  const footer = omittedFindings > 0 ? `*(+${omittedFindings} more findings omitted)*` : "";
  const closureReserve = closure === "" ? 0 : closure.length + 2;
  const seatReserve = seatLine === "" ? 0 : seatLine.length + 2;
  const footerReserve = footer === "" ? 0 : footer.length + 2;
  const tail =
    reportParts === undefined
      ? ""
      : buildReportTail(reportParts.report, limit - closureReserve - seatReserve - footerReserve);
  if (reportParts !== undefined) {
    core = insertReportFields(core, reportParts.report);
  }
  const reserved = closureReserve + seatReserve + footerReserve + (tail === "" ? 0 : tail.length + 2);
  return [clampKeepingHead(core, limit - reserved), seatLine, closure, footer, tail]
    .filter((part) => part !== "")
    .join("\n\n");
}


/**
 * §7.10: at most this many selected prior rows are shown; the rest is a count.
 * The third face of the round's one row budget (`recheck-wire.ts`): the table
 * can only display rows the seat was sent, so the display cap IS the selection
 * cap rather than a second literal.
 */
export const CLOSURE_MAX_ROWS = ASSESSMENT_TARGET_CAP;

/** One closure table row (§7.10 columns: finding, disposition, evidence, thread). */
export type ClosureRow = {
  title: string;
  disposition: Assessment["disposition"];
  reason: Assessment["reason"];
  evidenceKind: string | null;
  thread: string;
};

export type ClosureCoverage = {
  totalOpen: number;
  selected: number;
  assessed: number;
  invalidOutput: number;
  omitted: number;
  capped: number;
  contextCoverage: Coverage;
};

function closureCoverageLine(coverage: ClosureCoverage): string {
  return (
    `Reassessed ${coverage.assessed}/${coverage.selected} prior finding(s) this round` +
    ` · ${coverage.invalidOutput} invalid-output · ${coverage.omitted} omitted` +
    ` · ${coverage.capped} over cap · ${coverage.totalOpen} recheckable` +
    ` · context coverage: ${coverage.contextCoverage}`
  );
}

function priorFindingLines(rows: ClosureRow[]): string[] {
  const shown = rows.slice(0, CLOSURE_MAX_ROWS);
  const overflow = rows.length - shown.length;
  const cell = (text: string): string =>
    text.replace(/\n/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replace(/\|/g, "\\|");
  const lines: string[] = [];
  if (shown.length > 0) {
    lines.push(
      "",
      "| finding | disposition | evidence | thread |",
      "|---|---|---|---|",
      ...shown.map(
        (row) =>
          `| ${cell(row.title)} ` +
          `| ${cell(row.disposition)} (${cell(row.reason)}) ` +
          `| ${cell(row.evidenceKind ?? "-")} ` +
          `| ${cell(row.thread)} |`,
      ),
    );
  }
  if (overflow > 0) {
    lines.push("", `*(+${overflow} more prior finding(s) over the ${CLOSURE_MAX_ROWS}-row display cap)*`);
  }
  return lines;
}


const REVIEW_HEADING = "## 📋 Review";
const FINDINGS_HEADING = "### Findings";
const REVALIDATED_OPEN = "<details><summary>Revalidated findings</summary>";
const REVALIDATED_CLOSE = "</details>";

/**
 * The body's ONE prior-findings rendering: a COLLAPSED `<details>` block (the
 * section sits after `### Findings`, so an expanded table would push the
 * current findings down) carrying the §7.10 coverage line and the round's
 * rows. `none` when the round had no prior finding at all, so a first round's
 * body stays clean.
 */
export function buildRevalidatedSection(coverage: ClosureCoverage, rows: ClosureRow[]): string {
  const lines = [REVALIDATED_OPEN];
  if (rows.length === 0 && coverage.totalOpen === 0) {
    lines.push("", "none");
  } else {
    lines.push("", closureCoverageLine(coverage), ...priorFindingLines(rows));
  }
  lines.push("", REVALIDATED_CLOSE);
  return lines.join("\n");
}

function planBlock(planToFix: string | null, budget = Number.POSITIVE_INFINITY): string {
  if (planToFix === null || planToFix === "none") return "none";
  let longest = 2;
  for (const run of planToFix.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  const prefix = `<details><summary>Expand fix plan</summary>\n\n${fence}md\n`;
  const suffix = `\n${fence}\n\n</details>`;
  const room = budget - prefix.length - suffix.length;
  if (room < 1) return "none";
  const plan =
    planToFix.length <= room ? planToFix : `${sliceWithoutSplittingPair(planToFix, room - 1)}…`;
  return `${prefix}${plan}${suffix}`;
}

function insertAfterHeading(body: string, anchor: string, block: string): string {
  const lines = body.split("\n");
  const index = lines.indexOf(anchor);
  if (index < 0) throw new Error(`report anchor missing: ${anchor}`);
  lines.splice(index + 1, 0, "", block);
  return lines.join("\n");
}

const REPORT_STRUCTURE_LINE =
  /^( {0,3})(#{1,6}(?:\s|$)|(?=[^\n]*\|)(?=[^\n]*-)[-|: \t]*$|(?:[-*_][ \t]*){3,}$|(?:=+|-+)[ \t]*$|`{3,}|~{3,}|\||>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/;

/**
 * Neutralize a raw report field so markdown reads it as text, not structure.
 *
 * `&` then `<` are escaped, in that order so the `&lt;` this produces is not
 * re-escaped. Raw HTML is one structure channel: an unclosed `<details>` routes
 * everything after it on the comment into a collapsed block.
 *
 * The other channel is the line itself: one backslash in front of the marker
 * makes the line text and stops it reshaping the lines under it. After up to
 * three leading spaces (kept), the line is neutralized when it starts a
 *
 * - heading — ATX `#`…`###### `, or a setext underline of `=`/`-`;
 * - thematic break — a whole line of three or more `-`/`*`/`_`, spaced or not;
 * - code fence — three or more backticks or tildes, which left open runs to
 *   the end of the comment;
 * - table — a line starting `|`, the `|---|` delimiter row included;
 * - quote — a line starting `>`;
 * - list item — bullet `-`/`*`/`+`, or ordered `1.`/`1)`, followed by a space
 *   or the line end.
 *
 * Line endings are normalized first (`\r\n` and a lone `\r` → `\n`): a CR is a
 * line break to markdown too, and left in place it is the line's last
 * character, so every end-anchored form above misses and `---\r` still opens a
 * thematic break.
 *
 * The escape goes before the marker character, except on an ordered item whose
 * digits take no escape: there the `.`/`)` is escaped instead. `### Findings`
 * therefore renders literally and is no longer an insertion anchor, a stray
 * `~~~` cannot swallow the sections after it, and a quote, list or table
 * cannot absorb the lines below it.
 *
 * Deliberate trade-off: `<https://…>` autolinks, and every other `<…>`, render
 * as literal text. That is the smaller risk: unescaped, `<` opens raw HTML and
 * a structure line re-heads the comment, and neither is recoverable once the
 * comment is published, while a literal URL still reads. A list or quote the
 * field carried on purpose loses its formatting the same way.
 *
 * `planToFix` is NOT passed through here — it is already fenced as code.
 */
function neutralizeReportText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .split("\n")
    .map((line) => {
      const match = REPORT_STRUCTURE_LINE.exec(line);
      if (match === null) return line;
      const marker = match[2]!;
      const at = match[1]!.length + (/^\d/.test(marker) ? marker.length - 1 : 0);
      return `${line.slice(0, at)}\\${line.slice(at)}`;
    })
    .join("\n");
}

function insertReportFields(rendered: string, report: ReportDoc | null): string {
  let body = rendered;
  if (report !== null) {
    const overview = `**What this PR does**: ${neutralizeReportText(report.overview)}`;
    body = insertAfterHeading(body, REVIEW_HEADING, overview);
  }
  if (body.split("\n").includes(FINDINGS_HEADING)) return body;
  return `${body}\n\n${FINDINGS_HEADING}\n\nnone`;
}

/** What a section body becomes when the tail cannot afford its text. */
export const TRUNCATION_MARKER = "[... truncated to fit the comment limit ...]";

function buildReportTail(report: ReportDoc | null, limit = Number.POSITIVE_INFINITY): string {
  const field = (value: string | undefined): string =>
    value === undefined ? "none" : neutralizeReportText(value);
  const headings = [
    "### Linked-issue AC",
    "### ✅ Verified",
    "### 🗑️ Considered & rejected",
    "## 🛠️ Plan to fix",
  ];
  const bodies = [
    field(report?.linkedIssueAc),
    field(report?.verified),
    field(report?.rejected),
    planBlock(report?.planToFix ?? null),
  ];
  const render = (count = headings.length): string =>
    headings
      .slice(0, count)
      .map((heading, index) => `${heading}\n\n${bodies[index]!}`)
      .join("\n\n");
  const fits = (text: string): boolean => text.length + 3 <= limit;

  let tail = render();
  if (fits(tail)) return tail;
  const base = render(3);
  bodies[3] = planBlock(report?.planToFix ?? null, limit - base.length - headings[3]!.length - 7);
  tail = render();
  if (fits(tail)) return tail;
  for (const index of [2, 1, 0]) {
    bodies[index] = TRUNCATION_MARKER;
    tail = render();
    if (fits(tail)) return tail;
  }
  bodies.fill("none");
  tail = render();
  return fits(tail) ? tail : "";
}


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
 * marker line, the marker-stripped review body (model text can never forge an
 * Inspector marker), then the round header as the trailer directly above the
 * publication marker. Clamped so both trusted markers and the header survive
 * the body limit. The round marker stays FIRST: `parseReviewRound` is
 * `^`-anchored and the comment-identity scan depends on it.
 */
export function buildPreparedReviewBody(input: {
  output: ReviewOutput;
  omittedFindings: number;
  round: number;
  headSha: string;
  publicationMarker: string;
  sinceSha?: string;
  reportParts?: { report: ReportDoc | null; revalidated: string };
  seatCoverage?: ReviewCoverage | null;
}): string {
  const roundMarker = `<!-- mstar-inspector:review:v1 round=${input.round} -->`;
  const header =
    `Review ${input.round} · commit ${input.headSha.slice(0, 7)}` +
    (input.sinceSha === undefined ? "" : ` · since ${input.sinceSha.slice(0, 7)}`);
  const reserve = roundMarker.length + header.length + input.publicationMarker.length + 8;
  const budget = REVIEW_BODY_LIMIT - reserve;
  const core = stripInspectorMarkerSyntax(
    buildReviewBody(input.output, input.omittedFindings, input.reportParts, budget, input.seatCoverage),
  );
  return `${roundMarker}\n\n${clampKeepingHead(core, budget)}\n\n${header}\n${input.publicationMarker}`;
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
  return `${roundMarker}\n${clampKeepingHead(core, budget)}\n${input.publicationMarker}`;
}

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
 * Decide create vs update for the review comment (qc2 F-002):
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
  error: string;
  rawOutput: string;
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


const DER_SEQUENCE = 0x30;
const DER_OCTET_STRING = 0x04;
const DER_INTEGER = 0x02;
const DER_OID = 0x06;
const DER_NULL = 0x05;
const RSA_ENCRYPTION_OID = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
const PKCS8_VERSION_ZERO = new Uint8Array([0x00]);

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

function derElement(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

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

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

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
 * algorithm as the deleted worker/diff.ts; duplicated here because
 * pipeline ↛ worker and no shared module is extracted).
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

/**
 * The transport shape the bounded-fetch seam accepts. Deliberately narrower
 * than `typeof fetch`: bun's global also declares a `preconnect` property,
 * and a runner-supplied wrapper is a plain callable. The runtime global
 * fetch satisfies this shape, so callers pass it unchanged.
 */
export type CommenterFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Construction options for `createReviewCommenter`. `fetchImpl` is the
 * per-request transport seam (spec §7.11.1): the caller wraps every request
 * with its own abort/timeout bound and the instance routes ALL traffic
 * through it. The connection is threaded explicitly rather than left to a
 * mutation of the global fetch, because a Worker isolates one module-level
 * binding per isolate — module state is not a safe place for per-run state.
 */
export type ReviewCommenterOptions = {
  db?: D1Like;
  nowMs?: () => number;
  fetchImpl?: CommenterFetch;
  authSeam?: AuthSeam;
  checksUpdateBudgetMs?: number;
};

/** One `createAppAuth` construction, as observed through `authSeam`. */
export type AuthConstruction = { appId: string };
/**
 * Whether a mint failure says the requested repository NAME is not this
 * installation's any more (a rename). GitHub answers 404 or 422 depending on
 * the endpoint's validation path, and the status can sit on the error, on its
 * `response`, or only in the message once a transport re-wraps it — all three
 * are read, because a guard that recognises only one of them silently disables
 * the fallback (the failure mode this helper exists to end).
 */
export function isNameRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    for (const holder of [current, "response" in current ? current.response : undefined]) {
      if (typeof holder !== "object" || holder === null || !("status" in holder)) continue;
      if (holder.status === 404 || holder.status === 422) return true;
    }
    if ("message" in current && typeof current.message === "string" && /repository not found|\bnot found\b/i.test(current.message)) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** One minted installation grant, as observed through `authSeam`. */
export type AuthMint = {
  installationId: number;
  repo: string;
  purpose: TokenPurpose;
  permissions: Record<string, string>;
  installationWide?: boolean;
};
/** Records the credential construction/mint seam (test-only; see `authSeam`). */
export type AuthSeam = { constructed: AuthConstruction[]; minted: AuthMint[] };


export type TokenPurpose = "sandbox-read" | "review-write";

export type InstallationTokenGrant = {
  token: string;
  permissions: Record<string, string>;
  repositoryIds?: number[];
  repositoryNames?: string[];
  repositorySelection?: string;
};

export type TokenInput = { scope: Scope; purpose: TokenPurpose };

/**
 * Explicit requested permission set for the sandbox read grant (spec §7.6,
 * QC P67-QC-001): `contents` + `metadata` for the clone, and
 * `pull_requests: read` because the shipped §7.7 step-2 diff step runs
 * `gh pr diff` with EXACTLY this token and that endpoint is authorized by
 * the pull-requests permission. Read-only and repository-scoped as before —
 * no write capability is added, and `assertSandboxGrant` still rejects any
 * returned value that is not `read`.
 */
export const SANDBOX_READ_PERMISSIONS: Record<string, string> = {
  contents: "read",
  metadata: "read",
  pull_requests: "read",
};
/**
 * Explicit requested permission set for Worker review writes. Adds
 * `checks: "write"` here (spec §7.6/§7.12): Check runs ride the SAME
 * purpose-scoped, repository-scoped credential as the comment, degraded and
 * line-comment chains, so the pipeline keeps exactly one `createAppAuth`
 * construction point, one mint path and one token client. auth-app's cache is
 * keyed by installation/repository/permissions, so this widened set simply
 * becomes a distinct cache entry from the sandbox read grant — the two purpose
 * families still never cross-reuse a token.
 */
export const REVIEW_WRITE_PERMISSIONS: Record<string, string> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
};

function permissionsFor(purpose: TokenPurpose): Record<string, string> {
  return purpose === "sandbox-read" ? { ...SANDBOX_READ_PERMISSIONS } : { ...REVIEW_WRITE_PERMISSIONS };
}

/**
 * Returned-capability assertion for the sandbox read grant (spec §7.6 /
 * RL-6): nonempty token, contents+metadata+pull_requests read (the three the
 * sandbox path actually exercises — clone and `gh pr diff`), EVERY other
 * returned permission read-only, `repositorySelection === "selected"`, and
 * exactly one returned repository equal to the requested one. A missing
 * repository list/selection or any broader grant fails closed — throws, so
 * a token that could not run the shipped diff step is rejected HERE rather
 * than failing later inside the container.
 */
export function assertSandboxGrant(grant: InstallationTokenGrant, expectedRepo: string): void {
  if (typeof grant.token !== "string" || grant.token.length === 0) {
    throw new Error("sandbox grant rejected: empty token");
  }
  const permissions = grant.permissions ?? {};
  if (
    permissions.contents !== "read" ||
    permissions.metadata !== "read" ||
    permissions.pull_requests !== "read"
  ) {
    throw new Error("sandbox grant rejected: contents/metadata/pull_requests must be returned read");
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
 * Prepared-publication send input (§7.7 step 8): the EXACT body was
 * durably staged before this call; `targetCommentId`/`round` come from the
 * pre-staging plan. The send validates the target's expected previous version
 * (or an already-matching exact body) and publishes the prepared body
 * verbatim — a newer publication is never overwritten.
 */
export type PostPreparedReviewInput = CommenterTargetInput & {
  headSha: string;
  round: number;
  targetCommentId: number | null;
  body: string;
  publicationId: string;
  notAfterMs?: number;
  attemptId?: string;
  journalClaim?: Lease;
};

export type PostPreparedDegradedInput = CommenterTargetInput & {
  appId: string;
  headSha: string;
  round: number;
  targetCommentId: number | null;
  body: string;
  publicationId: string;
  notAfterMs?: number;
  attemptId?: string;
  journalClaim?: Lease;
};

export type ReviewCommenter = {
  getInstallationToken(input: TokenInput): Promise<InstallationTokenGrant>;
  planReviewUpsert(input: CommenterTargetInput): Promise<UpsertPlan>;
  planDegradedUpsert(input: CommenterTargetInput): Promise<UpsertPlan>;
  postPreparedReview(input: PostPreparedReviewInput): Promise<{ commentId: number }>;
  postPreparedDegraded(input: PostPreparedDegradedInput): Promise<{ posted: boolean; commentId: number | null }>;
  recoverLineComments(input: PostPreparedLineCommentsInput): Promise<PostedLineComments>;
  deleteDegradedComment(input: PostDegradedInput): Promise<DegradedDeleteOutcome>;
  postLineComments(input: PostPreparedLineCommentsInput): Promise<PostedLineComments>;
  listDiscussion(input: ListDiscussionInput): Promise<Discussion>;
  discoverThread?(input: { scope: Scope; intent: LineIntent; reviewId: number | null }): Promise<DiscoveryResult>;
  resolveFindingThread?(input: {
    scope: Scope;
    associationId: string;
    verified: VerifiedResolution;
  }): Promise<ResolveOutcome>;
  checks?: ChecksAdapter;
  getAppIdentity?(): Promise<{ githubAppId: number; slug: string } | null>;
};
/**
 * Structural auth surface for the createAppAuth strategy. `AuthInterface` is
 * not exported by @octokit/auth-app, so the surface is named here; the real
 * strategy is assignable (same pattern as the deleted worker/diff.ts
 * AppAuth). With a factory the call resolves to the factory's
 * return (the octokit); without one it resolves to the installation access
 * grant — auth-app 8.3.0 maps the response's `permissions`,
 * `repository_selection` and `repositories[].id/name` into `permissions`,
 * `repositorySelection`, `repositoryIds`/`repositoryNames` (spec §7.6), and
 * its token cache is keyed by installation/repository/permissions.
 */
export type AppAuthStrategy = {
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
      deleteComment?: (parameters: Record<string, unknown>) => Promise<unknown>;
    };
    pulls?: {
      createReview?: (parameters: Record<string, unknown>) => Promise<unknown>;
      listReviews?: (parameters: Record<string, unknown>) => Promise<unknown>;
      listCommentsForReview?: (
        parameters: Record<string, unknown>,
      ) => Promise<{ data: Array<{ id?: unknown; path?: unknown; line?: unknown }> }>;
    };
  };
};

type CommentTarget = { owner: string; repo: string; prNumber: number };

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
 * Pre-staging plan read against a caller-provided octokit (§7.7):
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
 * A definitive rejection BEFORE any request left the Worker (spec §7.7
 * "A known definitive rejection before any successful/unknown send is
 * failed, not published"). Thrown by the prepared-send surfaces when the
 * target no longer shows its expected previous version, a foreign marker
 * appeared after the plan, the client surface cannot publish at all, or the
 * action's PUBLICATION lease is held by another holder or lapsed at dispatch
 * (§7.9) — cases where the honest durable state is `failed`, NOT the
 * post-attempt `unknown`. Any error that may have reached GitHub (transport
 * throw, a create response without an id) deliberately stays a plain Error so
 * it keeps mapping to `unknown`.
 */
export class PreparedSendRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedSendRejected";
  }
}

/**
 * The attempt's frozen deadline passed BEFORE a GitHub mutation started. No
 * request left the Worker, so this is a typed wall-clock stop — never the
 * post-attempt `unknown` of a lost reply (the caller maps it accordingly).
 */
export class PublicationDeadlineSpent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationDeadlineSpent";
  }
}

function guardMutations<T extends { createComment: unknown; updateComment: unknown }>(
  issues: T,
  notAfterMs: number | undefined,
  fence: PublicationFence | undefined,
): T {
  if (notAfterMs === undefined && fence === undefined) return issues;
  const atDispatch = async (verb: string): Promise<void> => {
    if (fence !== undefined && !(await fence.verify())) {
      throw new PublicationAuthorityUnavailable(
        `${verb}: the publication lease ${fence.actionKey} is no longer held by this sender — nothing was sent`,
      );
    }
    if (notAfterMs !== undefined) {
      const lateMs = Date.now() - notAfterMs;
      if (lateMs >= 0) {
        throw new PublicationDeadlineSpent(
          `${verb}: the attempt's frozen deadline passed ${lateMs}ms ago — nothing was sent`,
        );
      }
    }
  };
  return {
    ...issues,
    createComment: async (...args: never[]) => {
      await atDispatch("create comment");
      return (issues.createComment as (...inner: never[]) => unknown)(...args);
    },
    updateComment: async (...args: never[]) => {
      await atDispatch("update comment");
      return (issues.updateComment as (...inner: never[]) => unknown)(...args);
    },
  } as T;
}

/**
 * The publication authority of one comment send (spec §7.9/§7.7), bound to the
 * store the send proves it against. Two shapes, because an App with no Checks
 * surface has no `review_checks` row to key a per-action lease on:
 *
 *   - `lease`: the send takes the publication lease of its ACTION for the Check
 *     attempt, and releases it on settlement;
 *   - `journal`: the caller's §7.7 journal claim (`review_publications`) is the
 *     fence — verified at dispatch, never released here (the caller persists
 *     the proof and releases).
 *
 * There is no third shape. A send that cannot present one is refused.
 */
export type PublicationSendGuard =
  | { kind: "lease"; db: D1Like; nowMs: () => number; attemptId: string }
  | { kind: "journal"; db: D1Like; nowMs: () => number; publicationId: string; claim: Lease };

/**
 * NO authority was available for this send: another holder owns the action, or
 * the lease could not be read. Nothing was sent, and nothing is known to be
 * wrong with the prepared target either — so a recovery lane must leave the
 * publication due (never record a definitive failure) and a caller that hands
 * the send to another lane must not commit its own outcome.
 */
export class PublicationAuthorityUnavailable extends PreparedSendRejected {}

/**
 * Build a send's authority from what the caller presents (spec §7.9/§7.7).
 * THE rule every prepared send uses, exported so a test drives the real one:
 * a named Check attempt wins (its per-action lease), else the caller's journal
 * claim, else a refusal — absence of a Check handle is not authority.
 */
export function publicationSendGuard(
  db: D1Like | undefined,
  nowMs: () => number,
  input: { publicationId: string; attemptId?: string; journalClaim?: Lease },
): PublicationSendGuard {
  if (db === undefined) {
    throw new PreparedSendRejected(
      `the publication authority of ${input.publicationId} cannot be read — this commenter was built without the journal store; nothing was sent`,
    );
  }
  if (input.attemptId !== undefined) {
    return { kind: "lease", db, nowMs, attemptId: input.attemptId };
  }
  if (input.journalClaim !== undefined) {
    return { kind: "journal", db, nowMs, publicationId: input.publicationId, claim: input.journalClaim };
  }
  throw new PreparedSendRejected(
    `no publication authority for ${input.publicationId}: neither a Check attempt nor a journal claim was supplied — nothing was sent`,
  );
}

function journalClaimFence(
  guard: Extract<PublicationSendGuard, { kind: "journal" }>,
  actionKey: string,
): PublicationFence {
  return {
    actionKey,
    async verify() {
      try {
        const row = await guard.db
          .prepare(`SELECT holder, lease_epoch, lease_until_ms FROM review_publications WHERE id = ?`)
          .bind(guard.publicationId)
          .first<{ holder: string | null; lease_epoch: number; lease_until_ms: number | null }>();
        return (
          row !== null &&
          row.holder === guard.claim.holder &&
          row.lease_epoch === guard.claim.epoch &&
          row.lease_until_ms === guard.claim.untilMs &&
          guard.nowMs() < guard.claim.untilMs
        );
      } catch {
        return false;
      }
    },
    async release() {
      return false;
    },
  };
}

async function underPublicationFence<T>(
  guard: PublicationSendGuard | undefined,
  actionKey: string,
  run: (fence: PublicationFence | undefined) => Promise<T>,
): Promise<T> {
  if (guard === undefined) return run(undefined);
  if (guard.kind === "journal") return run(journalClaimFence(guard, actionKey));
  const opened = await openPublicationFence(
    { db: guard.db, nowMs: guard.nowMs },
    { attemptId: guard.attemptId, actionKey, holder: `send:${actionKey}` },
  );
  if ("reason" in opened) throw new PublicationAuthorityUnavailable(`${opened.reason} — nothing was sent`);
  try {
    return await run(opened.fence);
  } finally {
    await opened.fence.release();
  }
}

/**
 * Publish the EXACT prepared review body against a caller-provided octokit
 * (§7.7 step 8). Before sending, the target is RE-READ and must
 * show its expected previous version — or an already-matching exact
 * marker/body (the response-lost replay case, adopted without mutation):
 *   - update plan: the target comment must still be bot-authored with the
 *     expected round (= prepared round - 1). Deleted → create fallback with
 *     the SAME prepared body (the round never increments on retry). Changed
 *     (newer round / replaced body) → definitive rejection (`PreparedSendRejected`)
 *     — a newer publication is never overwritten by an older send.
 *   - create plan: a bot review-marker comment appearing between plan and
 *     send is adopted only when it already carries the exact prepared body;
 *     any other marker is a definitive rejection.
 * The send publishes the prepared body VERBATIM; a create response without
 * an id is an unprovable publication and throws a plain Error (a request
 * WAS sent — the caller must treat it as unknown, never as not-sent).
 */
export async function postPreparedReviewWithOctokit(
  octokit: PostOctokit,
  input: PostPreparedReviewInput,
  guard?: PublicationSendGuard,
): Promise<{ commentId: number }> {
  return underPublicationFence(guard, `comment:${input.publicationId}`, (fence) =>
    publishPreparedReview(octokit, input, fence),
  );
}

async function publishPreparedReview(
  octokit: PostOctokit,
  input: PostPreparedReviewInput,
  fence: PublicationFence | undefined,
): Promise<{ commentId: number }> {
  const surface = octokit.rest?.issues;
  if (!surface?.listComments || !surface?.updateComment || !surface?.createComment || typeof octokit.paginate !== "function") {
    throw new PreparedSendRejected(
      "octokit is missing rest.issues comment methods / paginate — cannot publish the prepared review; check the injected auth surface",
    );
  }
  const comments = await scanCommentsWithOctokit(octokit, input, "review");
  const issues = guardMutations(surface, input.notAfterMs, fence);
  const parsedRound = (body: string | null | undefined): number | null =>
    body ? parseReviewRound(body) : null;

  if (input.targetCommentId !== null) {
    const target = comments.find((c) => c.id === input.targetCommentId);
    if (target === undefined) {
      return createPreparedComment(issues, input);
    }
    if (target.body === input.body) {
      return { commentId: target.id };
    }
    if (target.user?.type !== "Bot" || parsedRound(target.body) !== input.round - 1) {
      throw new PreparedSendRejected(
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
      if (classifyGithubRateLimit(err) !== null) throw err;
      const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
      if (status === 404 || status === 403) {
        return createPreparedComment(issues, input);
      }
      throw err;
    }
  }

  const markerComments = comments.filter((c) => c.user?.type === "Bot" && parsedRound(c.body) !== null);
  for (const marker of markerComments) {
    if (marker.body === input.body) return { commentId: marker.id };
    throw new PreparedSendRejected(
      `a bot review marker (comment ${marker.id}) appeared after the pre-staging plan — refusing to create a second publication (spec §7.7)`,
    );
  }
  return createPreparedComment(issues, input);
}

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
 * Publish the EXACT prepared degraded body (§7.7 degraded payload).
 * Same target-version mechanics as the review chain; the degraded chain is
 * best-effort at the consumer, so a missing create-response id degrades to
 * `commentId: null` instead of throwing.
 */
export async function postPreparedDegradedWithOctokit(
  octokit: PostOctokit,
  input: PostPreparedDegradedInput,
  guard?: PublicationSendGuard,
): Promise<{ posted: boolean; commentId: number | null }> {
  return underPublicationFence(guard, `comment:${input.publicationId}`, (fence) =>
    publishPreparedDegraded(octokit, input, fence),
  );
}

async function publishPreparedDegraded(
  octokit: PostOctokit,
  input: PostPreparedDegradedInput,
  fence: PublicationFence | undefined,
): Promise<{ posted: boolean; commentId: number | null }> {
  const surface = octokit.rest?.issues;
  if (!surface?.listComments || !surface?.updateComment || !surface?.createComment || typeof octokit.paginate !== "function") {
    throw new PreparedSendRejected(
      "octokit is missing rest.issues comment methods / paginate — cannot publish the prepared degraded comment; check the injected auth surface",
    );
  }
  const comments = await scanCommentsWithOctokit(octokit, input, "degraded");
  const issues = guardMutations(surface, input.notAfterMs, fence);
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
      throw new PreparedSendRejected(
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
      if (classifyGithubRateLimit(err) !== null) throw err;
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
    throw new PreparedSendRejected(
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
  appId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  error: string;
  rawOutput: string;
};

/**
 * §7.9a condition 3's guard. `preserve` answers "does a NEWER unproven
 * degraded publication for this exact target still need the scanned comment as
 * its evidence?"; `claimTarget` takes the writer exclusion for that exact
 * comment so staging/recovery cannot reuse it while this delete is in flight.
 * Both are re-run at the delete verb, after the body re-read.
 */
export type DegradedCleanupGuard = {
  preserve: (match: { id: number; body: string }) => Promise<boolean>;
  claimTarget?: (commentId: number) => Promise<DegradedTargetLock | null>;
};

/** The target exclusion a cleanup holds across one DELETE. The delete's
 *  UNRESOLVED intent was recorded when the lock was acquired, before the
 *  request — so a crash leaves it durable. */
export type DegradedTargetLock = {
  release: (keep: boolean) => Promise<void>;
};

/** Degraded-comment delete outcome (Bugbot round-2 fix): the consumer logs
 * this instead of catching — the delete step is best-effort and never
 * throws. `skipped` counts 403/404 (foreign App's marker or already gone)
 * and any other per-match error; `errors` carries the non-403/404
 * messages so the warn line stays actionable; `rateLimited` counts the
 * matches a GitHub rate limit rejected, split by kind — the sweep was
 * throttled, not the marker dead, so the consumer persists that as a
 * continuation event instead of a review failure, and a primary `429` never
 * reaches the secondary-limit metric.
 */
export type DegradedDeleteOutcome = {
  deleted: number;
  skipped: number;
  errors: string[];
  rateLimited: { primary: number; secondary: number };
};

function guardDeletes(
  issues: NonNullable<PostOctokit["rest"]>["issues"],
  unchanged: () => Promise<boolean>,
  preserve?: () => Promise<boolean>,
): NonNullable<PostOctokit["rest"]>["issues"] {
  return {
    ...issues,
    deleteComment: async (params) => {
      if (!(await unchanged())) {
        throw new PreparedSendRejected(
          "degraded marker: the comment no longer carries the body that was scanned — nothing was deleted",
        );
      }
      if (preserve !== undefined && (await preserve())) {
        throw new PreparedSendRejected(
          "degraded marker: a newer unproven degraded publication still needs this comment as evidence — nothing was deleted",
        );
      }
      return (issues.deleteComment as (inner: Record<string, unknown>) => Promise<unknown>)(params);
    },
  };
}

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
  guard?: DegradedCleanupGuard,
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
      rateLimited: { primary: 0, secondary: 0 },
    };
  }
  const comments = await scanCommentsWithOctokit(octokit, input, "degraded");
  const matches = findDegradedComments(comments);
  const outcome: DegradedDeleteOutcome = {
    deleted: 0,
    skipped: 0,
    errors: [],
    rateLimited: { primary: 0, secondary: 0 },
  };
  for (const match of matches) {
    const lock = guard?.claimTarget === undefined ? null : await guard.claimTarget(match.id);
    if (guard?.claimTarget !== undefined && lock === null) {
      outcome.skipped += 1;
      continue;
    }
    let keepLock = false;
    try {
      const deleting = guardDeletes(
        issues,
        async () => {
          const atDelete = await scanCommentsWithOctokit(octokit, input, "degraded");
          return atDelete.some((c) => c.id === match.id && c.body === match.body);
        },
        guard === undefined ? undefined : () => guard.preserve({ id: match.id, body: match.body }),
      );
      await deleting.deleteComment!({
        owner: input.owner,
        repo: input.repo,
        comment_id: match.id,
      });
      outcome.deleted += 1;
    } catch (err) {
      if (err instanceof PreparedSendRejected) {
        outcome.skipped += 1;
        continue;
      }
      const limited = classifyGithubRateLimit(err);
      if (limited !== null) {
        outcome.rateLimited[limited] += 1;
        continue;
      }
      const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
      if (status === 403 || status === 404) {
        outcome.skipped += 1;
        continue;
      }
      keepLock = true;
      outcome.skipped += 1;
      outcome.errors.push(err instanceof Error ? err.message : String(err));
    } finally {
      if (lock !== null) await lock.release(keepLock);
    }
  }
  return outcome;
}


const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function bSidePath(target: string): string | null {
  if (target === "/dev/null") return null;
  let path = target.startsWith("b/") ? target.slice(2) : target;
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
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
  let current: Array<[number, number]> | null = null;
  let remainingOld = 0;
  let remainingNew = 0;
  for (const line of diff.split("\n")) {
    if (remainingOld > 0 || remainingNew > 0) {
      const marker = line.charAt(0);
      if (marker === " " || marker === "-") remainingOld -= 1;
      if (marker === " " || marker === "+") remainingNew -= 1;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = null;
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
 *     hunks → excluded);
 *   - range layer (during the hunk pass): the published range start is
 *     `line_start` ONLY when it is a positive line strictly before `line_end`
 *     AND inside that SAME hunk; anything else yields `lineStart: null` so
 *     the poster never invents a multi-line anchor.
 * With `diff` undefined (prefetch failed) the base layer alone decides —
 * and because no diff can verify the range, NONE is published: every result
 * carries `lineStart: null` and only the single-line anchor at
 * `line_end` rides the wire (a 422 on a guessed range takes the whole
 * batch down).
 *
 * Each result pairs the finding with the range start it may publish, and the
 * finding object is returned UNTOUCHED: the consumer keys its row ids by the
 * finding's fingerprint (which covers `line_start`), so rewriting the field
 * here would silently drop the anchor it is meant to qualify.
 */
export type LineCommentAnchor = {
  finding: ReviewFinding;
  lineStart: number | null;
};

export function filterLineCommentFindings(
  findings: ReviewFinding[],
  diff?: string,
): LineCommentAnchor[] {
  const base = findings.filter(
    (finding) =>
      typeof finding.file_path === "string" &&
      finding.file_path !== "" &&
      typeof finding.line_end === "number" &&
      finding.line_end >= 1,
  );
  if (diff === undefined) {
    return base.map((finding) => ({ finding, lineStart: null }));
  }
  const hunksByPath = parseDiffHunkRanges(diff);
  const qualified: LineCommentAnchor[] = [];
  for (const finding of base) {
    const ranges = hunksByPath.get(finding.file_path ?? "");
    if (ranges === undefined) continue;
    const line = finding.line_end ?? 0;
    const hunk = ranges.find(([start, end]) => line >= start && line <= end);
    if (hunk === undefined) continue;
    const start = finding.line_start;
    qualified.push({
      finding,
      lineStart: typeof start === "number" && start >= hunk[0] && start < line ? start : null,
    });
  }
  return qualified;
}

/**
 * The marker-LESS per-finding comment text (title + merge-class tag +
 * finding body, clamped to the FINDING_BODY_MAX budget). This is the
 * `LineIntent.body` payload — the TRUSTED thread marker is appended later by
 * the §7.5 `buildLineCommentBody` at send time (the legacy
 * marker-less posting path is replaced by the intent-driven path, so thread
 * discovery has a marker to pin).
 *
 * A fence (suggestion or plain) the clamp would cut in half is dropped whole (the
 * surrounding prose survives); a body left with no prose falls back to the
 * title/tag line. Text without a suggestion fence clamps exactly as before.
 */
export function renderLineCommentText(finding: ReviewFinding): string {
  const tag = `${REVIEW_EMOJI[finding.mergeClass]} ${finding.mergeClass}`;
  const head = `**${finding.title}** · ${tag}\n\n`;
  const { text, dropped } = dropUnsafeFences(`${head}${finding.body}`, FINDING_BODY_MAX);
  if (dropped && text.slice(head.length).trim() === "") return head.trimEnd();
  return text.length <= FINDING_BODY_MAX ? text : `${text.slice(0, FINDING_BODY_MAX - 1)}…`;
}

/**
 * Why a read-only discovery readback captured nothing (§7.9a condition 2):
 * `marker-missing` — no review carries this publication's batch marker;
 * `ambiguous` — more than one does; `comment-gone` — the batch review is ours
 * but an intent's comment is not in it; `readback-scope` — a read, or the
 * authenticated identity a read needs, was unavailable, so nothing could be
 * observed; `capture-failed` — the ids were observed but could not be
 * persisted; `budget-refused` — the run's request allowance refused the read
 * before dispatch, so nothing was observed and no attempt is spent. It is the
 * last observation the recovery lane can record as the batch's stop reason,
 * never a guess about what happened on GitHub.
 */
export type LineDiscoveryFailure =
  | "marker-missing"
  | "ambiguous"
  | "comment-gone"
  | "readback-scope"
  | "capture-failed"
  | "budget-refused";

/**
 * §7.7 line-comment capture result: the returned review
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
  failure?: LineDiscoveryFailure;
};

export type PostPreparedLineCommentsInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  round: number;
  publicationId: string;
  intents: LineIntent[];
  attemptId?: string;
  journalClaim?: Lease;
};

function publishedRangeStart(intent: LineIntent): number | null {
  const start = intent.lineStart;
  return typeof start === "number" && start >= 1 && start < intent.line ? start : null;
}

/**
 * Post the INTENT-prepared line-comments review against a caller-provided
 * octokit (§7.7 step 10 / §7.5): ONE pulls.createReview,
 * `event: "COMMENT"` (D4 permanent event lock — never APPROVE/
 * REQUEST_CHANGES), `commit_id` pinned to the review's head sha, the
 * REQUIRED top-level body carrying the trusted line-batch marker
 * (`mstar-inspector:line-batch:v1`), and per-intent comments whose bodies
 * come from the §7.5 `buildLineCommentBody` — untrusted intent text stripped
 * of Inspector marker syntax, trusted thread marker appended. A comment
 * carries `start_line` + `start_side: "RIGHT"` only when the intent holds a
 * real range; otherwise it keeps the single-line `{path, side, line}` shape.
 * The intents' bodies/digests were durably staged before any mutation (§7.7 step 7).
 *
 * Returns the §7.7 capture result: returned comment ids matched back to the
 * intents by their trusted thread marker, with the row anchor as the fallback
 * for a comment that carries none; a non-unique match lands in `ambiguous`
 * and is never fabricated. Empty intent set → zero API calls.
 */
export async function postLineCommentsWithOctokit(
  octokit: PostOctokit,
  input: PostPreparedLineCommentsInput,
  guard?: PublicationSendGuard,
): Promise<PostedLineComments> {
  if (input.intents.length === 0) {
    return { posted: [], ambiguous: [], captured: true, reviewId: null };
  }
  return underPublicationFence(guard, `line-comments:${input.publicationId}`, (fence) =>
    publishLineComments(octokit, input, fence),
  );
}

async function publishLineComments(
  octokit: PostOctokit,
  input: PostPreparedLineCommentsInput,
  fence: PublicationFence | undefined,
): Promise<PostedLineComments> {
  const createReview = octokit.rest?.pulls?.createReview;
  if (!createReview) {
    throw new Error(
      "octokit is missing rest.pulls.createReview — cannot post line comments; check the injected auth surface",
    );
  }
  if (fence !== undefined && !(await fence.verify())) {
    throw new PreparedSendRejected(
      `line-comment batch: the publication lease ${fence.actionKey} is no longer held by this sender — nothing was sent`,
    );
  }
  const response = (await createReview({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    commit_id: input.headSha,
    event: "COMMENT",
    body: `mstar-inspector line comments · round ${input.round} · ${input.headSha.slice(0, 7)}\n${buildLineBatchMarker(input.publicationId)}`,
    comments: input.intents.map((intent) => {
      const start = publishedRangeStart(intent);
      return {
        path: intent.path,
        side: "RIGHT",
        line: intent.line,
        ...(start === null ? {} : { start_line: start, start_side: "RIGHT" }),
        body: buildLineCommentBody({
          body: intent.body,
          publicationId: intent.publicationId,
          associationId: intent.associationId,
        }),
      };
    }),
  })) as {
    data?: {
      id?: unknown;
      comments?: Array<{
        id?: unknown;
        path?: unknown;
        line?: unknown;
        original_line?: unknown;
        body?: unknown;
      }> | null;
    };
  } | undefined;

  const echoed = Array.isArray(response?.data?.comments) ? response!.data!.comments! : null;
  const reviewIdRaw = response?.data?.id;
  const reviewId = typeof reviewIdRaw === "number" ? reviewIdRaw : null;
  let returned = echoed;
  const listCommentsForReview = octokit.rest?.pulls?.listCommentsForReview;
  if (returned === null && reviewId !== null && listCommentsForReview !== undefined) {
    try {
      const listed = await listCommentsForReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        review_id: reviewId,
        per_page: 100,
      });
      returned = Array.isArray(listed?.data) ? listed.data : null;
    } catch {
      returned = null;
    }
  }
  const posted: PostedLineComments["posted"] = [];
  const ambiguous: string[] = [];
  if (returned === null) {
    return { posted: [], ambiguous: [], captured: false, reviewId };
  }
  return captureLineCommentsOf(input.intents, returned, reviewId);
}

function captureLineCommentsOf(
  intents: readonly LineIntent[],
  returned: Array<{
    id?: unknown;
    path?: unknown;
    line?: unknown;
    original_line?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
  }>,
  reviewId: number | null,
  verify?: { publicationId: string; login: string },
): PostedLineComments {
  const posted: PostedLineComments["posted"] = [];
  const ambiguous: string[] = [];
  const markers = returned.map((c) => (typeof c.body === "string" ? parseLineMarker(c.body) : null));
  const associations = markers.map((marker) => marker?.associationId ?? null);
  for (const intent of intents) {
    const byMarker = returned.filter(
      (c, i) =>
        typeof c.id === "number" &&
        associations[i] === intent.associationId &&
        (verify === undefined ||
          (markers[i]?.publicationId === verify.publicationId && c.user?.login === verify.login)),
    );
    const matches =
      byMarker.length > 0
        ? byMarker
        : verify !== undefined
          ? []
          : returned.filter(
              (c, i) =>
                typeof c.id === "number" &&
                associations[i] === null &&
                c.path === intent.path &&
                (c.line ?? c.original_line) === intent.line,
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
  return { posted, ambiguous, captured: ambiguous.length === 0 && posted.length === intents.length, reviewId };
}

function isBatchReviewOf(
  candidate: unknown,
  input: { publicationId: string; headSha: string; login: string },
): candidate is { id: number; body: string } {
  if (typeof candidate !== "object" || candidate === null) return false;
  if (!("id" in candidate) || !("body" in candidate) || !("user" in candidate) || !("commit_id" in candidate)) {
    return false;
  }
  if (typeof candidate.id !== "number" || typeof candidate.body !== "string") return false;
  if (candidate.commit_id !== input.headSha) return false;
  const user = candidate.user;
  if (typeof user !== "object" || user === null || !("login" in user) || user.login !== input.login) return false;
  return parseLineBatchMarker(candidate.body)?.publicationId === input.publicationId;
}

function asComments(rows: unknown[]): Array<{
  id?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
}> {
  return rows as Array<{
    id?: unknown;
    path?: unknown;
    line?: unknown;
    original_line?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
  }>;
}

export async function recoverLineCommentsWithOctokit(
  octokit: PostOctokit,
  input: PostPreparedLineCommentsInput,
  expectedLogin: string | null,
): Promise<PostedLineComments> {
  const unread = (failure: LineDiscoveryFailure): PostedLineComments => ({
    posted: [],
    ambiguous: [],
    captured: false,
    reviewId: null,
    failure,
  });
  if (input.intents.length === 0) return { posted: [], ambiguous: [], captured: true, reviewId: null };
  if (expectedLogin === null) return unread("readback-scope");
  const pulls = octokit.rest?.pulls;
  if (pulls?.listReviews === undefined || pulls.listCommentsForReview === undefined || typeof octokit.paginate !== "function") {
    return unread("readback-scope");
  }
  let reviews: unknown;
  try {
    reviews = await octokit.paginate(pulls.listReviews, {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      per_page: 100,
    });
  } catch (error) {
    return unread(isBudgetRefusal(error) ? "budget-refused" : "readback-scope");
  }
  const candidates = (Array.isArray(reviews) ? reviews : []).filter((candidate: unknown) =>
    isBatchReviewOf(candidate, { publicationId: input.publicationId, headSha: input.headSha, login: expectedLogin }),
  );
  if (candidates.length !== 1) return unread(candidates.length === 0 ? "marker-missing" : "ambiguous");
  const review = candidates[0]!;
  let returned: ReturnType<typeof asComments> | null;
  let refused = false;
  try {
    const listed = await octokit.paginate(pulls.listCommentsForReview, {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      review_id: review.id,
      per_page: 100,
    });
    returned = Array.isArray(listed) ? asComments(listed) : null;
  } catch (error) {
    refused = isBudgetRefusal(error);
    returned = null;
  }
  if (returned === null) return unread(refused ? "budget-refused" : "readback-scope");
  const captured = captureLineCommentsOf(input.intents, returned, review.id, {
    publicationId: input.publicationId,
    login: expectedLogin,
  });
  return captured.captured ? captured : { ...captured, failure: "comment-gone" };
}

/**
 * Production commenter: createAppAuth (APP_ID + normalized PRIVATE_KEY) —
 * the ONLY createAppAuth construction point in the pipeline (architect lock
 * L4): every credential enters through the `CommenterEnv`
 * parameter — every per-App instance (consumer-side bot resolution,
 * src/pipeline/consumer.ts) is built here, one instance per credential so
 * each App keeps its own installation-token cache. Octokit construction
 * stays inside this module; call sites never duplicate it.
 *
 * Purpose-scoped clients (§7.6): every octokit is built from a
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
export function createReviewCommenter(env: CommenterEnv, options?: ReviewCommenterOptions): ReviewCommenter {
  const boundedFetch = options?.fetchImpl;
  const requestOptions: { request?: { fetch?: CommenterFetch } } =
    boundedFetch === undefined ? {} : { request: { fetch: boundedFetch } };
  const httpOptions = (auth?: string): { auth?: string; request?: { fetch?: CommenterFetch } } =>
    auth === undefined ? { ...requestOptions } : { auth, ...requestOptions };

  let appAuth: AppAuthStrategy | null = null;
  async function getAppAuth(): Promise<AppAuthStrategy> {
    let auth = appAuth;
    if (auth === null) {
      const authRequest = boundedFetch === undefined ? null : new Octokit(requestOptions).request;
      auth = createAppAuth({
        appId: env.APP_ID,
        privateKey: normalizePrivateKey(env.PRIVATE_KEY),
        ...(authRequest === null ? {} : { request: authRequest as never }),
      }) as unknown as AppAuthStrategy;
      appAuth = auth;
      options?.authSeam?.constructed.push({ appId: env.APP_ID });
    }
    return auth;
  }

  async function mintGrant(input: { installationId: number; repo: string; purpose: TokenPurpose }): Promise<InstallationTokenGrant> {
    const auth = await getAppAuth();
    const permissions = permissionsFor(input.purpose);
    options?.authSeam?.minted.push({
      installationId: input.installationId,
      repo: input.repo,
      purpose: input.purpose,
      permissions: { ...permissions },
    });
    try {
      return await auth({
        type: "installation",
        installationId: input.installationId,
        repositoryNames: [input.repo],
        permissions,
      });
    } catch (error) {
      if (!isNameRefusal(error) || input.purpose !== "review-write") throw error;
      options?.authSeam?.minted.push({
        installationId: input.installationId,
        repo: input.repo,
        purpose: input.purpose,
        permissions: { ...permissions },
        installationWide: true,
      });
      return auth({ type: "installation", installationId: input.installationId, permissions });
    }
  }

  async function getOctokit(input: { installationId: number; repo: string }): Promise<PostOctokit> {
    const grant = await mintGrant({ ...input, purpose: "review-write" });
    return new Octokit(httpOptions(grant.token)) as unknown as PostOctokit;
  }

  let cachedIdentity: { githubAppId: number; slug: string } | null | undefined;
  async function getAppIdentity(): Promise<{ githubAppId: number; slug: string } | null> {
    if (cachedIdentity !== undefined) return cachedIdentity;
    try {
      const auth = await getAppAuth();
      const { token } = await auth({ type: "app" });
      const octokit = new Octokit(httpOptions(token));
      const { data } = await octokit.rest.apps.getAuthenticated();
      cachedIdentity =
        typeof data?.id === "number" && typeof data?.slug === "string" && data.slug.length > 0
          ? { githubAppId: data.id, slug: data.slug }
          : null;
    } catch {
      cachedIdentity = null;
    }
    return cachedIdentity;
  }

  async function getGraphqlOctokit(input: { installationId: number; repo: string }): Promise<GraphqlOctokit> {
    return (await getOctokit(input)) as unknown as GraphqlOctokit;
  }

  async function getChecksOctokit(scope: Scope): Promise<ChecksOctokit> {
    return (await getOctokit({ installationId: scope.installationId, repo: scope.repo })) as unknown as ChecksOctokit;
  }

  const checksAdapter = options?.db
    ? createChecksAdapter({
        db: options.db,
        nowMs: options.nowMs ?? (() => Date.now()),
        getOctokit: async ({ scope }) => getChecksOctokit(scope),
        updateBudgetMs: options.checksUpdateBudgetMs,
      })
    : null;

  const threadSurface = options?.db
    ? createReviewThreads({
        db: options.db,
        nowMs: options.nowMs ?? (() => Date.now()),
        getAppIdentity: async () => getAppIdentity(),
        getOctokit: async ({ installationId, repo }) => getGraphqlOctokit({ installationId, repo }),
      })
    : null;

  const clock = options?.nowMs ?? (() => Date.now());
  return {
    getAppIdentity,
    ...(threadSurface
      ? {
          discoverThread: (input: { scope: Scope; intent: LineIntent; reviewId: number | null }) =>
            threadSurface.discoverThread(input),
          resolveFindingThread: (input: { scope: Scope; associationId: string; verified: VerifiedResolution }) =>
            threadSurface.resolveFindingThread(input),
        }
      : {}),
    ...(checksAdapter ? { checks: checksAdapter } : {}),
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
      const guard = publicationSendGuard(options?.db, clock, input);
      return postPreparedReviewWithOctokit(
        await getOctokit({ installationId: input.installationId, repo: input.repo }),
        input,
        guard,
      );
    },
    async postPreparedDegraded(input) {
      const guard = publicationSendGuard(options?.db, clock, input);
      return postPreparedDegradedWithOctokit(
        await getOctokit({ installationId: input.installationId, repo: input.repo }),
        input,
        guard,
      );
    },
    async deleteDegradedComment(input) {
      const db = options?.db;
      const scope = {
        appId: input.appId,
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
      };
      return deleteDegradedCommentWithOctokit(
        await getOctokit({ installationId: input.installationId, repo: input.repo }),
        input,
        {
          preserve: db === undefined ? async () => true : () => hasUnprovenDegradedPublication(db, scope),
          ...(db === undefined
            ? {}
            : {
                claimTarget: async (commentId: number) => {
                  const lease = await claimDegradedTarget(db, {
                    scope,
                    commentId,
                    holder: `cleanup:${input.installationId}:${commentId}`,
                    nowMs: clock(),
                    deleting: true,
                  });
                  if (lease === null) return null;
                  return {
                    release: async (keep: boolean) => {
                      await releaseDegradedTarget(db, { scope, commentId, lease, nowMs: clock(), keep });
                    },
                  };
                },

              }),
        },
      );
    },
    async postLineComments(input) {
      const guard = publicationSendGuard(options?.db, clock, input);
      return postLineCommentsWithOctokit(
        await getOctokit({ installationId: input.installationId, repo: input.repo }),
        input,
        guard,
      );
    },
    async recoverLineComments(input) {
      const identity = await getAppIdentity();
      return recoverLineCommentsWithOctokit(
        await getOctokit({ installationId: input.installationId, repo: input.repo }),
        input,
        identity === null ? null : `${identity.slug}[bot]`,
      );
    },
    async listDiscussion(input) {
      const octokit = await getOctokit({ installationId: input.installationId, repo: input.repo });
      return listDiscussionWithOctokit(octokit as unknown as GraphqlOctokit, input);
    },
  };
}
