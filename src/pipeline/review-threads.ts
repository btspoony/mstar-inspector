/**
 * Review-thread identity, discovery and resolution (plan 67 Task 2, spec
 * review-lifecycle §7.5 verbatim — plus the shared GraphQL capture
 * primitives and digests that §7.8's discussion capture reuses).
 *
 * Module map:
 *   - Opaque marker wire: `lineMarker` / `parseLineMarker` / batch marker /
 *     `buildLineCommentBody` / `stripInspectorMarkerSyntax` / `buildLineIntent`.
 *     Ids are canonical lowercase UUIDs preallocated by the T1 journal
 *     (`stagePublication` payload) — no fingerprint encoding, length
 *     assumption or hint-derived content ever enters a marker, and untrusted
 *     bodies are stripped of Inspector marker syntax before a trusted marker
 *     is appended (spec §7.5 "Model/user text cannot generate these markers").
 *   - Digests: length-delimited JSON (NOT pipe concatenation) SHA-256 of
 *     `[threadId, rootCommentId, headSha, comments]` with comments sorted by
 *     `(createdAt, id)` and 7-field entries — spec §7.5 "Digest".
 *   - GraphQL rides the per-App Octokit's EXISTING `graphql()` method — no
 *     new dependency, no second client. `fullDatabaseId` (BigInt JSON string)
 *     is the only selected id bridge; `databaseId` (deprecated) is never
 *     selected. Pagination is bounded: reviewThreads ≤ 5 pages, thread
 *     conversations ≤ 2 pages, issue comments ≤ 2 pages (spec §7.5/§7.8),
 *     and a complete walk is followed by a final newest-page/count/HEAD
 *     stability recheck — drift marks the capture incomplete, never falsely
 *     complete (spec §7.5 "Re-read the final page/count and PR HEAD after
 *     pagination; instability marks incomplete").
 *   - Credential routing: exact `(app_id, installation_id)` through
 *     `app_installations` into the matching `github_apps` row (never a
 *     repository-wide scan), deleted/disabled rows fail closed, and the
 *     JWT-authenticated `GET /app` identity must agree with the row's
 *     `github_app_id` + nonblank slug. The expected bot identity is the
 *     authenticated slug's `<slug>[bot]` — never an unverified `viewer`
 *     surface, never a generic Bot authorship check alone.
 *   - Discovery (`discoverThread`): load the exact stored scope + publication
 *     payload and reject scope mismatch / unknown association BEFORE any API
 *     call; require the confirmed original primary publication, the expected
 *     line-review batch marker, the original review commit SHA, App-author
 *     identity, root comment marker, exact path/range (an OWNED `outdated`
 *     thread whose live line is null matches on its `originalLine` anchor) and
 *     generated-body digest. A known `reviewId` must match exactly; after response loss the
 *     PR's bounded review batches are inspected and only a unique complete
 *     match to the prepared batch intent is accepted. A copied marker at
 *     another review/round/SHA, a reply containing a marker or a generic Bot
 *     author is insufficient. Incomplete pagination or multiple candidates is
 *     unknown/ambiguous, never authority. Discovered ids persist under the
 *     association's lease before resolving.
 *   - Resolution (`resolveFindingThread`): acquire the association lease;
 *     reload the row (not superseded, finding still addressed by this exact
 *     verified publication); prove root ownership/provenance; require all
 *     recorded coverage complete; fetch the current thread + issue discussion
 *     and compare HEAD, full thread digest/count and the issue digest with
 *     the snapshots actually sent — mismatch is `needs-recheck`, never a
 *     refreshed expectation. An already-resolved owned thread is then adopted
 *     as resolved; `isOutdated` is recorded but is NOT a veto. Immediately
 *     before the mutation the local lease is re-checked, then
 *     `resolveReviewThread` must return the matching thread id with
 *     `isResolved === true` before `resolved` is stored. The post-mutation
 *     read records `lateChange` honestly — GitHub has no conditional resolve
 *     CAS (spec RL-12); a late change never claims to cover the newer
 *     discussion and never unresolves a human-visible thread.
 */

import type { Coverage, ThreadSnapshot } from "../contracts/recheck";
import type { D1Like } from "../store/types";
import {
  type Lease,
  type LineIntent,
  type Scope,
  type VerifiedResolution,
} from "../store/finding-lifecycle";

// ---------------------------------------------------------------------------
// Opaque marker wire (spec §7.5)
// ---------------------------------------------------------------------------

/** Canonical lowercase UUID syntax — the only ids a marker may carry. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LineMarker = { publicationId: string; associationId: string };

/** Exact syntax: `<!-- mstar-inspector:thread:v1 publication=<uuid> association=<uuid> -->`. */
export function lineMarker(marker: LineMarker): string {
  if (!UUID_RE.test(marker.publicationId) || !UUID_RE.test(marker.associationId)) {
    throw new Error(
      "review-threads: line marker requires canonical lowercase UUID publication/association ids (opaque, never fingerprint-derived)",
    );
  }
  return `<!-- mstar-inspector:thread:v1 publication=${marker.publicationId} association=${marker.associationId} -->`;
}

/**
 * Parse the LAST exact-syntax thread marker in a body. The trusted marker is
 * always appended AFTER untrusted text has been stripped, so the last
 * occurrence is ours even if a forged marker somehow survived upstream —
 * a body whose last marker is malformed (non-canonical UUID, altered field
 * names, extra spacing) parses as null. Returns null for non-markers.
 */
export function parseLineMarker(body: string): LineMarker | null {
  const matches = [...body.matchAll(/<!-- mstar-inspector:thread:v1 publication=([0-9a-f-]+) association=([0-9a-f-]+) -->/g)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  const publicationId = last[1] ?? "";
  const associationId = last[2] ?? "";
  if (!UUID_RE.test(publicationId) || !UUID_RE.test(associationId)) return null;
  return { publicationId, associationId };
}

/** Exact syntax: `<!-- mstar-inspector:line-batch:v1 publication=<uuid> -->`. */
export function buildLineBatchMarker(publicationId: string): string {
  if (!UUID_RE.test(publicationId)) {
    throw new Error("review-threads: line-batch marker requires a canonical lowercase UUID publication id");
  }
  return `<!-- mstar-inspector:line-batch:v1 publication=${publicationId} -->`;
}

/** Parse the LAST exact-syntax line-batch marker; null on malformed/absent. */
export function parseLineBatchMarker(body: string): { publicationId: string } | null {
  const matches = [...body.matchAll(/<!-- mstar-inspector:line-batch:v1 publication=([0-9a-f-]+) -->/g)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  const publicationId = last[1] ?? "";
  if (!UUID_RE.test(publicationId)) return null;
  return { publicationId };
}

/**
 * Remove every Inspector marker family (`review:v1`, `review-degraded:v1`,
 * `thread:v1`, `line-batch:v1`, `publication:v1`, and any future
 * `mstar-inspector:<family>:v1` HTML comment) from untrusted text. Markers
 * sitting ALONE on a line take their line break with them (no leftover
 * blank lines around the appended trusted marker). Applied BEFORE a trusted
 * marker is appended so model/user text can never forge or duplicate our
 * markers (spec §7.5).
 */
export function stripInspectorMarkerSyntax(body: string): string {
  return body
    .replace(/^[ \t]*<!--\s*mstar-inspector:[a-zA-Z-]+:v1[^>]*-->\n?/gm, "")
    .replace(/<!--\s*mstar-inspector:[a-zA-Z-]+:v1[^>]*-->/g, "");
}

/**
 * The per-line comment body: the pre-assembled (redacted/clamped upstream)
 * untrusted body, stripped of Inspector marker syntax, with the trusted
 * thread marker appended. Deterministic — `bodySha256` is the SHA-256 of
 * exactly this output (computed by `buildLineIntent`).
 */
export function buildLineCommentBody(intent: Pick<LineIntent, "body" | "publicationId" | "associationId">): string {
  const clean = stripInspectorMarkerSyntax(intent.body);
  return `${clean}\n\n${lineMarker({ publicationId: intent.publicationId, associationId: intent.associationId })}`;
}

export type BuildLineIntentInput = {
  findingRowId: string;
  /** Preallocated publication UUID (T1 journal payload). */
  publicationId: string;
  /** Preallocated association UUID (T1 journal payload — becomes the row id). */
  associationId: string;
  scope: Scope;
  originalSha: string;
  round: number;
  path: string;
  line: number;
  /** The assembled comment body — untrusted model text, redacted/clamped upstream. */
  body: string;
};

/**
 * Build one prepared line intent from preallocated opaque UUIDs and compute
 * the generated-body digest (`bodySha256` = SHA-256 of the exact body
 * `buildLineCommentBody` will post). Ids are validated as canonical
 * lowercase UUIDs — fail-closed before any marker can carry a non-opaque id.
 */
export async function buildLineIntent(input: BuildLineIntentInput): Promise<LineIntent> {
  // Validate through the marker builders (same UUID gate, no second check).
  lineMarker({ publicationId: input.publicationId, associationId: input.associationId });
  const bodySha256 = await sha256Hex(
    buildLineCommentBody({ body: input.body, publicationId: input.publicationId, associationId: input.associationId }),
  );
  return {
    associationId: input.associationId,
    findingRowId: input.findingRowId,
    publicationId: input.publicationId,
    scope: input.scope,
    originalSha: input.originalSha,
    round: input.round,
    path: input.path,
    line: input.line,
    body: input.body,
    bodySha256,
  };
}

// ---------------------------------------------------------------------------
// Digests + hashing (spec §7.5 "Digest" — length-delimited JSON)
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 of the UTF-8 input (workerd + bun compatible). */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One captured comment entry. `fullDatabaseId` is the BigInt JSON string —
 * the supported primary-key bridge (the deprecated Int `databaseId` is never
 * selected). Author fields may be null (deleted/null authors are included in
 * counts and digests, spec §7.5).
 */
export type ThreadCommentEntry = {
  id: string;
  fullDatabaseId: string;
  authorType: string | null;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
};

/** Chronological (createdAt, id) sort — presentation/digest order only. */
function chronological(comments: ThreadCommentEntry[]): ThreadCommentEntry[] {
  return [...comments].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function commentJson(comments: ThreadCommentEntry[]): unknown[] {
  return chronological(comments).map((c) => [
    c.id, c.fullDatabaseId, c.authorType, c.authorLogin, c.createdAt, c.updatedAt, c.body,
  ]);
}

/**
 * The full-conversation digest (spec §7.5): lowercase SHA-256 of the UTF-8
 * JSON of `[threadId, rootCommentId, headSha, comments]` — length-delimited
 * JSON, never pipe concatenation. Raw bodies are hashed in memory only.
 */
export async function threadDigestOf(input: {
  threadId: string;
  rootCommentId: string;
  headSha: string;
  comments: ThreadCommentEntry[];
}): Promise<string> {
  return sha256Hex(
    JSON.stringify([input.threadId, input.rootCommentId, input.headSha, commentJson(input.comments)]),
  );
}

/**
 * The issue-discussion digest: the same length-delimited JSON scheme over
 * the PR's issue comments, domain-tagged so it can never collide with a
 * thread digest (`["issue-comments", headSha, comments]`).
 */
export async function issueDigestOf(input: { headSha: string; comments: ThreadCommentEntry[] }): Promise<string> {
  return sha256Hex(JSON.stringify(["issue-comments", input.headSha, commentJson(input.comments)]));
}

// ---------------------------------------------------------------------------
// GraphQL capture primitives (spec §7.5 "Capture/query contract") — the
// transport is the per-App Octokit's existing graphql() method.
// ---------------------------------------------------------------------------

/** Minimal graphql transport seam (the real Octokit satisfies this). */
export type GraphqlOctokit = {
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
};

type GraphqlAuthor = { __typename?: string | null; login?: string | null } | null;

type GraphqlCommentNode = {
  id: string;
  fullDatabaseId?: string | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: GraphqlAuthor;
  originalCommit?: { oid?: string | null } | null;
  pullRequestReview?: { id?: string | null; fullDatabaseId?: string | null } | null;
};

type GraphqlCommentConnection = {
  totalCount?: number | null;
  pageInfo?: { hasPreviousPage?: boolean | null; startCursor?: string | null } | null;
  nodes?: (GraphqlCommentNode | null)[] | null;
};

function entryOf(node: GraphqlCommentNode): ThreadCommentEntry {
  return {
    id: node.id,
    fullDatabaseId: node.fullDatabaseId ?? "",
    authorType: node.author?.__typename ?? null,
    authorLogin: node.author?.login ?? null,
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
    body: node.body ?? "",
  };
}

const THREAD_NODE_QUERY = `
query($id: ID!, $before: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id
      isResolved
      isOutdated
      path
      line
      originalLine
      pullRequest { id number headRefOid repository { nameWithOwner } }
      comments(last: 100, before: $before) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes {
          id
          fullDatabaseId
          body
          createdAt
          updatedAt
          author { __typename login }
          originalCommit { oid }
          pullRequestReview { id }
        }
      }
    }
  }
}`;

export type ThreadCapture = {
  /** null = the thread node is gone (deleted) or the response is malformed. */
  thread: {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    /** The thread's live anchor — null once the line left the diff (`outdated`). */
    line: number | null;
    /** The thread's ORIGINAL anchor (§7.5 node query); survives an outdated line. */
    originalLine: number | null;
    prNumber: number;
    headRefOid: string;
    nameWithOwner: string;
  } | null;
  /** Chronological comment entries (all collected pages merged). */
  comments: ThreadCommentEntry[];
  totalCount: number;
  /** false when pagination hit the 2-page bound with an older page remaining. */
  complete: boolean;
  headRefOid: string;
};

/**
 * Fetch one thread's full conversation (spec §7.5 node query) walking the
 * `comments(last:100, before:cursor)` connection backward, at most TWO pages
 * of the thread's OWN connection (never unrelated PR-wide review comments).
 * The FIRST read is the newest page — its response carries both the thread
 * metadata and that page's comments, so no separate `before: undefined`
 * metadata fetch exists. After a complete walk the final newest page, count
 * and PR HEAD are RE-READ (spec §7.5: "Re-read the final page/count and PR
 * HEAD after pagination; instability marks incomplete") — any drift marks
 * the capture incomplete, never silently complete.
 */
export async function fetchThreadConversation(octokit: GraphqlOctokit, threadId: string): Promise<ThreadCapture> {
  type ThreadNode = {
    id?: string | null;
    isResolved?: boolean | null;
    isOutdated?: boolean | null;
    path?: string | null;
    line?: number | null;
    originalLine?: number | null;
    pullRequest?: {
      number?: number | null;
      headRefOid?: string | null;
      repository?: { nameWithOwner?: string | null } | null;
    } | null;
    comments?: GraphqlCommentConnection | null;
  };
  const data = await octokit.graphql<{ node?: ThreadNode | null }>(THREAD_NODE_QUERY, { id: threadId });
  const node = data?.node;
  if (!node || typeof node.id !== "string" || !node.pullRequest || !node.comments) {
    return { thread: null, comments: [], totalCount: 0, complete: false, headRefOid: "" };
  }
  const pr = node.pullRequest;
  const headRefOid = pr.headRefOid ?? "";
  const thread = {
    id: node.id,
    isResolved: node.isResolved === true,
    isOutdated: node.isOutdated === true,
    path: node.path ?? "",
    line: typeof node.line === "number" ? node.line : null,
    originalLine: typeof node.originalLine === "number" ? node.originalLine : null,
    prNumber: typeof pr.number === "number" ? pr.number : -1,
    headRefOid,
    nameWithOwner: pr.repository?.nameWithOwner ?? "",
  };
  const comments: ThreadCommentEntry[] = [];
  for (const n of node.comments.nodes ?? []) {
    if (n !== null) comments.push(entryOf(n));
  }
  let totalCount = node.comments.totalCount ?? 0;
  let complete = true;
  // Walk backward — the first read above is page 1 of at most 2.
  let before =
    node.comments.pageInfo?.hasPreviousPage === true && node.comments.pageInfo.startCursor
      ? node.comments.pageInfo.startCursor
      : undefined;
  let pages = 1;
  while (before !== undefined && pages < 2) {
    const conn = (await octokit.graphql<{ node?: ThreadNode | null }>(THREAD_NODE_QUERY, { id: threadId, before })).node?.comments;
    if (!conn) {
      complete = false;
      break;
    }
    totalCount = conn.totalCount ?? totalCount;
    pages += 1;
    for (const n of conn.nodes ?? []) {
      if (n !== null) comments.push(entryOf(n));
    }
    before = conn.pageInfo?.hasPreviousPage === true && conn.pageInfo.startCursor ? conn.pageInfo.startCursor : undefined;
  }
  if (before !== undefined) complete = false; // 2-page bound exhausted with an older page remaining
  if (complete) {
    // Post-pagination stability recheck (spec §7.5/§7.8): re-read the newest
    // page's count and the PR HEAD after the walk — the re-read nodes are
    // discarded; it only validates. A concurrent reply/edit/HEAD move between
    // page reads marks the capture incomplete instead of falsely complete.
    const recheck = (await octokit.graphql<{ node?: ThreadNode | null }>(THREAD_NODE_QUERY, { id: threadId })).node;
    const conn = recheck?.comments;
    if (
      recheck === null ||
      recheck === undefined ||
      conn === undefined ||
      conn === null ||
      (conn.totalCount ?? totalCount) !== totalCount ||
      (recheck.pullRequest?.headRefOid ?? "") !== headRefOid
    ) {
      complete = false;
    }
  }
  return { thread, comments, totalCount, complete, headRefOid };
}

const ISSUE_COMMENTS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      comments(last: 100, before: $before) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { id fullDatabaseId body createdAt updatedAt author { __typename login } }
      }
    }
  }
}`;

export type IssueCapture = {
  headRefOid: string;
  comments: ThreadCommentEntry[];
  totalCount: number;
  /** false when pagination hit the 2-page bound OR the post-walk stability recheck drifted. */
  complete: boolean;
};

/**
 * Newest-first issue-comment capture (spec §7.8): the PR's
 * `comments(last:100, before:cursor)` connection walked backward, TWO pages
 * maximum — deliberately avoiding the oldest-first REST `issues.listComments`
 * first pages. Nodes are merged chronologically for presentation/digests.
 * After a complete walk the final newest page count and PR HEAD are RE-READ
 * (spec §7.5/§7.8 stability recheck) — drift marks the capture incomplete.
 */
export async function fetchIssueComments(
  octokit: GraphqlOctokit,
  input: { owner: string; repo: string; prNumber: number },
): Promise<IssueCapture> {
  type PrNode = {
    headRefOid?: string | null;
    comments?: GraphqlCommentConnection | null;
  };
  const head = { owner: input.owner, name: input.repo, number: input.prNumber };
  const comments: ThreadCommentEntry[] = [];
  let totalCount = 0;
  let complete = true;
  let headRefOid = "";
  let before: string | undefined;
  let sawConnection = false;
  for (let page = 0; page < 2; page++) {
    const data = await octokit.graphql<{ repository?: { pullRequest?: PrNode | null } }>(ISSUE_COMMENTS_QUERY, {
      ...head,
      before,
    });
    const pr = data?.repository?.pullRequest;
    const conn = pr?.comments;
    if (!conn) {
      complete = false;
      break;
    }
    sawConnection = true;
    totalCount = conn.totalCount ?? totalCount;
    headRefOid = pr.headRefOid ?? headRefOid;
    for (const n of conn.nodes ?? []) {
      if (n !== null) comments.push(entryOf(n));
    }
    if (conn.pageInfo?.hasPreviousPage === true && conn.pageInfo.startCursor) {
      before = conn.pageInfo.startCursor;
      if (page === 1) complete = false;
    } else {
      break;
    }
  }
  if (!sawConnection) {
    // The PR itself was missing/malformed — an unavailable capture, never empty.
    return { headRefOid: "", comments: [], totalCount: 0, complete: false };
  }
  if (complete) {
    // Post-pagination stability recheck (spec §7.8 "a final newest-page/count
    // recheck"): the re-read nodes are discarded; it only validates.
    const data = await octokit.graphql<{ repository?: { pullRequest?: PrNode | null } }>(ISSUE_COMMENTS_QUERY, head);
    const pr = data?.repository?.pullRequest;
    const conn = pr?.comments;
    if (!conn || (conn.totalCount ?? totalCount) !== totalCount || (pr?.headRefOid ?? "") !== headRefOid) {
      complete = false;
    }
  }
  return { headRefOid, comments, totalCount, complete };
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) {
            nodes { id fullDatabaseId body author { __typename login } pullRequestReview { id fullDatabaseId } }
          }
        }
      }
    }
  }
}`;

export type ReviewThreadStub = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  /** The thread's live anchor — null once the line left the diff (`outdated`). */
  line: number | null;
  /** The thread's ORIGINAL anchor (§7.5 node query); survives an outdated line. */
  originalLine: number | null;
  /** The thread's ROOT comment (oldest, via comments(first:1)) — null when absent. */
  root: ThreadCommentEntry | null;
  /** The root comment's owning review (GraphQL id + REST id as string). */
  rootReviewId: string | null;
  rootReviewRestId: string | null;
};

export type ReviewThreadsCapture = {
  threads: ReviewThreadStub[];
  /** false when pagination hit the 5-page bound with more pages remaining. */
  complete: boolean;
  headRefOid: string;
};

/**
 * Bounded PR-wide review-thread scan for discovery (spec §7.5): at most FIVE
 * pages of `reviewThreads(first:100, after:cursor)`. Each node contributes
 * its root comment via `comments(first:1)` (the oldest comment IS the root).
 */
export async function fetchReviewThreads(
  octokit: GraphqlOctokit,
  input: { owner: string; repo: string; prNumber: number },
): Promise<ReviewThreadsCapture> {
  type ThreadNode = {
    id?: string | null;
    isResolved?: boolean | null;
    isOutdated?: boolean | null;
    path?: string | null;
    line?: number | null;
    originalLine?: number | null;
    comments?: { nodes?: (GraphqlCommentNode | null)[] | null } | null;
  };
  const head = { owner: input.owner, name: input.repo, number: input.prNumber };
  const threads: ReviewThreadStub[] = [];
  let complete = true;
  let headRefOid = "";
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const data = await octokit.graphql<{
      repository?: { pullRequest?: { headRefOid?: string | null; reviewThreads?: { pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null; nodes?: (ThreadNode | null)[] | null } | null } | null };
    }>(REVIEW_THREADS_QUERY, { ...head, after });
    const conn = data?.repository?.pullRequest?.reviewThreads;
    if (!conn) {
      complete = false;
      break;
    }
    headRefOid = data?.repository?.pullRequest?.headRefOid ?? headRefOid;
    for (const node of conn.nodes ?? []) {
      if (node === null || typeof node.id !== "string") continue;
      const root = node.comments?.nodes?.[0] ?? null;
      threads.push({
        id: node.id,
        isResolved: node.isResolved === true,
        isOutdated: node.isOutdated === true,
        path: node.path ?? "",
        line: typeof node.line === "number" ? node.line : null,
        originalLine: typeof node.originalLine === "number" ? node.originalLine : null,
        root: root === null ? null : entryOf(root),
        rootReviewId: root?.pullRequestReview?.id ?? null,
        rootReviewRestId: root?.pullRequestReview?.fullDatabaseId ?? null,
      });
    }
    if (conn.pageInfo?.hasNextPage === true && conn.pageInfo.endCursor) {
      after = conn.pageInfo.endCursor;
      if (page === 4) complete = false; // 5-page bound exhausted
    } else {
      break;
    }
  }
  return { threads, complete, headRefOid };
}

const REVIEWS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50) {
        nodes { id fullDatabaseId body author { __typename login } commit { oid } }
      }
    }
  }
}`;

export type PrReviewStub = {
  id: string;
  fullDatabaseId: string;
  body: string;
  authorType: string | null;
  authorLogin: string | null;
  commitOid: string | null;
};

/**
 * Bounded review-batch scan (spec §7.5: "inspect the known PR's bounded
 * review batches"): the PR's last 50 reviews with their bodies (the
 * line-batch marker proof) and commit oids (the original review commit SHA).
 */
export async function fetchPrReviews(
  octokit: GraphqlOctokit,
  input: { owner: string; repo: string; prNumber: number },
): Promise<PrReviewStub[]> {
  const data = await octokit.graphql<{
    repository?: { pullRequest?: { reviews?: { nodes?: ({
      id?: string | null;
      fullDatabaseId?: string | null;
      body?: string | null;
      author?: GraphqlAuthor;
      commit?: { oid?: string | null } | null;
    } | null)[] | null } | null } | null };
  }>(REVIEWS_QUERY, { owner: input.owner, name: input.repo, number: input.prNumber });
  const nodes = data?.repository?.pullRequest?.reviews?.nodes ?? [];
  // The predicate narrows BOTH nullability and the id string-ness — the
  // mapped stubs require a non-undefined `id` (TS cannot carry the
  // `typeof n.id === "string"` check through a NonNullable-only predicate).
  return nodes
    .filter((n): n is NonNullable<typeof n> & { id: string } => n !== null && typeof n.id === "string")
    .map((n) => ({
      id: n.id,
      fullDatabaseId: n.fullDatabaseId ?? "",
      body: n.body ?? "",
      authorType: n.author?.__typename ?? null,
      authorLogin: n.author?.login ?? null,
      commitOid: n.commit?.oid ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Association rows + leases (review_threads — the §7.5 resolution queue)
// ---------------------------------------------------------------------------

/** Association lease duration (spec §7.7 step-8 parity: 120s, epoch-fenced). */
export const ASSOCIATION_LEASE_MS = 120_000;

type AssociationRow = {
  id: string;
  finding_row_id: string;
  publication_id: string;
  app_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  original_sha: string;
  round: number;
  intent_json: string;
  review_id: number | null;
  comment_id: number | null;
  thread_id: string | null;
  resolution_state: string;
  verified_json: string | null;
  holder: string | null;
  lease_epoch: number;
  lease_until_ms: number | null;
  superseded_by_publication_id: string | null;
  late_change: number;
  last_error: string | null;
};

async function loadAssociation(db: D1Like, id: string): Promise<AssociationRow | null> {
  return db.prepare(`SELECT * FROM review_threads WHERE id = ?`).bind(id).first<AssociationRow>();
}

/**
 * Conditional epoch-fenced association lease: only a non-terminal row
 * (`pending`/`retry`) with a free or expired lease can be claimed; claiming
 * stamps holder + epoch + 120s.
 *
 * `countAttempt` (default true) decides whether this claim spends one of the
 * row's resolution attempts. An ACTUAL resolution attempt spends one; the
 * §7.5 DISCOVERY pass does not (P67-QC-005) — discovery is read-only
 * bookkeeping that binds remote ids, and charging it would let a crash
 * window burn the whole retry budget before any resolve was ever issued.
 */
async function claimAssociationLease(
  db: D1Like,
  id: string,
  holder: string,
  nowMs: number,
  countAttempt = true,
): Promise<Lease | null> {
  const claim = await db
    .prepare(
      `UPDATE review_threads
       SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?, updated_ms = ?${
         countAttempt ? ", attempts = attempts + 1" : ""
       }
       WHERE id = ? AND resolution_state IN ('pending','retry')
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
    )
    .bind(holder, nowMs + ASSOCIATION_LEASE_MS, nowMs, id, nowMs)
    .run();
  if (claim.meta.changes === 0) return null;
  const row = await loadAssociation(db, id);
  if (row === null || row.holder !== holder || row.lease_until_ms === null) return null;
  return { holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms };
}

async function releaseAssociationLease(db: D1Like, id: string, lease: Lease, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE review_threads SET holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(nowMs, id, lease.holder, lease.epoch)
    .run();
}

// ---------------------------------------------------------------------------
// Discovery + resolution adapter (spec §7.5 verbatim)
// ---------------------------------------------------------------------------

export type ResolveOutcome =
  | { kind: "resolved"; threadId: string; adopted: boolean; outdated: boolean; lateChange: boolean }
  | { kind: "needs-recheck"; reason: "head-changed" | "conversation-changed" | "context-incomplete" | "concern-unresolved" }
  | { kind: "abandoned"; reason: "foreign" | "superseded" | "identity-mismatch" }
  | { kind: "retry"; reason: "api" | "lookup-incomplete" };

export type DiscoveryResult =
  | { kind: "found"; reviewId: number; commentId: number; threadId: string }
  | { kind: "unknown" | "ambiguous" | "foreign" };

export type ReviewThreadsDeps = {
  db: D1Like;
  nowMs: () => number;
  /**
   * JWT-authenticated `GET /app` identity proof (spec §7.5): numeric id +
   * nonblank slug of the LIVE App behind the routed credentials. Never an
   * installation-token `viewer.login` assumption. null = identity
   * unavailable (fail closed).
   */
  getAppIdentity(input: { appId: string; installationId: number }): Promise<{ githubAppId: number; slug: string } | null>;
  /**
   * Purpose-scoped review-write client for the EXACT App+installation+
   * repository (spec §7.6). null = no GitHub mutation (missing mapping,
   * denial). The transport is the per-App Octokit's existing graphql().
   */
  getOctokit(input: { appId: string; installationId: number; owner: string; repo: string }): Promise<GraphqlOctokit | null>;
};

type AppContext = { octokit: GraphqlOctokit; botLogin: string; githubAppId: number; slug: string };

/**
 * Credential routing by EXACT (app_id, installation_id) with fail-closed
 * ambiguity (spec §7.5/§7.6): bind both durable ids through
 * `app_installations` into the matching `github_apps` row — never scan all
 * active Apps for a repository. Deleted/disabled rows, missing identity,
 * identity disagreement with the row's `github_app_id`, or a blank slug all
 * fail closed (null). Routing-query, identity-proof and mint throws are
 * caught here — callers map null to their typed outcome, so a transport
 * outage never escapes the discriminated-union contracts.
 */
async function resolveAppContext(deps: ReviewThreadsDeps, scope: Scope): Promise<AppContext | null> {
  try {
    const row = await deps.db
      .prepare(
        `SELECT ga.github_app_id AS github_app_id, ga.slug AS slug, ga.status AS status, ga.deleted_at AS deleted_at
         FROM app_installations ai
         JOIN github_apps ga ON ga.id = ai.app_id
         WHERE ai.app_id = ? AND ai.installation_id = ?`,
      )
      .bind(scope.appId, scope.installationId)
      .first<{ github_app_id: number; slug: string; status: string; deleted_at: string | null }>();
    if (row === null) return null;
    if (row.deleted_at !== null || row.status !== "active") return null;
    const identity = await deps.getAppIdentity({ appId: scope.appId, installationId: scope.installationId });
    if (identity === null) return null;
    // Slug-vs-live-App disagreement fails closed (changed identity / spoofed
    // credential pair); a blank slug is never a bot identity.
    if (identity.githubAppId !== row.github_app_id) return null;
    if (typeof identity.slug !== "string" || identity.slug.length === 0) return null;
    const octokit = await deps.getOctokit({
      appId: scope.appId,
      installationId: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
    });
    if (octokit === null) return null;
    return { octokit, botLogin: `${identity.slug}[bot]`, githubAppId: row.github_app_id, slug: identity.slug };
  } catch {
    return null; // identity/mint/routing failure fails closed (typed downstream)
  }
}

function sameScope(row: AssociationRow, scope: Scope): boolean {
  return (
    row.app_id === scope.appId &&
    row.installation_id === scope.installationId &&
    row.owner === scope.owner &&
    row.repo === scope.repo &&
    row.pr_number === scope.prNumber
  );
}

function isBotAuthor(entry: ThreadCommentEntry, botLogin: string): boolean {
  return entry.authorType === "Bot" && entry.authorLogin === botLogin;
}

/** App-author gate for review stubs (author fields, not a full entry). */
function isBotIdentity(authorType: string | null, authorLogin: string | null, botLogin: string): boolean {
  return authorType === "Bot" && authorLogin === botLogin;
}

/**
 * The §7.5 "exact original path/range" anchor fence, shared by discovery's
 * candidate scan and the resolve re-check (P67-QC-002). A thread with a live
 * `line` must match it exactly. Once the commented line leaves the diff the
 * thread becomes `outdated`, GitHub drops the live `line` to null, and the
 * only surviving anchor is `originalLine` — so an OUTDATED thread whose live
 * line is null may match on that original anchor. Every other shape fails
 * closed (different path, a re-anchored live line, a mismatched original
 * anchor, or a null live line on a thread GitHub did not mark outdated):
 * ownership never widens to arbitrary threads.
 */
function matchesOriginalAnchor(
  thread: { path: string; line: number | null; originalLine: number | null; isOutdated: boolean },
  intent: LineIntent,
): boolean {
  if (thread.path !== intent.path) return false;
  if (thread.line !== null) return thread.line === intent.line;
  return thread.isOutdated && thread.originalLine === intent.line;
}

/**
 * Discovery + adoption of one prepared association's remote thread (spec
 * §7.5 "Discovery/adoption" verbatim). See the module docblock for the full
 * gate list. `input.reviewId === null` means the send response was lost —
 * the PR's bounded review batches are then inspected for the unique complete
 * batch match. Found ids persist under the association's lease BEFORE any
 * resolve may run.
 */
/**
 * The §7.5 ownership/provenance LOOKUP shared by discovery and resolve: load
 * the prepared association, verify the confirmed original publication + the
 * stored intent consistency, prove the authenticated App identity, then walk
 * the bounded review-batch and thread scans for the unique complete match.
 *
 * Read-only and lease-free by design: the caller owns persistence (and
 * therefore the lease/fencing), which is what lets the resolve path use this
 * same proof when it has to bind missing remote ids itself (P67-QC-004)
 * without a nested claim on a lease it already holds.
 */
async function lookupThreadForIntent(
  deps: ReviewThreadsDeps,
  scope: Scope,
  intent: LineIntent,
  reviewId: number | null,
): Promise<DiscoveryResult> {
  // Reject scope mismatch or unknown association BEFORE any API call.
  const row = await loadAssociation(deps.db, intent.associationId);
  if (row === null || !sameScope(row, scope)) return { kind: "unknown" };
  if (row.superseded_by_publication_id !== null) return { kind: "unknown" };

  // Confirmed original primary publication + stored intent consistency.
  const pub = await deps.db
    .prepare(`SELECT phase, kind, head_sha FROM review_publications WHERE id = ?`)
    .bind(row.publication_id)
    .first<{ phase: string; kind: string; head_sha: string }>();
  if (pub === null || (pub.phase !== "confirmed" && pub.phase !== "applied") || pub.kind !== "review") {
    return { kind: "unknown" };
  }
  if (pub.head_sha !== intent.originalSha) return { kind: "unknown" };
  let storedIntent: LineIntent;
  try {
    storedIntent = JSON.parse(row.intent_json) as LineIntent;
  } catch {
    return { kind: "unknown" };
  }
  if (
    storedIntent.publicationId !== intent.publicationId ||
    storedIntent.bodySha256 !== intent.bodySha256 ||
    storedIntent.path !== intent.path ||
    storedIntent.line !== intent.line
  ) {
    return { kind: "unknown" };
  }

  // Authenticated identity — fail closed before any further call.
  const ctx = await resolveAppContext(deps, scope);
  if (ctx === null) return { kind: "unknown" };

  // The expected original line-review batch marker on the App-owned review.
  // Read-path transport failures are TYPED (`unknown`), never exceptions —
  // the caller holds no lease for this read, so there is nothing to unwind.
  let reviews: PrReviewStub[];
  try {
    reviews = await fetchPrReviews(ctx.octokit, scope);
  } catch {
    return { kind: "unknown" };
  }
  let review: PrReviewStub | null = null;
  if (reviewId !== null) {
    // A known returned reviewId must match exactly — AND the review body
    // must carry OUR prepared line-batch marker (spec §7.5 lists the batch
    // marker among the unconditional adoption requirements; a review id
    // alone never proves the body was not edited/replaced).
    const known = reviews.find((r) => r.fullDatabaseId === String(reviewId));
    if (known === undefined) {
      return { kind: "foreign" };
    }
    if (parseLineBatchMarker(known.body)?.publicationId !== intent.publicationId) {
      return { kind: "foreign" };
    }
    review = known;
  } else {
    // Response loss: the unique bot-authored review carrying OUR batch
    // marker for THIS publication is the only acceptable batch.
    const matching = reviews.filter(
      (r) => isBotIdentity(r.authorType, r.authorLogin, ctx.botLogin) && parseLineBatchMarker(r.body)?.publicationId === intent.publicationId,
    );
    if (matching.length !== 1) return matching.length === 0 ? { kind: "unknown" } : { kind: "ambiguous" };
    review = matching[0] ?? null;
  }
  if (review === null) return { kind: "unknown" };
  if (!isBotIdentity(review.authorType, review.authorLogin, ctx.botLogin)) {    return { kind: "foreign" };
  }
  // The review must be pinned to the original commit SHA.
  if (review.commitOid !== intent.originalSha) {    return { kind: "foreign" };
  }

  // Bounded thread scan; match by exact path/range + root marker + digest.
  let scan: ReviewThreadsCapture;
  try {
    scan = await fetchReviewThreads(ctx.octokit, scope);
  } catch {
    return { kind: "unknown" }; // typed read-path failure, never an exception
  }
  if (!scan.complete) return { kind: "unknown" };
  let foreign = false;
  const candidates: { thread: ReviewThreadStub }[] = [];
  for (const thread of scan.threads) {
    if (!matchesOriginalAnchor(thread, intent)) continue;
    const root = thread.root;
    if (root === null) continue; // absent root blocks any claim
    const marker = parseLineMarker(root.body);
    if (marker === null) continue;
    if (marker.publicationId !== intent.publicationId || marker.associationId !== intent.associationId) {
      continue; // a different association's thread — not ours to claim
    }
    // A copied marker (another review/round/SHA/author/body) is insufficient.
    if (!isBotAuthor(root, ctx.botLogin)) {      foreign = true;
      continue;
    }
    if ((await sha256Hex(root.body)) !== intent.bodySha256) {      foreign = true;
      continue;
    }
    if (thread.rootReviewRestId === null || thread.rootReviewRestId !== review.fullDatabaseId) {      foreign = true;
      continue;
    }
    candidates.push({ thread });
  }
  if (candidates.length === 0) return foreign ? { kind: "foreign" } : { kind: "unknown" };
  if (candidates.length > 1) return { kind: "ambiguous" };
  const found = candidates[0]!.thread;
  const root = found.root!;
  const resolvedReviewId = Number(review.fullDatabaseId);
  const commentId = Number(root.fullDatabaseId);
  if (!Number.isSafeInteger(resolvedReviewId) || !Number.isSafeInteger(commentId)) return { kind: "unknown" };
  return { kind: "found", reviewId: resolvedReviewId, commentId, threadId: found.id };
}

/**
 * Discovery + adoption of one prepared association's remote thread (spec
 * §7.5 "Discovery/adoption" verbatim). See the module docblock for the full
 * gate list. `input.reviewId === null` means the send response was lost —
 * the PR's bounded review batches are then inspected for the unique complete
 * batch match. Found ids persist under the association's lease BEFORE any
 * resolve may run.
 */
export async function discoverThreadWithDeps(
  deps: ReviewThreadsDeps,
  input: { scope: Scope; intent: LineIntent; reviewId: number | null },
): Promise<DiscoveryResult> {
  const { scope, intent } = input;
  const result = await lookupThreadForIntent(deps, scope, intent, input.reviewId);
  if (result.kind !== "found") return result;

  // Persist discovered review/comment/thread ids under the association's
  // lease BEFORE resolving (spec §7.5). This is DISCOVERY, not a resolution
  // attempt: the claim does not spend the row's ≤5-attempt resolution budget
  // (P67-QC-005), so a crash-recovery pass that only binds ids can never
  // consume the budget the actual resolve needs.
  const holder = `review-threads:${intent.associationId}`;
  const lease = await claimAssociationLease(deps.db, intent.associationId, holder, deps.nowMs(), false);
  if (lease === null) return { kind: "unknown" };
  await deps.db
    .prepare(
      `UPDATE review_threads SET review_id = ?, comment_id = ?, thread_id = ?, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(result.reviewId, result.commentId, result.threadId, deps.nowMs(), intent.associationId, lease.holder, lease.epoch)
    .run();
  await releaseAssociationLease(deps.db, intent.associationId, lease, deps.nowMs());
  return result;
}

// --- resolution ---------------------------------------------------------------

const RESOLVE_THREAD_MUTATION = `
mutation($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) {
    thread { id isResolved }
  }
}`;

async function currentIssueDigest(ctx: AppContext, scope: Scope): Promise<string | null> {
  const capture = await fetchIssueComments(ctx.octokit, scope);
  if (!capture.complete) return null;
  return issueDigestOf({ headSha: capture.headRefOid, comments: capture.comments });
}

/**
 * Resolve one verified association (spec §7.5 "Resolve order" verbatim).
 * Every fence compares against the snapshots ACTUALLY sent to the reviewer —
 * the expected digest is never refreshed to bless new replies. See the
 * module docblock for the full gate ordering.
 */
export async function resolveFindingThreadWithDeps(
  deps: ReviewThreadsDeps,
  input: { scope: Scope; associationId: string; verified: VerifiedResolution },
): Promise<ResolveOutcome> {
  const { scope, associationId, verified } = input;
  const nowMs = deps.nowMs();
  const holder = `review-threads:${associationId}`;

  // 1. Acquire the association lease.
  const lease = await claimAssociationLease(deps.db, associationId, holder, nowMs);
  if (lease === null) {
    // A failed claim is a live competing lease OR a terminal row this module
    // already settled. Terminal rows are typed no-ops — surfacing retry:api
    // for a settled row would hot-loop recovery against it (the outcome
    // contracts never leak exceptions, and a settled association is never
    // re-resolved through re-entry).
    const current = await loadAssociation(deps.db, associationId);
    if (current !== null && sameScope(current, scope)) {
      if (current.resolution_state === "resolved") {
        // Idempotent re-entry on a settled row: report the stored resolution
        // (outdated is not re-derived without a fetch; lateChange is stored).
        return {
          kind: "resolved",
          threadId: current.thread_id ?? "",
          adopted: true,
          outdated: false,
          lateChange: current.late_change === 1,
        };
      }
      if (current.resolution_state === "abandoned") {
        // The specific abandon reason is persisted only as free-text
        // last_error; supersession is recoverable from its column. Either
        // way the row is terminal — never resolved through re-entry.
        return {
          kind: "abandoned",
          reason: current.superseded_by_publication_id !== null ? "superseded" : "foreign",
        };
      }
    }
    return { kind: "retry", reason: "api" };
  }

  // 2. Reload the row under the lease.
  const row = await loadAssociation(deps.db, associationId);
  if (row === null || !sameScope(row, scope)) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "abandoned", reason: "foreign" };
  }
  if (row.superseded_by_publication_id !== null) {
    await persistOutcome(deps.db, associationId, lease, nowMs, {
      state: "abandoned",
      error: "superseded by a newer publication",
    });
    return { kind: "abandoned", reason: "superseded" };
  }

  // 3. The finding must still be addressed by THIS exact verified
  //    publication, and the verified assessment must be an addressed
  //    verdict for this exact row (never an unverifiable one).
  const finding = await deps.db
    .prepare(`SELECT state, last_publication_id FROM review_findings WHERE id = ?`)
    .bind(row.finding_row_id)
    .first<{ state: string; last_publication_id: string }>();
  if (
    verified.assessment.disposition !== "addressed" ||
    verified.assessment.rowId !== row.finding_row_id ||
    finding === null ||
    finding.state !== "addressed" ||
    finding.last_publication_id !== row.publication_id
  ) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "concern-unresolved" };
  }

  // 4. All recorded coverage must be complete (the snapshot the reviewer
  //    actually saw — a truncated capture never authorizes a resolve).
  if (
    verified.snapshot.coverage !== "complete" ||
    verified.snapshot.modelCoverage !== "complete" ||
    verified.issueCoverage !== "complete"
  ) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "context-incomplete" };
  }

  // 5. Prove root ownership/provenance against the CURRENT remote state.
  const ctx = await resolveAppContext(deps, scope);
  if (ctx === null) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: "app identity unavailable" });
    return { kind: "retry", reason: "api" };
  }
  const intent: LineIntent | null = safeParseIntent(row.intent_json);
  if (intent === null) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "stored intent unreadable" });
    return { kind: "abandoned", reason: "foreign" };
  }
  // Crash-window recovery (§7.11.1 failure matrix: "Crash before/after
  // resolve API → Pending association + verified snapshot → M8 retries
  // original fences"): the row may hold its verified snapshot while the
  // remote ids were never bound, because the enqueue is deliberately
  // persisted BEFORE discovery. Discovery is exactly the §7.5 pass that
  // binds them, so run it here from the STORED intent rather than
  // returning `lookup-incomplete` forever — that outcome would consume the
  // whole retry budget and strand the row as a terminal local-error for a
  // crash we can repair (P67-QC-004).
  let commentId = row.comment_id;
  let threadId = row.thread_id;
  if (threadId === null || commentId === null || row.review_id === null) {
    const discovered = await lookupThreadForIntent(deps, scope, intent, null);
    if (discovered.kind !== "found") {
      // Still unprovable (unknown/ambiguous/foreign): a TYPED retry — the
      // row keeps its snapshot and stays due for the next pass. The lease
      // is released through persistOutcome, never held until expiry.
      await persistOutcome(deps.db, associationId, lease, nowMs, {
        state: "retry",
        error: `thread discovery returned ${discovered.kind}`,
      });
      return { kind: "retry", reason: "lookup-incomplete" };
    }
    // Bind the discovered ids in the SAME fencing epoch as the claim, so a
    // concurrent resolver can never observe a half-written association.
    await deps.db
      .prepare(
        `UPDATE review_threads SET review_id = ?, comment_id = ?, thread_id = ?, updated_ms = ?
         WHERE id = ? AND holder = ? AND lease_epoch = ?`,
      )
      .bind(discovered.reviewId, discovered.commentId, discovered.threadId, nowMs, associationId, lease.holder, lease.epoch)
      .run();
    commentId = discovered.commentId;
    threadId = discovered.threadId;
  }

  let capture: ThreadCapture;
  try {
    capture = await fetchThreadConversation(ctx.octokit, threadId);
  } catch (err) {
    // Read-path transport failure is a TYPED retry — the lease is released
    // through persistOutcome, never held until expiry by an escaping throw.
    const detail = err instanceof Error ? err.message : String(err);
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: `thread capture failed: ${detail}` });
    return { kind: "retry", reason: "api" };
  }
  if (capture.thread === null) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "thread missing" });
    return { kind: "abandoned", reason: "foreign" };
  }
  const thread = capture.thread;
  // The query's PR identity is validated, not merely accepted from the input.
  if (thread.prNumber !== scope.prNumber || thread.nameWithOwner !== `${scope.owner}/${scope.repo}`) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "thread PR identity mismatch" });
    return { kind: "abandoned", reason: "foreign" };
  }
  if (!capture.complete) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "context-incomplete" };
  }
  const root = capture.comments[0] ?? null; // chronological first = root
  if (root === null || root.fullDatabaseId !== String(commentId)) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "root comment mismatch" });
    return { kind: "abandoned", reason: "foreign" };
  }
  const marker = parseLineMarker(root.body);
  if (
    marker === null ||
    marker.publicationId !== row.publication_id ||
    marker.associationId !== associationId
  ) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "root marker mismatch" });
    return { kind: "abandoned", reason: "foreign" };
  }
  if (!isBotAuthor(root, ctx.botLogin)) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "root author is not the authenticated App bot" });
    return { kind: "abandoned", reason: "identity-mismatch" };
  }
  if (!matchesOriginalAnchor(thread, intent)) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "thread path/line mismatch" });
    return { kind: "abandoned", reason: "foreign" };
  }

  // 6. HEAD + full-conversation digest/count fences against the snapshots
  //    actually sent. Never refresh the expected digest.
  if (capture.headRefOid !== verified.snapshot.headSha) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "head-changed" };
  }
  const digest = await threadDigestOf({
    threadId: thread.id,
    rootCommentId: String(commentId),
    headSha: capture.headRefOid,
    comments: capture.comments,
  });
  if (digest !== verified.snapshot.digest || capture.comments.length !== verified.snapshot.commentCount) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "conversation-changed" };
  }
  let issue: string | null;
  try {
    issue = await currentIssueDigest(ctx, scope);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: `issue capture failed: ${detail}` });
    return { kind: "retry", reason: "api" };
  }
  if (issue === null || issue !== verified.issueDigest) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: issue === null ? "context-incomplete" : "conversation-changed" };
  }

  // 7. An already-resolved owned thread is ADOPTED as resolved (ownership
  //    proof already established). `isOutdated` is recorded, not a veto —
  //    an owned outdated thread remains eligible after a real fix.
  if (thread.isResolved) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "resolved", resolvedMs: nowMs });
    return { kind: "resolved", threadId: thread.id, adopted: true, outdated: thread.isOutdated, lateChange: false };
  }

  // 8. Immediately recheck the local lease/fence, then mutate. GitHub has no
  //    conditional resolve CAS — the check→mutation race is documented
  //    honestly (spec RL-12 / §7.5 "Unavoidable race").
  const fresh = await loadAssociation(deps.db, associationId);
  if (
    fresh === null ||
    fresh.holder !== lease.holder ||
    fresh.lease_epoch !== lease.epoch ||
    fresh.lease_until_ms === null ||
    fresh.lease_until_ms <= deps.nowMs()
  ) {
    // A lost local lease prohibits further writes/calls.
    return { kind: "retry", reason: "api" };
  }

  // The declared shape mirrors the mutation's response wrapper — the value
  // assigned from graphql() is the { resolveReviewThread: { thread } } doc.
  let mutation: { resolveReviewThread?: { thread?: { id?: string | null; isResolved?: boolean | null } | null } | null } | null = null;
  try {
    mutation = await ctx.octokit.graphql<{ resolveReviewThread?: { thread?: { id?: string | null; isResolved?: boolean | null } | null } | null }>(
      RESOLVE_THREAD_MUTATION,
      { input: { threadId: thread.id } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: `resolveReviewThread failed: ${detail}` });
    return { kind: "retry", reason: "api" };
  }
  const mutated = mutation?.resolveReviewThread?.thread ?? null;
  // Require matching returned ID plus isResolved === true before storing
  // resolved (spec §7.5). Anything else is an unconfirmed mutation.
  if (mutated === null || mutated.id !== thread.id || mutated.isResolved !== true) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: "resolve mutation not confirmed (id/isResolved mismatch)" });
    return { kind: "retry", reason: "api" };
  }

  // 9. Post-mutation observation, once: changed HEAD/digest or a failed
  //    post-read is recorded as `lateChange` — never claimed to cover the
  //    newer discussion, never un-resolved.
  let lateChange = false;
  try {
    const after = await fetchThreadConversation(ctx.octokit, thread.id);
    if (
      after.thread === null ||
      after.headRefOid !== capture.headRefOid ||
      (await threadDigestOf({
        threadId: thread.id,
        rootCommentId: String(commentId),
        headSha: after.headRefOid,
        comments: after.comments,
      })) !== digest ||
      after.comments.length !== capture.comments.length
    ) {
      lateChange = true;
    }
  } catch {
    lateChange = true; // failed post-read is an unconfirmed observation
  }
  await persistOutcome(deps.db, associationId, lease, nowMs, {
    state: "resolved",
    resolvedMs: nowMs,
    lateChange,
  });
  return { kind: "resolved", threadId: thread.id, adopted: false, outdated: thread.isOutdated, lateChange };
}

function safeParseIntent(json: string): LineIntent | null {
  try {
    const parsed = JSON.parse(json) as LineIntent;
    if (typeof parsed.path !== "string" || typeof parsed.bodySha256 !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the resolution outcome under the live lease and release it. */
async function persistOutcome(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: number,
  outcome: { state: string; resolvedMs?: number; lateChange?: boolean; error?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE review_threads
       SET resolution_state = ?, resolved_ms = ?, late_change = ?, last_error = ?,
           holder = NULL, lease_until_ms = NULL, next_attempt_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(
      outcome.state,
      outcome.resolvedMs ?? null,
      outcome.lateChange === true ? 1 : 0,
      outcome.error ?? null,
      nowMs,
      id,
      lease.holder,
      lease.epoch,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Factory — the §7.5 adapter T4 wires onto the per-App commenter surface.
// ---------------------------------------------------------------------------

export function createReviewThreads(deps: ReviewThreadsDeps): {
  discoverThread: (input: { scope: Scope; intent: LineIntent; reviewId: number | null }) => Promise<DiscoveryResult>;
  resolveFindingThread: (input: { scope: Scope; associationId: string; verified: VerifiedResolution }) => Promise<ResolveOutcome>;
} {
  return {
    discoverThread: (input) => discoverThreadWithDeps(deps, input),
    resolveFindingThread: (input) => resolveFindingThreadWithDeps(deps, input),
  };
}

// Re-export the thread-snapshot vocabulary so T4's wiring can build
// VerifiedResolution values without importing two modules.
export type { Coverage, ThreadSnapshot };
