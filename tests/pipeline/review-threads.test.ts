/**
 * Review-thread identity, discovery and resolution tests (plan 67 Task 2,
 * spec review-lifecycle §7.5) — `src/pipeline/review-threads.ts` against the
 * bun:sqlite double running the real migration SQL (createMigratedTestD1:
 * 0001 → 0020, so review_publications/review_findings/review_threads/
 * app_installations/github_apps are production-shaped) plus an in-memory
 * GraphQL transport double.
 *
 * Behaviors covered (brief verification list):
 *   - opaque marker wire: round-trip, forged/copied/malformed markers
 *     rejected, markers stay opaque for arbitrary fingerprint_hint values
 *     ("line-comment-anchor" and a CJK hint — no hint-derived content), and
 *     the trusted marker is appended AFTER stripping Inspector marker syntax
 *   - ownership proof precedes adoption: discovery requires the confirmed
 *     publication, batch marker, commit SHA, bot identity, root marker,
 *     exact path/range and generated-body digest; a copied marker at another
 *     review/author/body is foreign, multiple candidates are ambiguous
 *   - scope mismatch / unknown association rejected BEFORE any API call;
 *     identity-unavailable and incomplete pagination skip (unknown)
 *   - resolve fences: HEAD-changed and conversation-changed need-recheck,
 *     conversation-incomplete blocks, concern-not-addressed blocks
 *   - outdated OWNED thread resolves; already-resolved owned thread is
 *     adopted; resolve mutation must confirm matching id + isResolved === true
 *   - slug-vs-live-App identity disagreement fails closed; superseded
 *     associations are abandoned; post-mutation late-change observation
 */

import { describe, expect, test } from "bun:test";
import type { Scope } from "../../src/contracts/recheck";
import type { GraphqlOctokit } from "../../src/pipeline/review-threads";
import {
  issueDigestOf,
  sha256Hex,
  threadDigestOf,
} from "../../src/pipeline/review-threads";
import {
  buildLineBatchMarker,
  buildLineCommentBody,
  buildLineIntent,
  createReviewThreads,
  fetchIssueComments,
  fetchThreadConversation,
  lineMarker,
  parseLineBatchMarker,
  parseLineMarker,
  stripInspectorMarkerSyntax,
} from "../../src/pipeline/review-threads";
import {
  claimPublication,
  recordPublicationProof,
  stagePublication,
  type LineIntent,
  type PublicationPayload,
  type VerifiedResolution,
} from "../../src/store/finding-lifecycle";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SLUG = "test-inspector";
const BOT_LOGIN = `${SLUG}[bot]`;
const INSTALLATION_ID = 123;
const SCOPE: Scope = { appId: APP_ID, installationId: INSTALLATION_ID, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "ffffffffffffffffffffffffffffffffffffffff";
const PUB_ID = "22222222-3333-4444-5555-666666666666";
const ASSOC_ID = "33333333-4444-5555-6666-777777777777";
const FINDING_ROW_ID = "44444444-5555-6666-7777-888888888888";
const THREAD_GQL_ID = "PRRT_node_1";
const ROOT_COMMENT_ID = 9001;
const PATH = "src/auth.ts";
const LINE = 21;
const uuid = (n: number): string => `${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// Fixture: seeded D1 (app + installation + confirmed publication + addressed
// finding + pending association) and the §7.5 intent/body built from them.
// ---------------------------------------------------------------------------

function createSeededTestD1(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, SLUG, GITHUB_APP_ID, SLUG);
  db.raw
    .prepare(`INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES (?, ?, ?, 'acme', datetime('now'))`)
    .run(uuid(1), APP_ID, INSTALLATION_ID);
  return db;
}

async function seedLifecycle(db: TestD1): Promise<LineIntent> {
  const body = `**Null deref risk** · 🟠 should-fix\n\nThe expiry comparison can dereference a null claims object.`;
  const intent = await buildLineIntent({
    findingRowId: FINDING_ROW_ID,
    publicationId: PUB_ID,
    associationId: ASSOC_ID,
    scope: SCOPE,
    originalSha: SHA,
    round: 1,
    path: PATH,
    line: LINE,
    body,
  });
  // Confirmed original primary publication carrying the intent (T1 journal).
  const payload: PublicationPayload = {
    version: 1,
    scope: SCOPE,
    headSha: SHA,
    kind: "review",
    round: 1,
    targetCommentId: null,
    body: "overall body",
    bodySha256: await sha256Hex("overall body"),
    artifact: null,
    lifecycle: null,
    lineIntents: [intent],
  };
  await stagePublication(db, { id: PUB_ID, payload, nowMs: 1000 });
  const lease = await claimPublication(db, PUB_ID, "fixture", 2000);
  if (lease === null) throw new Error("fixture: publication claim failed");
  const proven = await recordPublicationProof(db, PUB_ID, lease, {
    publicationId: PUB_ID,
    scope: SCOPE,
    headSha: SHA,
    kind: "review",
    round: 1,
    commentId: 555,
    bodySha256: payload.bodySha256,
    confirmedMs: 3000,
  });
  if (!proven) throw new Error("fixture: publication proof failed");
  // Addressed finding row owned by THIS publication.
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 1, 1, 'addressed', 1000, 1000)`,
    )
    .run(FINDING_ROW_ID, APP_ID, INSTALLATION_ID, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, "fp-1", PUB_ID, PUB_ID, SHA, SHA);
  // Pending association row with the stored intent AND the discovered remote
  // ids (resolve consumes the persisted §7.5 mapping — discovery ran when the
  // publication response was captured).
  db.raw
    .prepare(
      `INSERT INTO review_threads
         (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
          original_sha, round, intent_json, review_id, comment_id, thread_id, resolution_state, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 555, ?, ?, 'pending', 1000, 1000)`,
    )
    .run(ASSOC_ID, FINDING_ROW_ID, PUB_ID, APP_ID, INSTALLATION_ID, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, JSON.stringify(intent), ROOT_COMMENT_ID, THREAD_GQL_ID);
  return intent;
}

// --- GraphQL transport double -------------------------------------------------

type ThreadCommentSpec = {
  id: string;
  fullDatabaseId: string;
  body: string;
  authorType?: string | null;
  authorLogin?: string | null;
  createdAt: string;
  updatedAt: string;
};

type GraphqlCall = { kind: string; variables: Record<string, unknown> };

type GraphqlRoutes = {
  /** Thread node pages, in call order (before=undefined first). */
  threadPages?: Array<{ comments: ThreadCommentSpec[]; hasPreviousPage?: boolean; isResolved?: boolean; isOutdated?: boolean; headRefOid?: string }>;
  issueComments?: { comments: ThreadCommentSpec[]; totalCount?: number; hasPreviousPage?: boolean; headRefOid?: string };
  reviewThreadsPages?: Array<{ threads: unknown[]; hasNextPage?: boolean }>;
  reviews?: unknown[];
  /** Thrown instead of returned for the given kind. */
  throwOn?: string;
};

function fakeOctokit(routes: GraphqlRoutes): { octokit: GraphqlOctokit; calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  const octokit = {
    graphql: async <T,>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const kind = query.includes("resolveReviewThread")
        ? "mutation"
        : query.includes("reviewThreads(first: 100")
          ? "reviewThreads"
          : query.includes("reviews(last: 50)")
            ? "reviews"
            : query.includes("node(id: $id)")
              ? "thread"
              : "issue";
      calls.push({ kind, variables: { ...variables } });
      if (routes.throwOn === kind) throw new Error(`graphql ${kind} unavailable`);
      if (kind === "mutation") {
        const threadId = (variables.input as { threadId: string }).threadId;
        return { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } as T;
      }
      if (kind === "thread") {
        const pageIndex = typeof variables.before === "string" ? 1 : 0;
        const page = routes.threadPages?.[pageIndex];
        if (page === undefined) return { node: null } as T;
        return {
          node: {
            id: THREAD_GQL_ID,
            isResolved: page.isResolved ?? false,
            isOutdated: page.isOutdated ?? false,
            path: PATH,
            line: LINE,
            originalLine: null,
            pullRequest: { id: "PR_node", number: SCOPE.prNumber, headRefOid: page.headRefOid ?? SHA, repository: { nameWithOwner: `${SCOPE.owner}/${SCOPE.repo}` } },
            comments: {
              totalCount: page.comments.length,
              pageInfo: { hasPreviousPage: page.hasPreviousPage ?? false, startCursor: "cursor-older" },
              nodes: page.comments.map((c) => ({
                id: c.id,
                fullDatabaseId: c.fullDatabaseId,
                body: c.body,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                author: { __typename: c.authorType ?? "Bot", login: c.authorLogin ?? BOT_LOGIN },
                originalCommit: { oid: SHA },
                pullRequestReview: { id: "PRR_node_1" },
              })),
            },
          },
        } as T;
      }
      if (kind === "issue") {
        const issue = routes.issueComments;
        if (issue === undefined) throw new Error("fixture: unexpected issue query");
        return {
          repository: {
            pullRequest: {
              headRefOid: issue.headRefOid ?? SHA,
              comments: {
                totalCount: issue.totalCount ?? issue.comments.length,
                pageInfo: { hasPreviousPage: issue.hasPreviousPage ?? false, startCursor: "cursor-older" },
                nodes: issue.comments.map((c) => ({
                  id: c.id,
                  fullDatabaseId: c.fullDatabaseId,
                  body: c.body,
                  createdAt: c.createdAt,
                  updatedAt: c.updatedAt,
                  author: { __typename: c.authorType ?? "User", login: c.authorLogin ?? "human-reviewer" },
                })),
              },
            },
          },
        } as T;
      }
      if (kind === "reviewThreads") {
        const pageIndex = typeof variables.after === "string" ? 1 : 0;
        const page = routes.reviewThreadsPages?.[pageIndex];
        if (page === undefined) return { repository: { pullRequest: { headRefOid: SHA, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } as T;
        return { repository: { pullRequest: { headRefOid: SHA, reviewThreads: { totalCount: page.threads.length, pageInfo: { hasNextPage: page.hasNextPage ?? false, endCursor: "next" }, nodes: page.threads } } } } as T;
      }
      // reviews
      return { repository: { pullRequest: { reviews: { nodes: routes.reviews ?? [] } } } } as T;
    },
  };
  return { octokit, calls };
}

/** A batch review stub carrying OUR line-batch marker, bot-authored, at SHA. */
function batchReview(publicationId: string, overrides: Partial<{ fullDatabaseId: string; body: string; authorLogin: string | null; authorType: string | null; commitOid: string | null }> = {}) {
  return {
    id: "PRR_node_1",
    fullDatabaseId: overrides.fullDatabaseId ?? "555",
    body: overrides.body ?? buildLineBatchMarker(publicationId),
    author: { __typename: overrides.authorType ?? "Bot", login: overrides.authorLogin ?? BOT_LOGIN },
    commit: { oid: overrides.commitOid ?? SHA },
  };
}

/** A discovery thread stub: root carries OUR thread marker + digest-matched body. */
function discoveryThread(intent: LineIntent, overrides: Partial<{ threadId: string; rootBody: string; authorLogin: string | null; authorType: string | null; path: string; line: number | null; rootReviewRestId: string | null }> = {}) {
  const rootBody = overrides.rootBody ?? buildLineCommentBody(intent);
  return {
    id: overrides.threadId ?? THREAD_GQL_ID,
    isResolved: false,
    isOutdated: false,
    path: overrides.path ?? PATH,
    line: overrides.line ?? LINE,
    comments: {
      nodes: [
        {
          id: "PRRC_node_1",
          fullDatabaseId: String(ROOT_COMMENT_ID),
          body: rootBody,
          author: { __typename: overrides.authorType ?? "Bot", login: overrides.authorLogin ?? BOT_LOGIN },
          pullRequestReview: { id: "PRR_node_1", fullDatabaseId: overrides.rootReviewRestId ?? "555" },
        },
      ],
    },
  };
}

type Deps = Parameters<typeof createReviewThreads>[0];

function makeDeps(db: TestD1, octokit: unknown, overrides: Partial<Deps> = {}): Deps {
  let now = 10_000;
  return {
    db,
    nowMs: () => (now += 1),
    getAppIdentity: async () => ({ githubAppId: GITHUB_APP_ID, slug: SLUG }),
    getOctokit: async () => octokit as Awaited<ReturnType<Deps["getOctokit"]>>,
    ...overrides,
  };
}

function makeVerified(intent: LineIntent, comments: ThreadCommentSpec[], issue: ThreadCommentSpec[], headSha = SHA): Promise<VerifiedResolution> {
  return (async () => {
    // Digest inputs mirror EXACTLY what the fake GraphQL transport serves:
    // entry id = the GraphQL node id, fullDatabaseId = the REST id string.
    const entries = (specs: ThreadCommentSpec[], authorType: string, authorLogin: string) =>
      specs.map((c) => ({
        id: c.id,
        fullDatabaseId: c.fullDatabaseId,
        authorType: c.authorType ?? authorType,
        authorLogin: c.authorLogin ?? authorLogin,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        body: c.body,
      }));
    const digest = await threadDigestOf({
      threadId: THREAD_GQL_ID,
      rootCommentId: String(ROOT_COMMENT_ID),
      headSha,
      comments: entries(comments, "Bot", BOT_LOGIN),
    });
    return {
      assessment: { rowId: FINDING_ROW_ID, disposition: "addressed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
      snapshot: {
        associationId: ASSOC_ID,
        threadId: THREAD_GQL_ID,
        commentId: ROOT_COMMENT_ID,
        headSha,
        digest,
        commentCount: comments.length,
        capturedMs: 5000,
        coverage: "complete",
        modelCoverage: "complete",
      },
      issueDigest: await issueDigestOf({ headSha, comments: entries(issue, "User", "human-reviewer") }),
      issueCoverage: "complete",
    } satisfies VerifiedResolution;
  })();
}

// ---------------------------------------------------------------------------
// Opaque marker wire (spec §7.5)
// ---------------------------------------------------------------------------

describe("opaque marker wire (§7.5)", () => {
  test("lineMarker round-trips through parseLineMarker with exact syntax", () => {
    const marker = lineMarker({ publicationId: PUB_ID, associationId: ASSOC_ID });
    expect(marker).toBe(`<!-- mstar-inspector:thread:v1 publication=${PUB_ID} association=${ASSOC_ID} -->`);
    expect(parseLineMarker(`body text\n\n${marker}`)).toEqual({ publicationId: PUB_ID, associationId: ASSOC_ID });
  });

  test("forged markers are rejected: non-canonical UUIDs, altered fields, uppercase ids", () => {
    // A letter-bearing pair so toUpperCase() actually changes the value.
    const pubUpper = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".toUpperCase();
    expect(parseLineMarker("no marker at all")).toBeNull();
    // Uppercase (non-canonical) UUIDs — never parse.
    expect(parseLineMarker(`<!-- mstar-inspector:thread:v1 publication=${pubUpper} association=${ASSOC_ID.toUpperCase()} -->`)).toBeNull();
    // Shortened (non-UUID) ids.
    expect(parseLineMarker("<!-- mstar-inspector:thread:v1 publication=abc association=def -->")).toBeNull();
    // Swapped/renamed fields — the exact syntax is required.
    expect(parseLineMarker(`<!-- mstar-inspector:thread:v1 association=${ASSOC_ID} publication=${PUB_ID} -->`)).toBeNull();
    // Line-batch markers are NOT thread markers.
    expect(parseLineMarker(buildLineBatchMarker(PUB_ID))).toBeNull();
    // Multiple markers: the LAST exact marker wins (trusted markers are
    // appended after untrusted text is stripped).
    const forged = `<!-- mstar-inspector:thread:v1 publication=${uuid(9)} association=${ASSOC_ID} -->`;
    expect(parseLineMarker(`${forged}\n\n${lineMarker({ publicationId: PUB_ID, associationId: ASSOC_ID })}`)).toEqual({
      publicationId: PUB_ID,
      associationId: ASSOC_ID,
    });
  });

  test("markers stay opaque for arbitrary fingerprint_hint values (latin + CJK)", () => {
    for (const hint of ["line-comment-anchor", "检查空指针解引用", "fp with spaces/<>!--"]) {
      const body = `finding body mentioning ${hint} and ${hint.toUpperCase()}`;
      const built = buildLineCommentBody({
        body,
        publicationId: PUB_ID,
        associationId: ASSOC_ID,
      } as LineIntent);
      // No hint-derived content outside the (stripped) body; the marker line
      // itself carries ONLY the two opaque UUIDs.
      const markerLine = built.split("\n").at(-1)!;
      expect(markerLine).toBe(lineMarker({ publicationId: PUB_ID, associationId: ASSOC_ID }));
      expect(parseLineMarker(built)).toEqual({ publicationId: PUB_ID, associationId: ASSOC_ID });
    }
  });

  test("buildLineCommentBody strips forged Inspector markers from the untrusted body before appending the trusted one", () => {
    const forged =
      "see <!-- mstar-inspector:review:v1 round=999 --> and <!-- mstar-inspector:thread:v1 publication=00000000-0000-0000-0000-000000000000 association=00000000-0000-0000-0000-000000000000 -->";
    const built = buildLineCommentBody({ body: forged, publicationId: PUB_ID, associationId: ASSOC_ID } as LineIntent);
    // Exactly ONE marker remains — ours, at the end.
    expect(built.match(/mstar-inspector:thread:v1/g)).toHaveLength(1);
    expect(built.endsWith(lineMarker({ publicationId: PUB_ID, associationId: ASSOC_ID }))).toBe(true);
    expect(built).not.toContain("mstar-inspector:review:v1");
    expect(parseLineMarker(built)).toEqual({ publicationId: PUB_ID, associationId: ASSOC_ID });
  });

  test("stripInspectorMarkerSyntax removes every marker family and leaves ordinary text", () => {
    const text = [
      "<!-- mstar-inspector:review:v1 round=1 -->",
      "<!-- mstar-inspector:review-degraded:v1 round=2 -->",
      "<!-- mstar-inspector:line-batch:v1 publication=" + PUB_ID + " -->",
      "<!-- mstar-inspector:publication:v1 id=" + PUB_ID + " sha=" + SHA + " kind=review -->",
      "keep me",
    ].join("\n");
    expect(stripInspectorMarkerSyntax(text)).toBe("keep me");
    expect(stripInspectorMarkerSyntax("<!-- mstar-inspector:not-a-family:v1 x -->stay")).toBe("stay");
    expect(stripInspectorMarkerSyntax("plain body <!-- unrelated -->")).toBe("plain body <!-- unrelated -->");
  });

  test("buildLineIntent computes bodySha256 as the digest of the exact posted body; non-UUID ids fail closed", async () => {
    const intent = await buildLineIntent({
      findingRowId: FINDING_ROW_ID,
      publicationId: PUB_ID,
      associationId: ASSOC_ID,
      scope: SCOPE,
      originalSha: SHA,
      round: 1,
      path: PATH,
      line: LINE,
      body: "body",
    });
    expect(intent.bodySha256).toBe(await sha256Hex(buildLineCommentBody(intent)));
    expect(intent.scope).toEqual(SCOPE);
    // A non-opaque (hint-like) association id can never become a marker.
    await expect(
      buildLineIntent({
        findingRowId: FINDING_ROW_ID,
        publicationId: PUB_ID,
        associationId: "line-comment-anchor",
        scope: SCOPE,
        originalSha: SHA,
        round: 1,
        path: PATH,
        line: LINE,
        body: "body",
      }),
    ).rejects.toThrow(/canonical lowercase UUID/);
    await expect(buildLineIntent({
      findingRowId: FINDING_ROW_ID,
      publicationId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      associationId: ASSOC_ID,
      scope: SCOPE,
      originalSha: SHA,
      round: 1,
      path: PATH,
      line: LINE,
      body: "body",
    })).rejects.toThrow(/canonical lowercase UUID/);
  });

  test("line-batch marker round-trips; thread markers never satisfy it", () => {
    const marker = buildLineBatchMarker(PUB_ID);
    expect(marker).toBe(`<!-- mstar-inspector:line-batch:v1 publication=${PUB_ID} -->`);
    expect(parseLineBatchMarker(`mstar-inspector line comments\n\n${marker}`)).toEqual({ publicationId: PUB_ID });
    expect(parseLineBatchMarker(lineMarker({ publicationId: PUB_ID, associationId: ASSOC_ID }))).toBeNull();
    expect(parseLineBatchMarker("<!-- mstar-inspector:line-batch:v1 publication=xyz -->")).toBeNull();
    expect(() => buildLineBatchMarker("not-a-uuid")).toThrow(/canonical lowercase UUID/);
  });
});

// ---------------------------------------------------------------------------
// Discovery (§7.5 "Discovery/adoption")
// ---------------------------------------------------------------------------

describe("discoverThread — ownership proof precedes adoption", () => {
  test("happy path (reviewId known): unique complete match → found + ids persisted on the row", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const rootBody = buildLineCommentBody(intent);
    const { octokit, calls } = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent)], hasNextPage: false }],
    });
    const ops = createReviewThreads(makeDeps(db, octokit));
    const result = await ops.discoverThread({ scope: SCOPE, intent, reviewId: 555 });
    expect(result).toEqual({ kind: "found", reviewId: 555, commentId: ROOT_COMMENT_ID, threadId: THREAD_GQL_ID });
    // Ids persisted under the association lease before resolving.
    const row = db.raw.query(`SELECT review_id, comment_id, thread_id, holder FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as {
      review_id: number; comment_id: number; thread_id: string; holder: string | null;
    };
    expect(row).toEqual({ review_id: 555, comment_id: ROOT_COMMENT_ID, thread_id: THREAD_GQL_ID, holder: null });
    // The digest gate actually compared the remote root body.
    expect(await sha256Hex(rootBody)).toBe(intent.bodySha256);
    expect(calls.some((c) => c.kind === "reviews")).toBe(true);
    expect(calls.some((c) => c.kind === "reviewThreads")).toBe(true);
  });

  test("a copied marker at ANOTHER review is foreign (known reviewId must match exactly)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const { octokit } = fakeOctokit({
      reviews: [batchReview(PUB_ID, { fullDatabaseId: "999" })],
      reviewThreadsPages: [{ threads: [discoveryThread(intent)], hasNextPage: false }],
    });
    const ops = createReviewThreads(makeDeps(db, octokit));
    expect(await ops.discoverThread({ scope: SCOPE, intent, reviewId: 555 })).toEqual({ kind: "foreign" });
  });

  test("a known reviewId whose body does NOT carry our line-batch marker is foreign (marker check is unconditional)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const { octokit, calls } = fakeOctokit({
      reviews: [batchReview(PUB_ID, { body: "an edited/replaced review body without our batch marker" })],
      reviewThreadsPages: [{ threads: [discoveryThread(intent)], hasNextPage: false }],
    });
    const ops = createReviewThreads(makeDeps(db, octokit));
    expect(await ops.discoverThread({ scope: SCOPE, intent, reviewId: 555 })).toEqual({ kind: "foreign" });
    // Rejected before the thread scan — the batch gate precedes adoption.
    expect(calls.some((c) => c.kind === "reviewThreads")).toBe(false);
  });

  test("a copied marker on a human account / with a different body is foreign, never authority", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    // Human-planted marker with the exact marker text.
    const human = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent, { authorType: "User", authorLogin: "impostor" })], hasNextPage: false }],
    });
    expect(
      await createReviewThreads(makeDeps(db, human.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "foreign" });

    // Right marker, wrong body (another round's text) — digest gate.
    const altered = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent, { rootBody: buildLineCommentBody(intent) + "\nedited" })], hasNextPage: false }],
    });
    expect(
      await createReviewThreads(makeDeps(db, altered.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "foreign" });

    // Generic Bot authorship with the WRONG login — identity gate.
    const otherBot = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent, { authorLogin: "other-app[bot]" })], hasNextPage: false }],
    });
    expect(
      await createReviewThreads(makeDeps(db, otherBot.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "foreign" });
  });

  test("no batch-marker review → unknown; TWO batch-marker reviews → ambiguous (response-loss path)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const none = fakeOctokit({ reviews: [], reviewThreadsPages: [{ threads: [discoveryThread(intent)], hasNextPage: false }] });
    expect(
      await createReviewThreads(makeDeps(db, none.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "unknown" });

    const two = fakeOctokit({
      reviews: [batchReview(PUB_ID), batchReview(PUB_ID, { fullDatabaseId: "556" })],
      reviewThreadsPages: [{ threads: [discoveryThread(intent)], hasNextPage: false }],
    });
    expect(
      await createReviewThreads(makeDeps(db, two.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "ambiguous" });
  });

  test("two threads claiming the same association → ambiguous; zero threads → unknown", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const dup = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent), discoveryThread(intent, { threadId: "PRRT_node_2" })], hasNextPage: false }],
    });
    expect(
      await createReviewThreads(makeDeps(db, dup.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "ambiguous" });

    const empty = fakeOctokit({ reviews: [batchReview(PUB_ID)], reviewThreadsPages: [{ threads: [], hasNextPage: false }] });
    expect(
      await createReviewThreads(makeDeps(db, empty.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "unknown" });
  });

  test("scope mismatch / unknown association rejected BEFORE any API call", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const { octokit, calls } = fakeOctokit({ reviews: [] });
    const ops = createReviewThreads(makeDeps(db, octokit));
    const otherScope: Scope = { ...SCOPE, prNumber: 43 };
    expect(await ops.discoverThread({ scope: otherScope, intent, reviewId: null })).toEqual({ kind: "unknown" });
    expect(await ops.discoverThread({ scope: SCOPE, intent: { ...intent, associationId: uuid(77) }, reviewId: null })).toEqual({ kind: "unknown" });
    expect(calls).toEqual([]); // zero GraphQL traffic
  });

  test("identity-unavailable and slug-vs-live-App disagreement fail closed (unknown)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const { octokit, calls } = fakeOctokit({ reviews: [batchReview(PUB_ID)] });
    const base = makeDeps(db, octokit);
    expect(
      await createReviewThreads({ ...base, getAppIdentity: async () => null }).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "unknown" });
    // GET /app returns a DIFFERENT numeric App id than the routed row.
    expect(
      await createReviewThreads({ ...base, getAppIdentity: async () => ({ githubAppId: 9999, slug: SLUG }) }).discoverThread({
        scope: SCOPE,
        intent,
        reviewId: null,
      }),
    ).toEqual({ kind: "unknown" });
    expect(calls.every((c) => c.kind !== "reviews")).toBe(true); // no review scan past the identity gate
  });

  test("discovery read-path transport failures are TYPED unknown (reviews scan, thread scan, mint)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const failingReviews = fakeOctokit({ throwOn: "reviews" });
    expect(
      await createReviewThreads(makeDeps(db, failingReviews.octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "unknown" });

    const db2 = createSeededTestD1();
    const intent2 = await seedLifecycle(db2);
    const failingThreads = fakeOctokit({ reviews: [batchReview(PUB_ID)], throwOn: "reviewThreads" });
    expect(
      await createReviewThreads(makeDeps(db2, failingThreads.octokit)).discoverThread({ scope: SCOPE, intent: intent2, reviewId: null }),
    ).toEqual({ kind: "unknown" });

    // A mint outage inside resolveAppContext fails closed to the typed
    // outcome instead of throwing out of the adapter.
    const db3 = createSeededTestD1();
    const intent3 = await seedLifecycle(db3);
    const base = makeDeps(db3, fakeOctokit({ reviews: [batchReview(PUB_ID)] }).octokit);
    expect(
      await createReviewThreads({
        ...base,
        getOctokit: async () => {
          throw new Error("mint outage");
        },
      }).discoverThread({ scope: SCOPE, intent: intent3, reviewId: null }),
    ).toEqual({ kind: "unknown" });
  });

  test("incomplete reviewThreads pagination (5-page bound) is unknown, never authority", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const { octokit } = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [
        { threads: [discoveryThread(intent)], hasNextPage: true },
        { threads: [], hasNextPage: true },
      ],
    });
    const ops = createReviewThreads(makeDeps(db, octokit));
    expect(await ops.discoverThread({ scope: SCOPE, intent, reviewId: null })).toEqual({ kind: "unknown" });
  });

  test("unconfirmed publication → unknown, no API call", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    // Force the publication back to `sending` (not confirmed).
    db.raw.prepare(`UPDATE review_publications SET phase = 'sending' WHERE id = ?`).run(PUB_ID);
    const { octokit, calls } = fakeOctokit({ reviews: [batchReview(PUB_ID)] });
    expect(
      await createReviewThreads(makeDeps(db, octokit)).discoverThread({ scope: SCOPE, intent, reviewId: null }),
    ).toEqual({ kind: "unknown" });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resolution (§7.5 "Resolve order")
// ---------------------------------------------------------------------------

const ROOT: ThreadCommentSpec = {
  id: "c-root",
  fullDatabaseId: String(ROOT_COMMENT_ID),
  body: "placeholder", // replaced per-test with the built body
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
};

const REPLY: ThreadCommentSpec = {
  id: "c-reply",
  fullDatabaseId: "9002",
  body: "a human reply",
  authorType: "User",
  authorLogin: "octocat",
  createdAt: "2026-09-02T10:00:00Z",
  updatedAt: "2026-09-02T10:00:00Z",
};

const ISSUE_A: ThreadCommentSpec = {
  id: "i-1",
  fullDatabaseId: "8001",
  body: "issue comment",
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-01T09:00:00Z",
};

async function resolvedFixture(db: TestD1, intent: LineIntent): Promise<VerifiedResolution> {
  const root = { ...ROOT, body: buildLineCommentBody(intent) };
  return makeVerified(intent, [root, REPLY], [ISSUE_A]);
}

describe("resolveFindingThread — fences, adoption, mutation confirmation", () => {
  test("happy path: owned thread resolves, row stores resolved, mutation got the exact threadId", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
    });
    const ops = createReviewThreads(makeDeps(db, octokit));
    const outcome = await ops.resolveFindingThread({ scope: SCOPE, associationId: ASSOC_ID, verified });
    expect(outcome).toEqual({ kind: "resolved", threadId: THREAD_GQL_ID, adopted: false, outdated: false, lateChange: false });
    const row = db.raw.query(`SELECT resolution_state, resolved_ms, late_change, holder FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as {
      resolution_state: string; resolved_ms: number | null; late_change: number; holder: string | null;
    };
    expect(row.resolution_state).toBe("resolved");
    expect(row.resolved_ms).not.toBeNull();
    expect(row.late_change).toBe(0);
    expect(row.holder).toBeNull();
    const mutation = calls.find((c) => c.kind === "mutation");
    expect(mutation).toBeDefined();
    expect((mutation!.variables.input as { threadId: string }).threadId).toBe(THREAD_GQL_ID);
  });

  test("crash window: remote ids were never bound → resolve DISCOVERS them from the stored intent, then resolves (P67-QC-004)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    // The enqueue persists verified_json BEFORE discovery, so the crash window
    // leaves exactly this shape: a verified snapshot with NO remote ids.
    db.raw
      .prepare(`UPDATE review_threads SET review_id = NULL, comment_id = NULL, thread_id = NULL WHERE id = ?`)
      .run(ASSOC_ID);
    const { octokit, calls } = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent)] }],
      threadPages: [{ comments: [root, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
    });

    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });

    // The unbound association completes instead of dying as
    // `lookup-incomplete` — the crash window is genuinely recoverable.
    expect(outcome).toEqual({
      kind: "resolved",
      threadId: THREAD_GQL_ID,
      adopted: false,
      outdated: false,
      lateChange: false,
    });
    const row = db.raw
      .query(`SELECT resolution_state, review_id, comment_id, thread_id FROM review_threads WHERE id = ?`)
      .get(ASSOC_ID) as { resolution_state: string; review_id: number | null; comment_id: number | null; thread_id: string | null };
    expect(row.resolution_state).toBe("resolved");
    // Discovery BOUND the ids (they were null before this call).
    expect(row.review_id).toBe(555);
    expect(row.comment_id).toBe(ROOT_COMMENT_ID);
    expect(row.thread_id).toBe(THREAD_GQL_ID);
    expect(calls.some((c) => c.kind === "mutation")).toBe(true);
  });

  test("crash window with unprovable ownership: retry + durable error, never a terminal abandon (P67-QC-004)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    db.raw
      .prepare(`UPDATE review_threads SET review_id = NULL, comment_id = NULL, thread_id = NULL WHERE id = ?`)
      .run(ASSOC_ID);
    // The consumer enqueues the verified snapshot BEFORE discovery (the crash
    // window §7.11.1 protects), so the row owns a snapshot while unbound.
    db.raw
      .prepare(`UPDATE review_threads SET verified_json = ? WHERE id = ?`)
      .run(JSON.stringify(verified), ASSOC_ID);
    // No batch review at all → discovery cannot prove ownership.
    const { octokit, calls } = fakeOctokit({
      reviews: [],
      reviewThreadsPages: [],
      issueComments: { comments: [ISSUE_A] },
    });

    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });

    expect(outcome).toEqual({ kind: "retry", reason: "lookup-incomplete" });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
    const row = db.raw
      .query(`SELECT resolution_state, holder, verified_json FROM review_threads WHERE id = ?`)
      .get(ASSOC_ID) as { resolution_state: string; holder: string | null; verified_json: string | null };
    // Retryable, lease-free, snapshot retained — M8 keeps owning it.
    expect(row.resolution_state).toBe("retry");
    expect(row.holder).toBeNull();
    expect(row.verified_json).not.toBeNull();
  });

  test("discovery does NOT spend the resolution attempt budget (P67-QC-005)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const { octokit } = fakeOctokit({
      reviews: [batchReview(PUB_ID)],
      reviewThreadsPages: [{ threads: [discoveryThread(intent)] }],
      threadPages: [{ comments: [root] }],
      issueComments: { comments: [ISSUE_A] },
    });
    const ops = createReviewThreads(makeDeps(db, octokit));

    const attemptsOf = (): number => {
      const row = db.raw.query(`SELECT attempts FROM review_threads WHERE id = ?`).get(ASSOC_ID) as { attempts: number };
      return row.attempts;
    };
    expect(attemptsOf()).toBe(0);

    await ops.discoverThread({ scope: SCOPE, intent, reviewId: null });
    // Binding remote ids is bookkeeping: the resolve budget is untouched.
    expect(attemptsOf()).toBe(0);

    await ops.discoverThread({ scope: SCOPE, intent, reviewId: null });
    expect(attemptsOf()).toBe(0);
  });

  test("HEAD changed after verification → needs-recheck head-changed, no mutation", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY], headRefOid: SHA2 }],
      issueComments: { comments: [ISSUE_A], headRefOid: SHA2 },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "needs-recheck", reason: "head-changed" });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
    // The lease is released on the fence; the row stays pending (retryable).
    const row = db.raw.query(`SELECT resolution_state, holder FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as { resolution_state: string; holder: string | null };
    expect(row.resolution_state).toBe("pending");
    expect(row.holder).toBeNull();
  });

  test("conversation changed (new reply) → needs-recheck conversation-changed; digest is never refreshed", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const newerReply: ThreadCommentSpec = { ...REPLY, id: "c-reply-2", fullDatabaseId: "9003", createdAt: "2026-09-03T10:00:00Z" };
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY, newerReply] }],
      issueComments: { comments: [ISSUE_A] },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "needs-recheck", reason: "conversation-changed" });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
  });

  test("conversation incomplete (older page remains after the 2-page bound) blocks resolution", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const { octokit, calls } = fakeOctokit({
      threadPages: [
        { comments: [root, REPLY], hasPreviousPage: true },
        { comments: [root], hasPreviousPage: true }, // still an older page after 2 pages
      ],
      issueComments: { comments: [ISSUE_A] },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "needs-recheck", reason: "context-incomplete" });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
  });

  test("concern no longer addressed by THIS publication → needs-recheck concern-unresolved", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    db.raw.prepare(`UPDATE review_findings SET state = 'open' WHERE id = ?`).run(FINDING_ROW_ID);
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [{ ...ROOT, body: buildLineCommentBody(intent) }, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "needs-recheck", reason: "concern-unresolved" });
    expect(calls).toEqual([]); // fails before any API call
  });

  test("unverifiable verified assessment never authorizes a resolve", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = {
      ...(await resolvedFixture(db, intent)),
      assessment: { rowId: FINDING_ROW_ID, disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
    } satisfies VerifiedResolution;
    const { octokit, calls } = fakeOctokit({});
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "needs-recheck", reason: "concern-unresolved" });
    expect(calls).toEqual([]);
  });

  test("incomplete recorded coverage (truncated capture) blocks resolution", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = {
      ...(await resolvedFixture(db, intent)),
      issueCoverage: "truncated",
    } satisfies VerifiedResolution;
    const { octokit, calls } = fakeOctokit({});
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "needs-recheck", reason: "context-incomplete" });
    expect(calls).toEqual([]);
  });

  test("OUTDATED owned thread still resolves (isOutdated is recorded, not a veto)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY], isOutdated: true }],
      issueComments: { comments: [ISSUE_A] },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "resolved", threadId: THREAD_GQL_ID, adopted: false, outdated: true, lateChange: false });
    expect(calls.some((c) => c.kind === "mutation")).toBe(true);
  });

  test("already-resolved owned thread is ADOPTED (no mutation, provenance re-proven first)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY], isResolved: true }],
      issueComments: { comments: [ISSUE_A] },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "resolved", threadId: THREAD_GQL_ID, adopted: true, outdated: false, lateChange: false });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
    const row = db.raw.query(`SELECT resolution_state FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as { resolution_state: string };
    expect(row.resolution_state).toBe("resolved");
  });

  test("mutation not confirmed (isResolved false / wrong id / API error) → retry, never a false resolved claim", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };

    // isResolved false in the mutation response.
    const unconfirmed = fakeOctokit({
      threadPages: [{ comments: [root, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
    });
    unconfirmed.octokit.graphql = ((query: string, variables: Record<string, unknown>) => {
      if (query.includes("resolveReviewThread")) {
        return Promise.resolve({ resolveReviewThread: { thread: { id: THREAD_GQL_ID, isResolved: false } } });
      }
      return fakeOctokit({
        threadPages: [{ comments: [root, REPLY] }],
        issueComments: { comments: [ISSUE_A] },
      }).octokit.graphql(query, variables);
    }) as typeof unconfirmed.octokit.graphql;
    const outcome1 = await createReviewThreads(makeDeps(db, unconfirmed.octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome1).toEqual({ kind: "retry", reason: "api" });
    const row1 = db.raw.query(`SELECT resolution_state, last_error FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as { resolution_state: string; last_error: string | null };
    expect(row1.resolution_state).toBe("retry");
    expect(row1.last_error).toContain("not confirmed");

    // Mutation transport error.
    const db2 = createSeededTestD1();
    await seedLifecycle(db2);
    const failing = fakeOctokit({
      threadPages: [{ comments: [root, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
      throwOn: "mutation",
    });
    const outcome2 = await createReviewThreads(makeDeps(db2, failing.octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome2).toEqual({ kind: "retry", reason: "api" });
    expect(
      (db2.raw.query(`SELECT resolution_state FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as { resolution_state: string }).resolution_state,
    ).toBe("retry");
  });

  test("slug-vs-live-App identity disagreement fails closed (retry, no mutation)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const { octokit, calls } = fakeOctokit({ threadPages: [{ comments: [] }] });
    const base = makeDeps(db, octokit);
    const outcome = await createReviewThreads({ ...base, getAppIdentity: async () => ({ githubAppId: 4711, slug: "spoofed" }) }).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "retry", reason: "api" });
    expect(calls).toEqual([]);
  });

  test("superseded association is abandoned (never resolved through the old mapping)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    db.raw.prepare(`UPDATE review_threads SET superseded_by_publication_id = ? WHERE id = ?`).run(uuid(9), ASSOC_ID);
    const { octokit, calls } = fakeOctokit({});
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "abandoned", reason: "superseded" });
    expect(calls).toEqual([]);
  });

  test("foreign root (author is not the authenticated bot) → abandoned identity-mismatch", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent), authorLogin: "someone-else[bot]" };
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "abandoned", reason: "identity-mismatch" });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
  });

  test("a live lease held by another claimant → retry without stealing the lease", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    db.raw
      .prepare(`UPDATE review_threads SET holder = 'other', lease_epoch = 4, lease_until_ms = ? WHERE id = ?`)
      .run(Date.now() + 60_000, ASSOC_ID);
    const { octokit, calls } = fakeOctokit({});
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "retry", reason: "api" });
    expect(calls).toEqual([]);
    const row = db.raw.query(`SELECT holder, lease_epoch FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as { holder: string; lease_epoch: number };
    expect(row.holder).toBe("other"); // untouched
    expect(row.lease_epoch).toBe(4);
  });

  test("thread capture transport failure → typed retry:api with the lease released (never an escaping throw)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [{ ...ROOT, body: buildLineCommentBody(intent) }, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
      throwOn: "thread",
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "retry", reason: "api" });
    const row = db.raw.query(`SELECT resolution_state, holder FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as {
      resolution_state: string; holder: string | null;
    };
    expect(row.resolution_state).toBe("retry");
    expect(row.holder).toBeNull(); // released through persistOutcome, not held until expiry
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
  });

  test("issue capture transport failure → typed retry:api (a thrown read is never a false fence verdict)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [{ ...ROOT, body: buildLineCommentBody(intent) }, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
      throwOn: "issue",
    });
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "retry", reason: "api" });
    expect(calls.some((c) => c.kind === "mutation")).toBe(false);
  });

  test("re-entry on an already-RESOLVED row is a typed terminal no-op (no lease steal, zero API calls)", async () => {
    const db = createSeededTestD1();
    await seedLifecycle(db);
    db.raw
      .prepare(`UPDATE review_threads SET resolution_state = 'resolved', resolved_ms = 9000, thread_id = ? WHERE id = ?`)
      .run(THREAD_GQL_ID, ASSOC_ID);
    const { octokit, calls } = fakeOctokit({});
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified: {
        assessment: { rowId: FINDING_ROW_ID, disposition: "addressed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
        snapshot: {
          associationId: ASSOC_ID, threadId: THREAD_GQL_ID, commentId: ROOT_COMMENT_ID,
          headSha: SHA, digest: "irrelevant", commentCount: 2, capturedMs: 5000,
          coverage: "complete", modelCoverage: "complete",
        },
        issueDigest: "irrelevant", issueCoverage: "complete",
      },
    });
    expect(outcome).toEqual({ kind: "resolved", threadId: THREAD_GQL_ID, adopted: true, outdated: false, lateChange: false });
    expect(calls).toEqual([]); // settled row — no remote reads, no mutation, no retry loop
  });

  test("re-entry on an already-ABANDONED row is a typed terminal no-op (supersession recoverable from the column)", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const { octokit, calls } = fakeOctokit({});

    // Non-superseded abandon (e.g. a provenance failure) → terminal foreign.
    db.raw.prepare(`UPDATE review_threads SET resolution_state = 'abandoned' WHERE id = ?`).run(ASSOC_ID);
    expect(
      await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({ scope: SCOPE, associationId: ASSOC_ID, verified }),
    ).toEqual({ kind: "abandoned", reason: "foreign" });

    // Superseded abandon → terminal superseded.
    const db2 = createSeededTestD1();
    await seedLifecycle(db2);
    db2.raw
      .prepare(`UPDATE review_threads SET resolution_state = 'abandoned', superseded_by_publication_id = ? WHERE id = ?`)
      .run(uuid(9), ASSOC_ID);
    expect(
      await createReviewThreads(makeDeps(db2, octokit)).resolveFindingThread({ scope: SCOPE, associationId: ASSOC_ID, verified }),
    ).toEqual({ kind: "abandoned", reason: "superseded" });
    expect(calls).toEqual([]);
  });

  test("post-mutation late change (HEAD moved between mutation and post-read) is recorded, resolution stands", async () => {
    const db = createSeededTestD1();
    const intent = await seedLifecycle(db);
    const verified = await resolvedFixture(db, intent);
    const root = { ...ROOT, body: buildLineCommentBody(intent) };
    let reads = 0;
    const { octokit, calls } = fakeOctokit({
      threadPages: [{ comments: [root, REPLY] }],
      issueComments: { comments: [ISSUE_A] },
    });
    const inner = octokit.graphql;
    octokit.graphql = (async (query: string, variables: Record<string, unknown> = {}) => {
      if (query.includes("node(id: $id)")) {
        reads += 1;
        // The pre-mutation capture makes TWO node reads (newest page +
        // stability recheck) and both see SHA; the POST-mutation re-read
        // (reads 3+) sees SHA2.
        if (reads >= 3) {
          return fakeOctokit({ threadPages: [{ comments: [root, REPLY], headRefOid: SHA2 }] }).octokit.graphql(query, variables);
        }
      }
      return inner(query, variables);
    }) as typeof octokit.graphql;
    const outcome = await createReviewThreads(makeDeps(db, octokit)).resolveFindingThread({
      scope: SCOPE,
      associationId: ASSOC_ID,
      verified,
    });
    expect(outcome).toEqual({ kind: "resolved", threadId: THREAD_GQL_ID, adopted: false, outdated: false, lateChange: true });
    expect(calls.some((c) => c.kind === "mutation")).toBe(true);
    const row = db.raw.query(`SELECT resolution_state, late_change FROM review_threads WHERE id = '${ASSOC_ID}'`).get() as {
      resolution_state: string; late_change: number;
    };
    expect(row.resolution_state).toBe("resolved");
    expect(row.late_change).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Post-pagination stability recheck (spec §7.5 "Re-read the final page/count
// and PR HEAD after pagination; instability marks incomplete" / §7.8 "a
// final newest-page/count recheck") — capture primitives.
// ---------------------------------------------------------------------------

describe("post-pagination stability recheck (§7.5/§7.8)", () => {
  /** A thread-node response for one read: newest page, metadata included. */
  const nodeResponse = (totalCount: number, comments: ThreadCommentSpec[], headRefOid = SHA) => ({
    node: {
      id: THREAD_GQL_ID,
      isResolved: false,
      isOutdated: false,
      path: PATH,
      line: LINE,
      originalLine: null,
      pullRequest: { id: "PR_node", number: SCOPE.prNumber, headRefOid, repository: { nameWithOwner: `${SCOPE.owner}/${SCOPE.repo}` } },
      comments: {
        totalCount,
        pageInfo: { hasPreviousPage: false, startCursor: null },
        nodes: comments.map((c) => ({
          id: c.id,
          fullDatabaseId: c.fullDatabaseId,
          body: c.body,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          author: { __typename: c.authorType ?? "Bot", login: c.authorLogin ?? BOT_LOGIN },
          originalCommit: { oid: SHA },
          pullRequestReview: { id: "PRR_node_1" },
        })),
      },
    },
  });

  /** Responses served in read order; the last one repeats when exceeded. */
  function countingOctokit(responses: unknown[]): { octokit: GraphqlOctokit; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    let i = 0;
    const octokit: GraphqlOctokit = {
      graphql: async <T,>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
        void query;
        calls.push({ ...variables });
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return response as T;
      },
    };
    return { octokit, calls };
  }

  test("single-page thread capture: the first read carries metadata AND the newest page — no redundant page-0 re-fetch", async () => {
    const root = { ...ROOT, body: "root body" };
    const { octokit, calls } = countingOctokit([nodeResponse(2, [root, REPLY]), nodeResponse(2, [root, REPLY])]);
    const capture = await fetchThreadConversation(octokit, THREAD_GQL_ID);
    expect(capture.complete).toBe(true);
    expect(capture.totalCount).toBe(2);
    expect(capture.comments).toHaveLength(2);
    // EXACTLY two node reads: newest page (metadata + comments together) and
    // the stability recheck. The old metadata-then-page-0 double fetch (which
    // discarded the first connection) is gone.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.before).toBeUndefined();
    expect(calls[1]!.before).toBeUndefined();
  });

  test("totalCount drifted between the walk and the recheck → incomplete, never falsely complete", async () => {
    const root = { ...ROOT, body: "root body" };
    // A reply landed after the walk: the recheck's count no longer matches.
    const { octokit } = countingOctokit([nodeResponse(2, [root, REPLY]), nodeResponse(3, [root, REPLY])]);
    const capture = await fetchThreadConversation(octokit, THREAD_GQL_ID);
    expect(capture.complete).toBe(false);
    // The walked set is reported as captured; the recheck only validates.
    expect(capture.totalCount).toBe(2);
    expect(capture.comments).toHaveLength(2);
  });

  test("PR HEAD moved between the walk and the recheck → incomplete", async () => {
    const root = { ...ROOT, body: "root body" };
    const { octokit } = countingOctokit([nodeResponse(2, [root, REPLY], SHA), nodeResponse(2, [root, REPLY], SHA2)]);
    expect((await fetchThreadConversation(octokit, THREAD_GQL_ID)).complete).toBe(false);
  });

  test("thread deleted between the walk and the recheck → incomplete (never complete for a vanished node)", async () => {
    const root = { ...ROOT, body: "root body" };
    const { octokit } = countingOctokit([nodeResponse(2, [root, REPLY]), { node: null }]);
    expect((await fetchThreadConversation(octokit, THREAD_GQL_ID)).complete).toBe(false);
  });

  test("issue-comment capture: stability recheck drift (new comment) → incomplete", async () => {
    const page = (totalCount: number) => ({
      repository: {
        pullRequest: {
          headRefOid: SHA,
          comments: {
            totalCount,
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              { id: "i-1", fullDatabaseId: "8001", body: "issue comment", createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z", author: { __typename: "User", login: "octocat" } },
            ],
          },
        },
      },
    });
    const { octokit, calls } = countingOctokit([page(1), page(2)]);
    const capture = await fetchIssueComments(octokit, { owner: SCOPE.owner, repo: SCOPE.repo, prNumber: SCOPE.prNumber });
    expect(capture.complete).toBe(false);
    expect(capture.totalCount).toBe(1);
    expect(calls).toHaveLength(2); // walk + recheck
  });

  test("stable issue-comment capture stays complete with the recheck in place", async () => {
    const page = (totalCount: number) => ({
      repository: {
        pullRequest: {
          headRefOid: SHA,
          comments: {
            totalCount,
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              { id: "i-1", fullDatabaseId: "8001", body: "issue comment", createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z", author: { __typename: "User", login: "octocat" } },
            ],
          },
        },
      },
    });
    const { octokit } = countingOctokit([page(1), page(1)]);
    const capture = await fetchIssueComments(octokit, { owner: SCOPE.owner, repo: SCOPE.repo, prNumber: SCOPE.prNumber });
    expect(capture.complete).toBe(true);
  });
});
