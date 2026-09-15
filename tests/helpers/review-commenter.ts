/**
 * Shared ReviewCommenter test double — one factory for the
 * consumer-flow test files. The double records every op into a caller-owned
 * array and reads its BEHAVIOR from a caller-owned mutable state object, so
 * tests reset state between cases exactly like the module-level `let` vars
 * they replace. Sandbox-read grants are minimal but compliant
 * (assertSandboxGrant passes); every other behavior is injected per test.
 */
import { mock } from "bun:test";
import type {
  DegradedDeleteOutcome,
  DiscoveryResult,
  InstallationTokenGrant,
  ResolveOutcome,
  ReviewCommenter,
  TokenInput,
  UpsertPlan,
} from "../../src/pipeline/comment";
import type { Discussion } from "../../src/contracts/recheck";
import type { LineIntent } from "../../src/store/finding-lifecycle";
import { PreparedSendRejected } from "../../src/pipeline/comment";

export type CommenterCall = { op: string; args: unknown };

/** Mutable per-test behavior switches (tests mutate this between cases). */
export type FakeCommenterState = {
  token: string;
  tokenError?: Error;
  /** Review-chain pre-staging plan (default: create round 1). */
  plan: UpsertPlan;
  /** Degraded-chain pre-staging plan (default: create round 1). */
  degradedPlan: UpsertPlan;
  /** postPreparedReview throw (send failure). */
  preparedReviewError?: Error;
  /** commentId the prepared review send reports (default 101). */
  preparedReviewCommentId: number;
  /** Target version rejection on the prepared review send. */
  preparedReviewReject?: boolean;
  /** postPreparedDegraded throw (definitive degraded rejection). */
  preparedDegradedError?: Error;
  preparedDegradedResult: { posted: boolean; commentId: number | null };
  deleteDegradedOutcome: DegradedDeleteOutcome;
  deleteDegradedError?: Error;
  lineCommentsError?: Error;
  /** postLineComments result — default: every intent captured, reviewId 55. */
  lineCommentsResult: {
    posted: { associationId: string; commentId: number; path: string; line: number }[];
    ambiguous: string[];
    captured: boolean;
    reviewId: number | null;
  };
  discussion: Discussion;
  discussionError?: Error;
  /** §7.5 discovery result for the resolution step. */
  discoverResult: DiscoveryResult;
  /** §7.5 resolve result for the resolution step. */
  resolveResult: ResolveOutcome;
  resolveError?: Error;
};

export function initialFakeCommenterState(): FakeCommenterState {
  return {
    token: "ghs_installation_token",
    // Optional switches are listed EXPLICITLY as undefined so
    // `Object.assign(state, initialFakeCommenterState())` in a test reset()
    // clears previously-set behaviors (absent keys are never assigned).
    tokenError: undefined,
    plan: { action: "create", round: 1 },
    degradedPlan: { action: "create", round: 1 },
    preparedReviewError: undefined,
    preparedReviewCommentId: 101,
    preparedReviewReject: undefined,
    preparedDegradedError: undefined,
    preparedDegradedResult: { posted: true, commentId: 202 },
    deleteDegradedOutcome: { deleted: 0, skipped: 0, errors: [] },
    deleteDegradedError: undefined,
    lineCommentsError: undefined,
    lineCommentsResult: { posted: [], ambiguous: [], captured: true, reviewId: 55 },
    discussion: { items: [], issueCoverage: "complete", issueDigest: "issue-digest", capturedMs: 0, threads: [] },
    discussionError: undefined,
    discoverResult: { kind: "found", reviewId: 9, commentId: 8, threadId: "PRRT_thread1" },
    resolveResult: { kind: "resolved", threadId: "PRRT_thread1", adopted: false, outdated: false, lateChange: false },
    resolveError: undefined,
  };
}

/**
 * Compliant minimal sandbox-read grant (assertSandboxGrant passes):
 * contents/metadata/pull_requests all returned read, exactly one repository,
 * selection "selected" — the three reads the sandbox path really exercises
 * (clone + `gh pr diff`).
 */
export function fakeSandboxGrant(token: string, input: TokenInput): InstallationTokenGrant {
  return {
    token,
    permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    repositoryNames: [input.scope.repo],
    repositorySelection: "selected",
  };
}

export function createFakeCommenter(state: FakeCommenterState, calls: CommenterCall[]): ReviewCommenter {
  return {
    getInstallationToken: mock(async (input: TokenInput) => {
      calls.push({ op: "token", args: input });
      if (state.tokenError) throw state.tokenError;
      return fakeSandboxGrant(state.token, input);
    }),
    planReviewUpsert: mock(async (input: unknown) => {
      calls.push({ op: "plan", args: input });
      return state.plan;
    }),
    planDegradedUpsert: mock(async (input: unknown) => {
      calls.push({ op: "plan-degraded", args: input });
      return state.degradedPlan;
    }),
    postPreparedReview: mock(async (input: unknown) => {
      calls.push({ op: "post-prepared", args: input });
      if (state.preparedReviewError) throw state.preparedReviewError;
      if (state.preparedReviewReject) throw new PreparedSendRejected("prepared review target no longer shows its expected previous version");
      return { commentId: state.preparedReviewCommentId };
    }),
    postPreparedDegraded: mock(async (input: unknown) => {
      calls.push({ op: "post-prepared-degraded", args: input });
      if (state.preparedDegradedError) throw state.preparedDegradedError;
      return state.preparedDegradedResult;
    }),
    deleteDegradedComment: mock(async (input: unknown) => {
      calls.push({ op: "delete-degraded", args: input });
      if (state.deleteDegradedError) throw state.deleteDegradedError;
      return state.deleteDegradedOutcome;
    }),
    postLineComments: mock(async (input: { intents: LineIntent[] }) => {
      calls.push({ op: "line-comments", args: input });
      if (state.lineCommentsError) throw state.lineCommentsError;
      if (state.lineCommentsResult.posted.length === 0 && input.intents.length > 0) {
        // Default capture: map every intent to a fresh comment id.
        return {
          posted: input.intents.map((intent, index) => ({
            associationId: intent.associationId,
            commentId: 300 + index,
            path: intent.path,
            line: intent.line,
          })),
          ambiguous: [],
          captured: true,
          reviewId: state.lineCommentsResult.reviewId,
        };
      }
      return state.lineCommentsResult;
    }),
    listDiscussion: mock(async (input: unknown) => {
      calls.push({ op: "list-discussion", args: input });
      if (state.discussionError) throw state.discussionError;
      return state.discussion;
    }),
    discoverThread: mock(async (input: unknown) => {
      calls.push({ op: "discover", args: input });
      return state.discoverResult;
    }),
    resolveFindingThread: mock(async (input: unknown) => {
      calls.push({ op: "resolve", args: input });
      if (state.resolveError) throw state.resolveError;
      return state.resolveResult;
    }),
  };
}

export type { Discussion, ResolveOutcome, DiscoveryResult, DegradedDeleteOutcome, UpsertPlan };

