/**
 * Bounded discussion capture and model-context assembly (plan 67 Task 2,
 * spec review-lifecycle §7.8).
 *
 * Capture (`listDiscussionWithOctokit`): newest-first GraphQL page traversal
 * — the PR's issue comments (`comments(last:100, before:cursor)`, TWO pages
 * maximum) and each known thread conversation (TWO pages, via the §7.5
 * `fetchThreadConversation` primitive in review-threads.ts). Nodes merge
 * chronologically for presentation/digests only. `totalCount`, exhausted
 * cursors and the page bound distinguish complete, truncated and unavailable
 * captures — API failure is `unavailable`, never empty/complete; >200 issue
 * comments or >200 replies in a target thread is explicitly `truncated`
 * (newest replies still included) — and truncation blocks auto-resolution
 * downstream because the coverage feeds the §7.5 resolve fences.
 *
 * Model context (`boundDiscussion`): 50 items, 1200 chars per item,
 * 8000 total chars, oldest items dropped first. The bounded view IS what
 * rides the recheck wire, so the seat can never receive a raw captured body:
 * delimiters, Inspector marker syntax and control characters are neutralized
 * and metadata is single-line and bounded, so the model can never forge the
 * harness's own delimiter convention or our markers, and no thread id is ever
 * sourced from model text. Neutralization runs only on the RETAINED prefix of
 * each retained item (§7.8 truncation is decided on the raw length), so the
 * work is proportional to the model context instead of to every captured
 * byte. Raw complete bodies are used only in-memory upstream for SHA-256
 * snapshot hashing (review-threads.ts) — never logged, never handed to a seat.
 */

import type { Coverage, Discussion, ThreadSnapshot } from "../contracts/recheck";
import {
  fetchIssueComments,
  fetchThreadConversation,
  issueDigestOf,
  stripInspectorMarkerSyntax,
  threadDigestOf,
  type GraphqlOctokit,
  type ThreadCommentEntry,
} from "./review-threads";

// ---------------------------------------------------------------------------
// Capture bounds (spec §7.8)
// ---------------------------------------------------------------------------

/** >200 issue comments → issueCoverage explicitly `truncated`. */
export const DISCUSSION_ISSUE_MAX_COMMENTS = 200;
/** >200 replies in a target thread → that thread's coverage `truncated`. */
export const DISCUSSION_THREAD_MAX_REPLIES = 200;

// Model-context caps (spec §7.8).
export const MODEL_MAX_ITEMS = 50;
export const MODEL_ITEM_MAX_CHARS = 1200;
export const MODEL_TOTAL_MAX_CHARS = 8000;

export type ListDiscussionInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  /** Known thread associations to capture (§7.8 "each known thread"). */
  threads: { associationId: string; threadId: string }[];
  /** Captured-at clock (integer Unix ms; one supplied clock per capture). */
  nowMs?: number;
};

function entryToItem(
  entry: ThreadCommentEntry,
  source: "issue" | "thread",
  associationId: string | null,
): Discussion["items"][number] {
  return {
    source,
    associationId,
    id: entry.fullDatabaseId === "" ? entry.id : entry.fullDatabaseId,
    author: entry.authorLogin ?? "(deleted)",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    body: entry.body,
  };
}

function truncatedSnapshot(
  associationId: string,
  threadId: string,
  capturedMs: number,
  coverage: Coverage,
): ThreadSnapshot {
  return {
    associationId,
    threadId,
    commentId: 0,
    headSha: "",
    digest: "",
    commentCount: 0,
    capturedMs,
    coverage,
    modelCoverage: "complete",
  };
}

/**
 * Capture the bounded discussion (§7.8) for one PR: newest-first issue
 * comments plus each known thread conversation, with honest three-valued
 * coverage and the §7.5 digests. A thread fetch failure marks THAT thread
 * `unavailable` (an empty/complete claim would be false); issue failure
 * marks the issue side `unavailable` while thread captures still run.
 */
export async function listDiscussionWithOctokit(octokit: GraphqlOctokit, input: ListDiscussionInput): Promise<Discussion> {
  const capturedMs = input.nowMs ?? Date.now();
  const items: Discussion["items"] = [];
  const threads: ThreadSnapshot[] = [];

  // API failure is `unavailable`, never empty/complete (spec §7.8).
  let issue: Awaited<ReturnType<typeof fetchIssueComments>> | null = null;
  try {
    issue = await fetchIssueComments(octokit, { owner: input.owner, repo: input.repo, prNumber: input.prNumber });
  } catch {
    issue = null;
  }
  const issueCoverage: Coverage =
    issue === null
      ? "unavailable"
      : !issue.complete || issue.totalCount > DISCUSSION_ISSUE_MAX_COMMENTS
        ? "truncated"
        : "complete";
  const issueDigest = issue !== null && issue.complete ? await issueDigestOf({ headSha: issue.headRefOid, comments: issue.comments }) : "";
  if (issue !== null) {
    for (const entry of issue.comments) {
      items.push(entryToItem(entry, "issue", null));
    }
  }

  for (const known of input.threads) {
    let capture;
    try {
      capture = await fetchThreadConversation(octokit, known.threadId);
    } catch {
      threads.push(truncatedSnapshot(known.associationId, known.threadId, capturedMs, "unavailable"));
      continue;
    }
    if (capture.thread === null) {
      threads.push(truncatedSnapshot(known.associationId, known.threadId, capturedMs, "unavailable"));
      continue;
    }
    const overBound = capture.totalCount > DISCUSSION_THREAD_MAX_REPLIES + 1;
    const coverage: Coverage = !capture.complete || overBound ? "truncated" : "complete";
    // Root identity: the chronological first comment — only provable when
    // the conversation pagination is complete.
    const root = capture.complete ? (capture.comments[0] ?? null) : null;
    const digest =
      coverage === "complete" && root !== null
        ? await threadDigestOf({
            threadId: capture.thread.id,
            rootCommentId: root.fullDatabaseId,
            headSha: capture.headRefOid,
            comments: capture.comments,
          })
        : "";
    threads.push({
      associationId: known.associationId,
      threadId: capture.thread.id,
      commentId: root !== null && /^\d+$/.test(root.fullDatabaseId) ? Number(root.fullDatabaseId) : 0,
      headSha: capture.headRefOid,
      digest,
      commentCount: capture.totalCount,
      capturedMs,
      coverage,
      modelCoverage: "complete",
    });
    for (const entry of capture.comments) {
      items.push(entryToItem(entry, "thread", known.associationId));
    }
  }

  // Chronological presentation order (spec §7.8: nodes are merged
  // chronologically for presentation/digests) — the capture walked the
  // connections backward (newest page first).
  items.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    items,
    issueCoverage,
    issueDigest,
    capturedMs,
    threads,
  };
}

// ---------------------------------------------------------------------------
// Bounded model context (spec §7.8 caps + untrusted-text neutralization)
// ---------------------------------------------------------------------------

/**
 * Neutralize one untrusted text so it can neither forge the harness's own
 * delimiter convention nor Inspector marker syntax nor carry control
 * characters: strip Inspector markers, collapse runs of 3+ hyphens (a forged
 * `-----BEGIN …` never survives as a delimiter-shaped run), and drop control
 * characters except `\n` and `\t`. Never lengthens the input.
 */
function neutralizeUntrustedText(text: string): string {
  const noMarkers = stripInspectorMarkerSyntax(text);
  let out = "";
  let run = 0;
  for (const ch of noMarkers) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "-") {
      run += 1;
      continue;
    }
    if (run > 0) {
      out += run >= 3 ? "-" : "-".repeat(run);
      run = 0;
    }
    if (code < 0x20 && ch !== "\n" && ch !== "\t") continue;
    out += ch;
  }
  if (run > 0) out += run >= 3 ? "-" : "-".repeat(run);
  return out;
}

/** Single-line, delimiter-safe metadata value (bounded escaped metadata). */
function metaValue(value: string): string {
  return neutralizeUntrustedText(value).replace(/[\n\r]/g, " ");
}

const ITEM_BODY_TRUNCATED_SUFFIX = "\n[... body truncated ...]";

/**
 * The model-visible body of one RETAINED item: at most
 * `MODEL_ITEM_MAX_CHARS` characters of the capture, with Inspector marker
 * syntax, delimiter runs and control characters neutralized, plus the
 * truncation marker when the RAW body was longer than the cap. Clamping
 * BEFORE neutralizing is what keeps this pass proportional to the retained
 * context (neutralization never lengthens text, so the result stays inside the
 * cap either way); the cut is then sealed, because a body truncated mid-comment
 * would otherwise show the model an OPEN `<!--` that no strip pass can match —
 * the one shape a clamp can create and must not leave behind.
 */
function modelBodyOf(body: string, overCap: boolean): string {
  if (!overCap) return neutralizeUntrustedText(body);
  const clamped = neutralizeUntrustedText(body.slice(0, MODEL_ITEM_MAX_CHARS));
  return `${clamped.replace(/<!--(?:(?!-->)[\s\S])*$/, "")}${ITEM_BODY_TRUNCATED_SUFFIX}`;
}

/**
 * The bounded model-context VIEW of one captured discussion (§7.8): items in
 * chronological order, OLDEST dropped first at the caps (50 items / 1200 chars
 * per item / 8000 total chars of item text), every retained body and metadata
 * value neutralized and escaped. This is what rides the recheck wire — the
 * seat never receives a raw captured body, and only retained items (plus at
 * most the one boundary item that overflows the budget) are neutralized: never
 * the bytes the caps discarded.
 *
 * Model-coverage bookkeeping (the reason the caller ships this view instead of
 * the capture): a thread snapshot whose items were dropped or whose bodies were
 * clamped gets `modelCoverage: "truncated"` mutated onto the shared snapshot
 * array, and a complete ISSUE capture that lost items or body text to the caps
 * becomes `issueCoverage: "truncated"` — "any omission/body truncation changes
 * relevant modelCoverage to truncated even if fetch completed" / "no
 * partial-context result is labelled complete" (spec §7.4/§7.8). The §7.5
 * resolve fences read exactly those flags, so a verdict that could not have
 * been based on the full conversation never auto-resolves. `issueDigest` and
 * the capture-time fields pass through unchanged; the caller's captured items
 * are never rewritten (their digests were computed over the raw bodies).
 */
export function boundDiscussion(discussion: Discussion): Discussion {
  // Chronological presentation order (oldest first), then apply the caps.
  const ordered = [...discussion.items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const truncatedThreads = new Set<string>();
  let issueContextTruncated = false;
  /**
   * Coverage bookkeeping for any item the model did not see in full — dropped
   * by a cap or clamped at the item bound. Metadata only, never a body.
   */
  const markLost = (lost: Discussion["items"][number]): void => {
    if (lost.source === "thread" && lost.associationId !== null) truncatedThreads.add(lost.associationId);
    else if (lost.source === "issue") issueContextTruncated = true;
  };

  // Item cap first: everything older than the newest MODEL_MAX_ITEMS goes.
  const countDropped = Math.max(0, ordered.length - MODEL_MAX_ITEMS);
  for (const lost of ordered.slice(0, countDropped)) markLost(lost);
  const candidates = ordered.slice(countDropped);

  // Then the total-text budget, filled from the NEWEST end — which is what
  // makes the oldest-first dropping and the bounded work the same loop.
  const retained: Discussion["items"] = [];
  let totalChars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i]!;
    const overCap = item.body.length > MODEL_ITEM_MAX_CHARS;
    const body = modelBodyOf(item.body, overCap);
    if (totalChars + body.length > MODEL_TOTAL_MAX_CHARS) {
      for (const lost of candidates.slice(0, i + 1)) markLost(lost); // this item and every older one
      break;
    }
    totalChars += body.length;
    if (overCap) markLost(item);
    retained.push({
      source: item.source,
      associationId: item.associationId,
      id: metaValue(item.id),
      author: metaValue(item.author),
      createdAt: metaValue(item.createdAt),
      updatedAt: metaValue(item.updatedAt),
      body,
    });
  }
  retained.reverse();

  for (const thread of discussion.threads) {
    if (truncatedThreads.has(thread.associationId) && thread.modelCoverage === "complete") {
      thread.modelCoverage = "truncated";
    }
  }
  return {
    items: retained,
    issueCoverage:
      issueContextTruncated && discussion.issueCoverage === "complete" ? "truncated" : discussion.issueCoverage,
    issueDigest: discussion.issueDigest,
    capturedMs: discussion.capturedMs,
    threads: discussion.threads,
  };
}
