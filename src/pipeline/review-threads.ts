
import type { Coverage, ThreadSnapshot } from "../../packages/shared/src/recheck-wire";
import type { D1Like } from "../store/types";
import {
  type Lease,
  type LineIntent,
  type Scope,
  type VerifiedResolution,
} from "../store/finding-lifecycle";
import { DEGRADED_MARKER_PREFIX, REVIEW_MARKER_PREFIX } from "./review-markers";


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
  publicationId: string;
  associationId: string;
  scope: Scope;
  originalSha: string;
  round: number;
  path: string;
  line: number;
  lineStart?: number | null;
  body: string;
};

/**
 * Build one prepared line intent from preallocated opaque UUIDs and compute
 * the generated-body digest (`bodySha256` = SHA-256 of the exact body
 * `buildLineCommentBody` will post). Ids are validated as canonical
 * lowercase UUIDs — fail-closed before any marker can carry a non-opaque id.
 */
export async function buildLineIntent(input: BuildLineIntentInput): Promise<LineIntent> {
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
    lineStart: input.lineStart ?? null,
    body: input.body,
    bodySha256,
  };
}


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
  viewerDidAuthor: boolean;
  createdAt: string;
  updatedAt: string;
  body: string;
};

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
  viewerDidAuthor?: boolean | null;
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
    viewerDidAuthor: node.viewerDidAuthor === true,
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
          viewerDidAuthor
          originalCommit { oid }
          pullRequestReview { id }
        }
      }
    }
  }
}`;

export type ThreadCapture = {
  thread: {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    line: number | null;
    originalLine: number | null;
    prNumber: number;
    headRefOid: string;
    nameWithOwner: string;
  } | null;
  comments: ThreadCommentEntry[];
  totalCount: number;
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
  if (before !== undefined) complete = false;
  if (complete) {
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
        nodes { id fullDatabaseId body createdAt updatedAt author { __typename login } viewerDidAuthor }
      }
    }
  }
}`;

export type IssueCapture = {
  headRefOid: string;
  comments: ThreadCommentEntry[];
  totalCount: number;
  complete: boolean;
};

/**
 * The Inspector's own publication comments — the review and degraded chains
 * both upsert ONE issue comment whose body starts with their marker prefix
 * (spec §7.5/§7.8). They are excluded from the CAPTURED issue discussion so
 * the model context, the capture-time digest and the resolve-side digest all
 * share one domain: posting a review cannot change the digest it was
 * verified against, and the model never re-reads its own previous review as
 * human discussion. Bot authorship is what `findReviewComment` /
 * `findDegradedComment` already require, so a human-planted marker is not
 * ours.
 *
 * Accepted limit: a FOREIGN App's bot-authored comment whose body carries
 * our marker prefix would also leave the digest domain. The marker embeds a
 * publication UUID this App generates, so the collision is cosmetic;
 * enforcing authorship would need the probed App identity inside the capture
 * layer, which this layer does not have.
 */
export function isOwnPublicationComment(entry: ThreadCommentEntry): boolean {
  return (
    entry.authorType === "Bot" &&
    (entry.body.startsWith(REVIEW_MARKER_PREFIX) || entry.body.startsWith(DEGRADED_MARKER_PREFIX))
  );
}

/**
 * Newest-first issue-comment capture (spec §7.8): the PR's
 * `comments(last:100, before:cursor)` connection walked backward, TWO pages
 * maximum — deliberately avoiding the oldest-first REST `issues.listComments`
 * first pages. Nodes are merged chronologically for presentation/digests.
 * After a complete walk the final newest page count and PR HEAD are RE-READ
 * (spec §7.5/§7.8 stability recheck) — drift marks the capture incomplete.
 *
 * `totalCount` and pagination completeness describe the RAW GitHub
 * connection; the returned `comments` exclude the Inspector's own publication
 * comments (the digest/context domain) unless `includeOwnPublications` is set,
 * so the truncation bound is applied to the returned entries by the caller.
 * That opt-in exists for ONE consumer: the `sending`/`unknown` publication
 * discovery, which must be able to find the very comment it may have posted.
 */
export async function fetchIssueComments(
  octokit: GraphqlOctokit,
  input: { owner: string; repo: string; prNumber: number },
  options: { includeOwnPublications?: boolean } = {},
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
    return { headRefOid: "", comments: [], totalCount: 0, complete: false };
  }
  if (complete) {
    const data = await octokit.graphql<{ repository?: { pullRequest?: PrNode | null } }>(ISSUE_COMMENTS_QUERY, head);
    const pr = data?.repository?.pullRequest;
    const conn = pr?.comments;
    if (!conn || (conn.totalCount ?? totalCount) !== totalCount || (pr?.headRefOid ?? "") !== headRefOid) {
      complete = false;
    }
  }
  return {
    headRefOid,
    comments: options.includeOwnPublications === true ? comments : comments.filter((entry) => !isOwnPublicationComment(entry)),
    totalCount,
    complete,
  };
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
            # viewerDidAuthor keeps entryOf's provenance field REAL for stub
            # roots too — never a fabricated false on our own comments.
            nodes { id fullDatabaseId body author { __typename login } viewerDidAuthor pullRequestReview { id fullDatabaseId } }
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
  line: number | null;
  originalLine: number | null;
  root: ThreadCommentEntry | null;
  rootReviewId: string | null;
  rootReviewRestId: string | null;
};

export type ReviewThreadsCapture = {
  threads: ReviewThreadStub[];
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
      if (page === 4) complete = false;
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
  getAppIdentity(input: { appId: string; installationId: number }): Promise<{ githubAppId: number; slug: string } | null>;
  getOctokit(input: { appId: string; installationId: number; owner: string; repo: string }): Promise<GraphqlOctokit | null>;
};

type AppContext = { octokit: GraphqlOctokit; botLogin: string; githubAppId: number; slug: string };

async function resolveAppContext(deps: ReviewThreadsDeps, scope: Scope): Promise<AppContext | null> {
  try {
    const row = await deps.db
      // shortcut: tenant-bypass — consumer bot resolution by exact (app_id,
      // installation_id); no tenant-facing field. Upgrade: tenant-filter it once
      // the consumer becomes workspace-scoped.
      .prepare(
        `SELECT ga.github_app_id AS github_app_id, ga.status AS status, ga.deleted_at AS deleted_at
         FROM github_app_installations ai
         JOIN github_apps ga ON ga.id = ai.app_id
         WHERE ai.app_id = ? AND ai.installation_id = ?`,
      )
      .bind(scope.appId, scope.installationId)
      .first<{ github_app_id: number; status: string; deleted_at: string | null }>();
    if (row === null) return null;
    if (row.deleted_at !== null || row.status !== "active") return null;
    const identity = await deps.getAppIdentity({ appId: scope.appId, installationId: scope.installationId });
    if (identity === null) return null;
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
    return null;
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

const BOT_LOGIN_SUFFIX = "[bot]";

/**
 * The one App-bot login comparison, shared by every ownership gate: GitHub
 * returns the same identity as `<slug>[bot]` over REST and as the bare
 * `<slug>` from GraphQL `author.login`, so both shapes must match the one
 * canonical `botLogin`. A `botLogin` that is not that canonical shape fails
 * closed (a bare login is never treated as an App identity), as do null and
 * blank authors — ownership never widens.
 */
export function sameAppBotLogin(login: string | null, botLogin: string): boolean {
  if (login === null || !botLogin.endsWith(BOT_LOGIN_SUFFIX)) return false;
  const slug = botLogin.slice(0, -BOT_LOGIN_SUFFIX.length);
  return slug.length > 0 && (login === botLogin || login === slug);
}

function isBotAuthor(entry: ThreadCommentEntry, botLogin: string): boolean {
  return entry.authorType === "Bot" && sameAppBotLogin(entry.authorLogin, botLogin);
}

function isBotIdentity(authorType: string | null, authorLogin: string | null, botLogin: string): boolean {
  return authorType === "Bot" && sameAppBotLogin(authorLogin, botLogin);
}

function matchesOriginalAnchor(
  thread: { path: string; line: number | null; originalLine: number | null; isOutdated: boolean },
  intent: LineIntent,
): boolean {
  if (thread.path !== intent.path) return false;
  if (thread.line === intent.line) return true;
  if (thread.line === null) return thread.isOutdated && thread.originalLine === intent.line;
  return !thread.isOutdated && thread.originalLine === intent.line;
}

async function lookupThreadForIntent(
  deps: ReviewThreadsDeps,
  scope: Scope,
  intent: LineIntent,
  reviewId: number | null,
): Promise<DiscoveryResult> {
  const row = await loadAssociation(deps.db, intent.associationId);
  if (row === null || !sameScope(row, scope)) return { kind: "unknown" };
  if (row.superseded_by_publication_id !== null) return { kind: "unknown" };

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

  const ctx = await resolveAppContext(deps, scope);
  if (ctx === null) return { kind: "unknown" };

  let reviews: PrReviewStub[];
  try {
    reviews = await fetchPrReviews(ctx.octokit, scope);
  } catch {
    return { kind: "unknown" };
  }
  let review: PrReviewStub | null = null;
  if (reviewId !== null) {
    const known = reviews.find((r) => r.fullDatabaseId === String(reviewId));
    if (known === undefined) {
      return { kind: "foreign" };
    }
    if (parseLineBatchMarker(known.body)?.publicationId !== intent.publicationId) {
      return { kind: "foreign" };
    }
    review = known;
  } else {
    const matching = reviews.filter(
      (r) => isBotIdentity(r.authorType, r.authorLogin, ctx.botLogin) && parseLineBatchMarker(r.body)?.publicationId === intent.publicationId,
    );
    if (matching.length !== 1) return matching.length === 0 ? { kind: "unknown" } : { kind: "ambiguous" };
    review = matching[0] ?? null;
  }
  if (review === null) return { kind: "unknown" };
  if (!isBotIdentity(review.authorType, review.authorLogin, ctx.botLogin)) {    return { kind: "foreign" };
  }
  if (review.commitOid !== intent.originalSha) {    return { kind: "foreign" };
  }

  let scan: ReviewThreadsCapture;
  try {
    scan = await fetchReviewThreads(ctx.octokit, scope);
  } catch {
    return { kind: "unknown" };
  }
  if (!scan.complete) return { kind: "unknown" };
  let foreign = false;
  const candidates: { thread: ReviewThreadStub }[] = [];
  for (const thread of scan.threads) {
    if (!matchesOriginalAnchor(thread, intent)) continue;
    const root = thread.root;
    if (root === null) continue;
    const marker = parseLineMarker(root.body);
    if (marker === null) continue;
    if (marker.publicationId !== intent.publicationId || marker.associationId !== intent.associationId) {
      continue;
    }
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

  const lease = await claimAssociationLease(deps.db, associationId, holder, nowMs);
  if (lease === null) {
    const current = await loadAssociation(deps.db, associationId);
    if (current !== null && sameScope(current, scope)) {
      if (current.resolution_state === "resolved") {
        return {
          kind: "resolved",
          threadId: current.thread_id ?? "",
          adopted: true,
          outdated: false,
          lateChange: current.late_change === 1,
        };
      }
      if (current.resolution_state === "abandoned") {
        return {
          kind: "abandoned",
          reason: current.superseded_by_publication_id !== null ? "superseded" : "foreign",
        };
      }
    }
    return { kind: "retry", reason: "api" };
  }

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

  const finding = await deps.db
    .prepare(`SELECT state FROM review_findings WHERE id = ?`)
    .bind(row.finding_row_id)
    .first<{ state: string }>();
  if (
    verified.assessment.disposition !== "addressed" ||
    verified.assessment.rowId !== row.finding_row_id ||
    finding === null ||
    finding.state !== "addressed"
  ) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "concern-unresolved" };
  }

  if (
    verified.snapshot.coverage !== "complete" ||
    verified.snapshot.modelCoverage !== "complete" ||
    verified.issueCoverage !== "complete"
  ) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "context-incomplete" };
  }

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
  let commentId = row.comment_id;
  let threadId = row.thread_id;
  if (threadId === null || commentId === null || row.review_id === null) {
    const discovered = await lookupThreadForIntent(deps, scope, intent, null);
    if (discovered.kind !== "found") {
      await persistOutcome(deps.db, associationId, lease, nowMs, {
        state: "retry",
        error: `thread discovery returned ${discovered.kind}`,
      });
      return { kind: "retry", reason: "lookup-incomplete" };
    }
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
    const detail = err instanceof Error ? err.message : String(err);
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: `thread capture failed: ${detail}` });
    return { kind: "retry", reason: "api" };
  }
  if (capture.thread === null) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "thread missing" });
    return { kind: "abandoned", reason: "foreign" };
  }
  const thread = capture.thread;
  if (thread.prNumber !== scope.prNumber || thread.nameWithOwner !== `${scope.owner}/${scope.repo}`) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "abandoned", error: "thread PR identity mismatch" });
    return { kind: "abandoned", reason: "foreign" };
  }
  if (!capture.complete) {
    await releaseAssociationLease(deps.db, associationId, lease, nowMs);
    return { kind: "needs-recheck", reason: "context-incomplete" };
  }
  const root = capture.comments[0] ?? null;
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

  if (thread.isResolved) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "resolved", resolvedMs: nowMs });
    return { kind: "resolved", threadId: thread.id, adopted: true, outdated: thread.isOutdated, lateChange: false };
  }

  const fresh = await loadAssociation(deps.db, associationId);
  if (
    fresh === null ||
    fresh.holder !== lease.holder ||
    fresh.lease_epoch !== lease.epoch ||
    fresh.lease_until_ms === null ||
    fresh.lease_until_ms <= deps.nowMs()
  ) {
    return { kind: "retry", reason: "api" };
  }

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
  if (mutated === null || mutated.id !== thread.id || mutated.isResolved !== true) {
    await persistOutcome(deps.db, associationId, lease, nowMs, { state: "retry", error: "resolve mutation not confirmed (id/isResolved mismatch)" });
    return { kind: "retry", reason: "api" };
  }

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
    lateChange = true;
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


export function createReviewThreads(deps: ReviewThreadsDeps): {
  discoverThread: (input: { scope: Scope; intent: LineIntent; reviewId: number | null }) => Promise<DiscoveryResult>;
  resolveFindingThread: (input: { scope: Scope; associationId: string; verified: VerifiedResolution }) => Promise<ResolveOutcome>;
} {
  return {
    discoverThread: (input) => discoverThreadWithDeps(deps, input),
    resolveFindingThread: (input) => resolveFindingThreadWithDeps(deps, input),
  };
}

export type { Coverage, ThreadSnapshot };
