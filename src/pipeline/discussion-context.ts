
import {
  MODEL_ITEM_MAX_CHARS,
  MODEL_MAX_ITEMS,
  MODEL_TOTAL_MAX_CHARS,
  type Coverage,
  type Discussion,
  type ThreadSnapshot,
} from "../../packages/shared/src/recheck-wire";
import {
  fetchIssueComments,
  fetchThreadConversation,
  isOwnPublicationComment,
  issueDigestOf,
  parseLineMarker,
  stripInspectorMarkerSyntax,
  threadDigestOf,
  type GraphqlOctokit,
  type ThreadCommentEntry,
} from "./review-threads";


/** >200 replies in a target thread → that thread's coverage `truncated`. */
export const DISCUSSION_THREAD_MAX_REPLIES = 200;

export { MODEL_ITEM_MAX_CHARS, MODEL_MAX_ITEMS, MODEL_TOTAL_MAX_CHARS };

export type ListDiscussionInput = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  threads: { associationId: string; threadId: string }[];
  nowMs?: number;
  includeOwnPublications?: boolean;
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
    ownAuthor: entry.viewerDidAuthor,
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

  let issue: Awaited<ReturnType<typeof fetchIssueComments>> | null = null;
  try {
    issue = await fetchIssueComments(
      octokit,
      { owner: input.owner, repo: input.repo, prNumber: input.prNumber },
      { includeOwnPublications: input.includeOwnPublications === true },
    );
  } catch {
    issue = null;
  }
  const issueCoverage: Coverage =
    issue === null ? "unavailable" : issue.complete ? "complete" : "truncated";
  const issueDigest =
    issue !== null && issue.complete
      ? await issueDigestOf({
          headSha: issue.headRefOid,
          comments: issue.comments.filter((entry) => !isOwnPublicationComment(entry)),
        })
      : "";
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

  items.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    items,
    issueCoverage,
    issueModelCoverage: "complete",
    issueDigest,
    capturedMs,
    threads,
  };
}


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

function metaValue(value: string): string {
  return neutralizeUntrustedText(value).replace(/[\n\r]/g, " ");
}

/**
 * Marker a body bounded against a byte cap carries — the discussion's clamped
 * items and the recheck ask's body-bounded target share it, so a shortened body
 * always says so instead of reading as the whole concern.
 */
export const BODY_TRUNCATED_SUFFIX = "\n[... body truncated ...]";

function modelBodyOf(body: string, overCap: boolean): string {
  if (!overCap) return neutralizeUntrustedText(body);
  const clamped = neutralizeUntrustedText(body.slice(0, MODEL_ITEM_MAX_CHARS));
  return `${clamped.replace(/<!--(?:(?!-->)[\s\S])*$/, "")}${BODY_TRUNCATED_SUFFIX}`;
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
 * array, and a complete ISSUE capture that lost HUMAN items or body text to the
 * caps gets `issueModelCoverage: "truncated"` — "any omission/body truncation
 * changes relevant modelCoverage to truncated even if fetch completed" / "no
 * partial-context result is labelled complete" (spec §7.4/§7.8).
 * `issueCoverage` stays the FETCH result. Reports this app published itself are
 * excluded before the caps — bot author login AND its own marker: the issue
 * lane by the marker prefix on the body, the thread lane by the Inspector
 * thread marker on the published line-comment root. The recheck input already
 * carries each target's original finding text, so they are redundant context,
 * not lost evidence, and counting them as "the model did not see everything"
 * made every PR with review history — and every thread whose root is our own
 * report — truncate forever. A HUMAN body that copies a marker fails the
 * authorship half and stays visible, so it still truncates the view and still
 * blocks a resolve.
 * `issueDigest` and the capture-time fields pass through unchanged; the
 * caller's captured items are never rewritten (their digests were computed over
 * the raw bodies).
 */
export function boundDiscussion(discussion: Discussion): Discussion {
  const ordered = discussion.items
    .filter(
      (item) =>
        !(
          item.ownAuthor &&
          (item.source === "issue"
            ? /^<!--\s*mstar-inspector:[a-zA-Z-]+:v1\b/.test(item.body.trimStart())
            : parseLineMarker(item.body) !== null)
        ),
    )
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const truncatedThreads = new Set<string>();
  let issueContextTruncated = false;
  const markLost = (lost: Discussion["items"][number]): void => {
    if (lost.source === "thread" && lost.associationId !== null) truncatedThreads.add(lost.associationId);
    else if (lost.source === "issue") issueContextTruncated = true;
  };

  const countDropped = Math.max(0, ordered.length - MODEL_MAX_ITEMS);
  for (const lost of ordered.slice(0, countDropped)) markLost(lost);
  const candidates = ordered.slice(countDropped);

  const retained: Discussion["items"] = [];
  let totalChars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i]!;
    const overCap = item.body.length > MODEL_ITEM_MAX_CHARS;
    const body = modelBodyOf(item.body, overCap);
    if (totalChars + body.length > MODEL_TOTAL_MAX_CHARS) {
      for (const lost of candidates.slice(0, i + 1)) markLost(lost);
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
      ownAuthor: item.ownAuthor,
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
    issueCoverage: discussion.issueCoverage,
    issueModelCoverage:
      issueContextTruncated && discussion.issueModelCoverage === "complete"
        ? "truncated"
        : discussion.issueModelCoverage,
    issueDigest: discussion.issueDigest,
    capturedMs: discussion.capturedMs,
    threads: discussion.threads,
  };
}
