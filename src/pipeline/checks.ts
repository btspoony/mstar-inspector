
import type { D1Like } from "../store/types";
import {
  adoptReleasedCheckAttempt,
  attachCheckRunId,
  CHECK_ATTACH_GRACE_MS,
  CHECK_ATTACH_WINDOW_MS,
  CHECK_BACKOFF_MS,
  CHECK_LEASE_MS,
  CHECK_NAME,
  claimAttachedCheckForSettlement,
  claimAttempt,
  deferCheckRecovery,
  readCheckIdentity,
  readInheritedReview,
  readPublicationProof,
  readPublishedReview,
  recordCheckObservation,
  releaseAttachedCheck,
  releaseCheckClaim,
  clearTerminalDispatch,
  recordTerminalDispatch,
  rollbackCheckCreateDispatch,
  setCheckCreateState,
  setCheckDesired,
  setCheckFallbackDesired,
  type CheckAttempt,
  type CheckConclusion,
  type CheckFailureStatus,
  type CheckIdentity,
  type CheckOwnership,
  type CheckRemote,
  type Lease,
  type PublicationProof,
  type PublishedReview,
  type Scope,
  getCheckAttempt,
  getCheckOwnership,
  markCheckQueuedBehindInflight,
  recordTerminalizeOutcome,
} from "../store/review-checks";
import { claimPublicationLease, releasePublicationLease } from "../store/finding-lifecycle";
import { redactSecrets } from "./redact";
import { CHECK_UPDATE_DEFAULT } from "./check-budgets-reader";
import type { BudgetExhaustedOutcome } from "../../packages/shared/src/budget-exhausted-wire";
import { partialSeatCoverageLine } from "../../packages/shared/src/coverage-wire";


/** A check-run payload as the installed octokit types deliver it. */
export type CheckRunPayload = {
  id: number | bigint;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  app: { id: number | bigint } | null;
  output?: { title?: string | null; summary?: string | null } | null;
};

export type ChecksCreateParams = {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  external_id: string;
  status: "queued";
};

/**
 * A NON-TERMINAL relabel of an owned run: the human-facing text and nothing
 * else. `PATCH /check-runs/{id}` accepts a partial body, so status and
 * conclusion are simply ABSENT — the run keeps running, which is what the
 * held-check relabel needs (§7.9/§7.10).
 */
export type ChecksRelabelParams = {
  owner: string;
  repo: string;
  check_run_id: number;
  output: { title: string; summary: string };
};

/**
 * The TERMINAL update: status and conclusion are REQUIRED and travel together,
 * so a terminal send cannot be built without its conclusion. The relabel above
 * is the separate, deliberately non-terminal shape.
 */
export type ChecksUpdateParams = ChecksRelabelParams & {
  status: "completed";
  conclusion: CheckConclusion["desired"];
};

/**
 * The NON-TERMINAL promotion: the run is created `queued` when the delivery is
 * accepted, and the review's own begin moves it to `in_progress` with the text
 * that says so. No conclusion — a run carrying one is finished.
 */
export type ChecksInProgressParams = ChecksRelabelParams & {
  status: "in_progress";
};

/**
 * What a promotion actually achieved (spec §7.9). `abandoned` is the load-
 * bearing case: the budget ended the WAIT while the PATCH may still be on the
 * wire, so a terminal write from the same invocation could be reordered after
 * it and reopen a finished run. The caller must then leave the run to the
 * recovery lane instead of updating it itself.
 */
export type CheckPromotion =
  | { kind: "settled"; promoted: boolean }
  | { kind: "abandoned" };

export type ChecksListParams = {
  owner: string;
  repo: string;
  ref: string;
  check_name: string;
  app_id: number;
  filter: "all";
  per_page: number;
  page: number;
};

/** One `listForRef` page: the runs plus GitHub's own count for this window. */
export type ChecksListPage = {
  total_count: number;
  check_runs: CheckRunPayload[];
};

/**
 * The narrowed Checks surface of the per-App review-write octokit — structural
 * narrowing of the SAME client, not a second one (the `PostOctokit` /
 * `GraphqlOctokit` precedent). Adoption walks `listForRef` by explicit `page`
 * (spec §7.9 names the parameter), so the 2-page bound is enforced here rather
 * than relying on an unbounded auto-pagination helper.
 */
export type ChecksOctokit = {
  rest: {
    checks: {
      create(params: ChecksCreateParams): Promise<{ data: CheckRunPayload }>;
      update(
        params: ChecksRelabelParams | ChecksInProgressParams | ChecksUpdateParams,
      ): Promise<{ data: CheckRunPayload }>;
      get(params: { owner: string; repo: string; check_run_id: number }): Promise<{ data: CheckRunPayload }>;
      listForRef(params: ChecksListParams): Promise<{ data: ChecksListPage }>;
    };
  };
};


/**
 * Narrow a raw check-run payload to the fields this contract reasons about, or
 * null when the payload cannot carry identity evidence at all. A null here is
 * NEVER treated as a candidate: a malformed run cannot be adopted or observed.
 */
export function toCheckRemote(payload: CheckRunPayload | null | undefined): CheckRemote | null {
  if (payload === null || payload === undefined) return null;
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (typeof payload.name !== "string" || typeof payload.head_sha !== "string") return null;
  if (typeof payload.status !== "string") return null;
  if (payload.external_id !== null && typeof payload.external_id !== "string") return null;
  if (payload.conclusion !== null && typeof payload.conclusion !== "string") return null;
  const rawSummary = payload.output?.summary;
  const summary = typeof rawSummary === "string" ? rawSummary : null;
  if (payload.app === null || payload.app === undefined) {
    return {
      id,
      name: payload.name,
      head_sha: payload.head_sha,
      external_id: payload.external_id,
      status: payload.status,
      conclusion: payload.conclusion,
      summary,
      app: null,
    };
  }
  const appId = Number(payload.app.id);
  if (!Number.isInteger(appId)) return null;
  return {
    id,
    name: payload.name,
    head_sha: payload.head_sha,
    external_id: payload.external_id,
    status: payload.status,
    conclusion: payload.conclusion,
    summary,
    app: { id: appId },
  };
}

/**
 * The four fields GitHub must agree on for a run to be OURS (spec §7.9:
 * validate name, SHA, external ID and `app.id === githubAppId`). Ownership is
 * never inferred from a PR association or from the run name alone.
 */
export function remoteBelongsTo(remote: CheckRemote, identity: CheckIdentity): boolean {
  return (
    remote.external_id === identity.externalId &&
    remote.head_sha === identity.headSha &&
    remote.name === CHECK_NAME &&
    remote.app !== null &&
    remote.app.id === identity.githubAppId
  );
}


export type ChecksDeps = {
  db: D1Like;
  getOctokit(input: { scope: Scope }): Promise<ChecksOctokit | null>;
  nowMs: () => number;
  updateBudgetMs?: number;
};

/** The §7.9 adapter surface, bound to one App credential. */
export type ChecksAdapter = {
  beginCheck(input: {
    identity: CheckIdentity;
    lease: Lease;
  }): Promise<
    | { kind: "ready"; remote: CheckRemote }
    | { kind: "unavailable"; reason: string; requests: number }
  >;
  adoptCheckRun(input: {
    identity: CheckIdentity;
  }): Promise<{ kind: "found"; remote: CheckRemote } | { kind: "absent" | "incomplete" | "ambiguous" }>;
  completeCheck(input: {
    identity: CheckIdentity;
    lease: Lease;
    checkRunId: number;
    conclusion: CheckConclusion;
    updateBudgetMs?: number;
  }): Promise<
    | { kind: "completed"; remote: CheckRemote }
    | { kind: "unavailable"; reason: string; requests: number }
  >;
  markInProgress?(input: {
    identity: CheckIdentity;
    lease: Lease;
    summary: string;
    updateBudgetMs?: number;
    warn: (detail: string) => void;
  }): Promise<CheckPromotion>;
  markQueuedBehindInflight?(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    rerunCheckRunId?: number;
    attachDeliveryId?: string;
    checkRunId: number;
    summary: string;
    updateBudgetMs?: number;
    warn: (detail: string) => void;
  }): Promise<boolean>;
  fetchCheckRun(input: {
    identity: CheckIdentity;
    checkRunId: number;
  }): Promise<
    | { kind: "found"; remote: CheckRemote }
    | { kind: "absent" }
    | { kind: "unavailable"; reason: string; requests: number }
  >;
};

/**
 * The typed proof that a send lane's request NEVER reached GitHub: the single
 * error a pre-dispatch gate (an allowance/transport bound, a client-side
 * fence) throws instead of dispatching. It carries no behaviour — it is a
 * marker, and `isRequestNotDispatched` recognises it through the error chain
 * because octokit re-wraps a custom transport rejection as a `RequestError`
 * with the original parked on `cause`.
 *
 * The distinction is load-bearing for recovery (spec §7.11.2 step 5): a
 * refusal that never left the process must report `requests: 0` so the caller
 * may roll the durable `sending` mark back and let recovery CREATE again,
 * while every unproven failure stays `requests: 1` and adopt-only. Throw this
 * ONLY when dispatch provably did not happen — a false marker would authorise
 * a second remote run for a head that already has one (RL-12).
 */
export class CheckRequestNotDispatched extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckRequestNotDispatched";
  }
}

/** Identity walk of the error chain — never message text, which would classify
 * any error merely mentioning the budget as un-dispatched. */
export function isRequestNotDispatched(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof CheckRequestNotDispatched) return true;
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

function sendRequests<T>(promise: Promise<T>): Promise<{ sent: number; outcome: T | { failure: unknown } }> {
  return promise.then(
    (outcome) => ({ sent: 1, outcome }),
    (failure: unknown) => ({ sent: isRequestNotDispatched(failure) ? 0 : 1, outcome: { failure } }),
  );
}


async function sendRequestsWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
  label: string,
): Promise<
  | { settled: true; sent: number; outcome: T | { failure: unknown } }
  | { settled: false; sent: 1; outcome: { failure: unknown } }
> {
  const { promise: budget, resolve } = Promise.withResolvers<{
    settled: false;
    sent: 1;
    outcome: { failure: unknown };
  }>();
  const timer = setTimeout(
    () => resolve({ settled: false, sent: 1, outcome: { failure: new Error(`${label} exceeded ${budgetMs}ms`) } }),
    budgetMs,
  );
  try {
    return await Promise.race([sendRequests(promise).then((result) => ({ ...result, settled: true as const })), budget]);
  } finally {
    clearTimeout(timer);
  }
}

const ADOPT_MAX_PAGES = 2;
const ADOPT_PAGE_SIZE = 100;

/**
 * Build the Checks adapter for one purpose-scoped reviewer instance. A factory
 * rather than free functions is what keeps credentials out of the module: one
 * instance per App credential pair, exactly like `createReviewThreads`.
 */
export function createChecksAdapter(deps: ChecksDeps): ChecksAdapter {
  return {
    beginCheck: (input) => beginCheckWith(deps, input),
    adoptCheckRun: (input) => adoptCheckRunWith(deps, input),
    completeCheck: (input) => completeCheckWith(deps, input),
    markInProgress: (input) => markInProgressWith(deps, input),
    markQueuedBehindInflight: (input) => markQueuedBehindInflightWith(deps, input),
    fetchCheckRun: (input) => fetchCheckRunWith(deps, input),
  };
}

async function beginCheckWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity; lease: Lease },
): Promise<{ kind: "ready"; remote: CheckRemote } | { kind: "unavailable"; reason: string; requests: number }> {
  const nowMs = deps.nowMs();
  const owned = await guardOwnership(deps, input.identity, input.lease, nowMs);
  if (owned.kind === "unavailable") return owned;
  const identity = owned.data.identity;
  if (owned.data.checkRunId !== null) {
    return refused("attempt already owns a remote check run");
  }
  if (owned.data.createState !== "not-sent") {
    return refused(`create is not definitively unsent (create_state=${owned.data.createState}); adopt instead`);
  }
  const client = await clientFor(deps, identity.scope);
  if ("reason" in client) return refused(client.reason);
  if (!hasChecksMethod(client.client, "create")) {
    return refused("Checks surface has no callable create method");
  }
  const opened = await openPublicationFence(deps, {
    attemptId: identity.attemptId,
    actionKey: PUBLICATION_ACTION_CHECK_CREATE,
    holder: input.lease.holder,
  });
  if ("reason" in opened) return refused(opened.reason);
  const fence = opened.fence;
  try {
    const marked = await setCheckCreateState(deps.db, identity.attemptId, input.lease, "sending", undefined, nowMs);
    if (!marked) {
      return refused("could not record the create attempt under this lease");
    }
    if (!(await stillLive(deps, identity, input.lease))) {
      await rollbackCheckCreateDispatch(deps.db, identity.attemptId, input.lease, nowMs);
      return refused("lease expired before the create request");
    }
    if (!(await fence.verify())) {
      await rollbackCheckCreateDispatch(deps.db, identity.attemptId, input.lease, nowMs);
      return refused(`publication lease ${fence.actionKey} lapsed before the create request`);
    }
    const { scope } = identity;
    const attempted = await sendRequests(
      client.client.rest.checks.create({
        owner: scope.owner,
        repo: scope.repo,
        name: CHECK_NAME,
        head_sha: identity.headSha,
        external_id: identity.externalId,
        status: "queued",
      }),
    );
    if ("failure" in attempted.outcome) {
      if (attempted.sent === 0) {
        await rollbackCheckCreateDispatch(deps.db, identity.attemptId, input.lease, nowMs);
      }
      return { kind: "unavailable", requests: attempted.sent, reason: surfaceFailure(attempted.outcome.failure, "check create") };
    }
    const remote = toCheckRemote(attempted.outcome.data);
    if (remote === null) {
      return { kind: "unavailable", requests: attempted.sent, reason: "check create returned a malformed payload" };
    }
    if (!remoteBelongsTo(remote, identity)) {
      return { kind: "unavailable", requests: attempted.sent, reason: "check create response does not match this attempt identity" };
    }
    return { kind: "ready", remote };
  } finally {
    await fence.release();
  }
}

async function adoptCheckRunWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity },
): Promise<
  { kind: "found"; remote: CheckRemote } | { kind: "absent" | "incomplete" | "ambiguous" }
> {
  const persisted = await persistedIdentity(deps, input.identity);
  if (persisted.kind === "unavailable") return { kind: "incomplete" };
  const identity = persisted.identity;
  const resolvedClient = await clientFor(deps, identity.scope);
  if ("reason" in resolvedClient) return { kind: "incomplete" };
  const client = resolvedClient.client;
  const { scope } = identity;
  const matches: CheckRemote[] = [];
  let saturated = false;
  for (let page = 1; page <= ADOPT_MAX_PAGES; page += 1) {
    let result: { data: ChecksListPage };
    try {
      result = await client.rest.checks.listForRef({
        owner: scope.owner,
        repo: scope.repo,
        ref: identity.headSha,
        check_name: CHECK_NAME,
        app_id: identity.githubAppId,
        filter: "all",
        per_page: ADOPT_PAGE_SIZE,
        page,
      });
    } catch {
      return { kind: "incomplete" };
    }
    const runs = result?.data?.check_runs;
    if (!Array.isArray(runs)) return { kind: "incomplete" };
    for (const payload of runs) {
      const remote = toCheckRemote(payload);
      if (remote === null) return { kind: "ambiguous" };
      if (remoteBelongsTo(remote, identity)) matches.push(remote);
    }
    if (matches.length > 1) return { kind: "ambiguous" };
    saturated = runs.length >= ADOPT_PAGE_SIZE;
    if (!saturated) {
      return matches.length === 1 ? { kind: "found", remote: matches[0]! } : { kind: "absent" };
    }
  }
  return { kind: "incomplete" };
}

async function completeCheckWith(
  deps: ChecksDeps,
  input: {
    identity: CheckIdentity;
    lease: Lease;
    checkRunId: number;
    conclusion: CheckConclusion;
    updateBudgetMs?: number;
  },
): Promise<{ kind: "completed"; remote: CheckRemote } | { kind: "unavailable"; reason: string; requests: number }> {
  const owned = await guardOwnership(deps, input.identity, input.lease, deps.nowMs());
  if (owned.kind === "unavailable") return owned;
  const identity = owned.data.identity;
  if (owned.data.desired === "in_progress") {
    return refused("terminal intent was never persisted for this attempt");
  }
  const frozenTitle = owned.data.desiredTitle;
  const frozenSummary = owned.data.desiredSummary;
  if (frozenTitle === null || frozenSummary === null) {
    return refused("persisted terminal intent carries no frozen title/summary");
  }
  const frozen = {
    desired: owned.data.desired as CheckConclusion["desired"],
    title: frozenTitle,
    summary: frozenSummary,
  };
  if (frozen.desired !== input.conclusion.desired) {
    return refused("conclusion does not match the persisted terminal intent");
  }
  if (owned.data.checkRunId !== input.checkRunId) {
    return refused("check run id is not the one this attempt persisted");
  }
  const opened = await openPublicationFence(deps, {
    attemptId: identity.attemptId,
    actionKey: PUBLICATION_ACTION_CHECK_COMPLETE,
    holder: input.lease.holder,
  });
  if ("reason" in opened) return refused(opened.reason);
  const fence = opened.fence;
  try {
    return await terminalUpdate(deps, fence, identity, input, frozen);
  } finally {
    await fence.release();
  }
}

async function terminalUpdate(
  deps: ChecksDeps,
  fence: PublicationFence,
  identity: CheckIdentity,
  input: {
    lease: Lease;
    checkRunId: number;
    conclusion: CheckConclusion;
    updateBudgetMs?: number;
  },
  frozen: { desired: CheckConclusion["desired"]; title: string; summary: string },
): Promise<{ kind: "completed"; remote: CheckRemote } | { kind: "unavailable"; reason: string; requests: number }> {
  const resolvedClient = await clientFor(deps, identity.scope);
  if ("reason" in resolvedClient) return refused(resolvedClient.reason);
  const client = resolvedClient.client;
  if (!hasChecksMethod(client, "update")) {
    return refused("Checks surface has no callable update method");
  }
  if (!(await stillLive(deps, identity, input.lease))) {
    return refused("lease expired before the update request");
  }
  if (!(await fence.verify())) {
    return refused(`publication lease ${fence.actionKey} lapsed before the update request`);
  }
  if (!(await recordTerminalDispatch(deps.db, identity.attemptId, input.lease, deps.nowMs()))) {
    return refused("a terminal update for this attempt was already dispatched — reconcile it by readback");
  }
  const { scope } = identity;
  const terminal: ChecksUpdateParams = {
    owner: scope.owner,
    repo: scope.repo,
    check_run_id: input.checkRunId,
    status: "completed",
    conclusion: frozen.desired,
    output: { title: frozen.title, summary: frozen.summary },
  };
  const attempted = await sendRequestsWithin(
    client.rest.checks.update(terminal),
    input.updateBudgetMs ?? deps.updateBudgetMs ?? CHECK_UPDATE_DEFAULT,
    "check update",
  );
  if ("failure" in attempted.outcome) {
    if (attempted.sent === 0) {
      await clearTerminalDispatch(deps.db, identity.attemptId, input.lease, deps.nowMs());
    }
    return { kind: "unavailable", requests: attempted.sent, reason: surfaceFailure(attempted.outcome.failure, "check update") };
  }
  const remote = toCheckRemote(attempted.outcome.data);
  if (remote === null) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update returned a malformed payload" };
  }
  if (!remoteBelongsTo(remote, identity)) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update response does not match this attempt identity" };
  }
  if (remote.status !== "completed" || remote.conclusion !== frozen.desired) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update response is not the intended terminal state" };
  }
  if (remote.summary !== frozen.summary) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update response does not carry the frozen text" };
  }
  return { kind: "completed", remote };
}

async function markInProgressWith(
  deps: ChecksDeps,
  input: {
    identity: CheckIdentity;
    lease: Lease;
    summary: string;
    updateBudgetMs?: number;
    warn: (detail: string) => void;
  },
): Promise<CheckPromotion> {
  const owned = await guardOwnership(deps, input.identity, input.lease, deps.nowMs());
  if (owned.kind === "unavailable") return { kind: "settled", promoted: false };
  if (owned.data.desired !== "in_progress") return { kind: "settled", promoted: false };
  const runId = owned.data.checkRunId;
  if (runId === null) return { kind: "settled", promoted: false };
  const { scope } = owned.data.identity;
  const budgetMs = input.updateBudgetMs ?? deps.updateBudgetMs ?? CHECK_UPDATE_DEFAULT;
  const opened = await openPublicationFence(deps, {
    attemptId: owned.data.identity.attemptId,
    actionKey: PUBLICATION_ACTION_CHECK_IN_PROGRESS,
    holder: input.lease.holder,
  });
  if ("reason" in opened) return { kind: "settled", promoted: false };
  const fence = opened.fence;
  try {
    const send = (async (): Promise<boolean> => {
      const resolvedClient = await clientFor(deps, scope);
      if ("reason" in resolvedClient) return false;
      const client = resolvedClient.client;
      if (!hasChecksMethod(client, "update")) return false;
      if (!(await stillLive(deps, owned.data.identity, input.lease))) return false;
      if (!(await fence.verify())) return false;
      await client.rest.checks.update({
        owner: scope.owner,
        repo: scope.repo,
        check_run_id: runId,
        status: "in_progress",
        output: { title: CHECK_NAME, summary: input.summary },
      });
      return true;
    })();
    const attempted = await sendRequestsWithin(send, budgetMs, "check in-progress");
    if (!attempted.settled) {
      input.warn(surfaceFailure(attempted.outcome.failure, "check in-progress"));
      return { kind: "abandoned" };
    }
    if (typeof attempted.outcome !== "boolean") {
      input.warn(surfaceFailure(attempted.outcome.failure, "check in-progress"));
      return { kind: "settled", promoted: false };
    }
    return { kind: "settled", promoted: attempted.outcome };
  } finally {
    await fence.release();
  }
}

async function markQueuedBehindInflightWith(
  deps: ChecksDeps,
  input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    rerunCheckRunId?: number;
    attachDeliveryId?: string;
    checkRunId: number;
    summary: string;
    updateBudgetMs?: number;
    warn: (detail: string) => void;
  },
): Promise<boolean> {
  const budgetMs = input.updateBudgetMs ?? deps.updateBudgetMs ?? CHECK_UPDATE_DEFAULT;
  const send = (async (): Promise<boolean> => {
    const resolvedClient = await clientFor(deps, input.scope);
    if ("reason" in resolvedClient) return false;
    const client = resolvedClient.client;
    if (!hasChecksMethod(client, "update")) return false;
    const relabeled = await markCheckQueuedBehindInflight(deps.db, {
      scope: input.scope,
      headSha: input.headSha,
      triggeredBy: input.triggeredBy,
      action: input.action,
      rerunCheckRunId: input.rerunCheckRunId,
      attachDeliveryId: input.attachDeliveryId,
      title: CHECK_NAME,
      summary: input.summary,
      nowMs: deps.nowMs(),
    });
    if (relabeled === null || relabeled.checkRunId !== input.checkRunId) return false;
    const opened = await openPublicationFence(deps, {
      attemptId: relabeled.id,
      actionKey: PUBLICATION_ACTION_CHECK_COMPLETE,
      holder: `check-relabel:${input.attachDeliveryId ?? relabeled.id}`,
    });
    if ("reason" in opened) return false;
    const fence = opened.fence;
    try {
      if (!(await fence.verify())) return false;
      const current = await getCheckAttempt(deps.db, relabeled.id);
      if (
        current === null ||
        current.terminalMs !== null ||
        current.desired !== "in_progress" ||
        current.checkRunId !== input.checkRunId
      ) {
        return false;
      }
      if (!(await fence.verify())) return false;
      await client.rest.checks.update({
        owner: input.scope.owner,
        repo: input.scope.repo,
        check_run_id: input.checkRunId,
        output: { title: CHECK_NAME, summary: input.summary },
      });
      return true;
    } finally {
      await fence.release();
    }
  })();
  const attempted = await sendRequestsWithin(send, budgetMs, "held check relabel");
  if (!attempted.settled) {
    input.warn(surfaceFailure(attempted.outcome.failure, "held check relabel"));
    return false;
  }
  const outcome = attempted.outcome;
  if (typeof outcome !== "boolean") {
    input.warn(surfaceFailure(outcome.failure, "held check relabel"));
    return false;
  }
  return outcome;
}

async function fetchCheckRunWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity; checkRunId: number },
): Promise<
  | { kind: "found"; remote: CheckRemote }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string; requests: number }
> {
  const persisted = await persistedIdentity(deps, input.identity);
  if (persisted.kind === "unavailable") {
    return { kind: "unavailable", reason: persisted.reason, requests: 0 };
  }
  const identity = persisted.identity;
  const resolvedClient = await clientFor(deps, identity.scope);
  if ("reason" in resolvedClient) {
    return { kind: "unavailable", reason: resolvedClient.reason, requests: 0 };
  }
  const client = resolvedClient.client;
  const { scope } = identity;
  try {
    const { data } = await client.rest.checks.get({
      owner: scope.owner,
      repo: scope.repo,
      check_run_id: input.checkRunId,
    });
    const remote = toCheckRemote(data);
    if (remote === null) {
      return { kind: "unavailable", reason: "check get returned a malformed payload", requests: 1 };
    }
    if (remote.id !== input.checkRunId) {
      return { kind: "unavailable", reason: "check get returned a different run", requests: 1 };
    }
    return remoteBelongsTo(remote, identity) ? { kind: "found", remote } : { kind: "absent" };
  } catch (error) {
    if (httpStatus(error) === 404) return { kind: "absent" };
    return { kind: "unavailable", reason: surfaceFailure(error, "check get"), requests: 1 };
  }
}

function refused(reason: string): { kind: "unavailable"; reason: string; requests: 0 } {
  return { kind: "unavailable", reason, requests: 0 };
}

async function guardOwnership(
  deps: ChecksDeps,
  identity: CheckIdentity,
  lease: Lease,
  nowMs: number,
): Promise<
  { kind: "ok"; data: CheckOwnership } | { kind: "unavailable"; reason: string; requests: 0 }
> {
  let owned: CheckOwnership | null;
  try {
    owned = await getCheckOwnership(deps.db, identity.attemptId, lease, nowMs);
  } catch (error) {
    return refused(`attempt ownership read failed: ${safeDetail(error)}`);
  }
  if (owned === null) return refused("attempt is not owned by this live lease");
  if (!sameIdentity(owned.identity, identity)) {
    return refused("caller identity disagrees with the persisted attempt");
  }
  return { kind: "ok", data: owned };
}

function sameIdentity(persisted: CheckIdentity, supplied: CheckIdentity): boolean {
  return (
    persisted.attemptId === supplied.attemptId &&
    persisted.generation === supplied.generation &&
    persisted.externalId === supplied.externalId &&
    persisted.githubAppId === supplied.githubAppId &&
    persisted.headSha === supplied.headSha &&
    persisted.scope.appId === supplied.scope.appId &&
    persisted.scope.installationId === supplied.scope.installationId &&
    persisted.scope.owner === supplied.scope.owner &&
    persisted.scope.repo === supplied.scope.repo &&
    persisted.scope.prNumber === supplied.scope.prNumber
  );
}

async function persistedIdentity(
  deps: ChecksDeps,
  supplied: CheckIdentity,
): Promise<{ kind: "ok"; identity: CheckIdentity } | { kind: "unavailable"; reason: string }> {
  let attempt: CheckAttempt | null;
  try {
    attempt = await getCheckAttempt(deps.db, supplied.attemptId);
  } catch (error) {
    return { kind: "unavailable", reason: `attempt identity read failed: ${safeDetail(error)}` };
  }
  if (attempt === null) return { kind: "unavailable", reason: "no persisted attempt for this id" };
  if (!sameIdentity(attempt.identity, supplied)) {
    return { kind: "unavailable", reason: "caller identity disagrees with the persisted attempt" };
  }
  return { kind: "ok", identity: attempt.identity };
}

function hasChecksMethod(client: ChecksOctokit, method: "create" | "update" | "get" | "listForRef"): boolean {
  const surface = client?.rest?.checks as Record<string, unknown> | undefined;
  return typeof surface?.[method] === "function";
}

async function stillLive(deps: ChecksDeps, identity: CheckIdentity, lease: Lease): Promise<boolean> {
  try {
    return (await getCheckOwnership(deps.db, identity.attemptId, lease, deps.nowMs())) !== null;
  } catch {
    return false;
  }
}

async function clientFor(
  deps: ChecksDeps,
  scope: Scope,
): Promise<{ client: ChecksOctokit } | { reason: string }> {
  try {
    const client = await deps.getOctokit({ scope });
    return client === null ? { reason: "no review-write Checks client for this App" } : { client };
  } catch (error) {
    return { reason: `no review-write Checks client for this App: ${safeDetail(error)}` };
  }
}

function surfaceFailure(error: unknown, surface: string): string {
  const status = httpStatus(error);
  if (status === 403) return `${surface} refused (403): the App installation lacks checks:write`;
  if (status === 404) return `${surface} refused (404): repository or head ref not visible to this App`;
  return `${surface} failed: ${safeDetail(error)}`;
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { status } = error as { status?: unknown };
  return typeof status === "number" ? status : null;
}

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).replace(/[\r\n]+/g, " ").slice(0, 240);
}


/** The §7.9 action key of the terminal Check update on one attempt. */
export const PUBLICATION_ACTION_CHECK_COMPLETE = "check:complete";
/** The §7.9 action key of the `in_progress` promotion on one attempt. */
export const PUBLICATION_ACTION_CHECK_IN_PROGRESS = "check:in-progress";
/** The §7.9 action key of the run CREATE on one attempt. */
export const PUBLICATION_ACTION_CHECK_CREATE = "check:create";

/**
 * Authority to perform ONE GitHub mutation: the publication-lease row this
 * sender took for its action (spec §7.9). It is NOT the attempt's execution
 * lease — that one proves who may drive the attempt, this one proves who may
 * send right now, and a holder may have either without the other.
 */
export type PublicationFence = {
  actionKey: string;
  verify(): Promise<boolean>;
  release(): Promise<boolean>;
};

/**
 * Take the publication lease of one action for a SEND (spec §7.9): `mode` is
 * `send`, the key is the mutation (`check:complete`, `comment:<id>`), and a
 * live holder of the same key — send OR recovery — refuses this acquisition
 * instead of being bypassed. A store fault is a refusal too: an unreadable
 * lease is not publication authority.
 */
export async function openPublicationFence(
  deps: { db: D1Like; nowMs: () => number },
  input: { attemptId: string; actionKey: string; holder: string },
): Promise<{ fence: PublicationFence } | { reason: string }> {
  try {
    if ((await getCheckAttempt(deps.db, input.attemptId)) === null) {
      return { reason: `${input.actionKey}: ${input.attemptId} is not a Check attempt — no publication authority` };
    }
  } catch (error) {
    return { reason: `publication lease for ${input.actionKey} unreadable: ${safeDetail(error)}` };
  }
  let lease: Lease | null;
  try {
    lease = await claimPublicationLease(deps.db, {
      attemptId: input.attemptId,
      actionKey: input.actionKey,
      holder: input.holder,
      mode: "send",
      nowMs: deps.nowMs(),
    });
  } catch (error) {
    return { reason: `publication lease for ${input.actionKey} unreadable: ${safeDetail(error)}` };
  }
  if (lease === null) {
    return { reason: `publication lease for ${input.actionKey} is held by another holder` };
  }
  const held = lease;
  return {
    fence: {
      actionKey: input.actionKey,
      async verify() {
        try {
          const row = await deps.db
            .prepare(`SELECT holder, lease_epoch, lease_until_ms FROM publication_leases WHERE attempt_id = ? AND action_key = ?`)
            .bind(input.attemptId, input.actionKey)
            .first<{ holder: string | null; lease_epoch: number; lease_until_ms: number | null }>();
          return (
            row !== null &&
            row.holder === input.holder &&
            row.lease_epoch === held.epoch &&
            row.lease_until_ms === held.untilMs &&
            deps.nowMs() < held.untilMs
          );
        } catch {
          return false;
        }
      },
      async release() {
        try {
          return await releasePublicationLease(deps.db, {
            attemptId: input.attemptId,
            actionKey: input.actionKey,
            lease: held,
            nowMs: deps.nowMs(),
          });
        } catch {
          return false;
        }
      },
    },
  };
}


/**
 * The per-App review gate (spec §7.9): a published review satisfies it only
 * when its verdict is one of `passVerdicts` AND its score is at least
 * `minScore`. Both values come from the App row; `passVerdicts` is engine
 * `PR_VERDICTS` vocabulary, validated by the store before any write.
 */
export type ReviewGate = { minScore: number; passVerdicts: readonly string[] };

/**
 * Frozen summaries, exactly as spec §7.9's matrix spells them.
 *
 * A terminal FAILURE carries the approved wording of its category instead (see
 * `TERMINAL_FAILURE_TEXT`): no branch here may re-introduce an interpolated
 * cause. What remains is the vocabulary of a REVIEW RESULT — the gate verdicts
 * and the skip texts — where the per-attempt facts (head, score, verdict) are
 * the point rather than an internal cause.
 */
export const CHECK_SUMMARIES = {
  gateMet: (sha7: string, round: number, verdict: string, score: number, gate: ReviewGate) =>
    `Review gate met for ${sha7} (round ${round}): verdict "${boundedText(verdict, "unknown")}", score ${score} (floor ${gate.minScore}; allowed: ${verdictsText(gate)}).`,
  gateMissed: (sha7: string, verdict: string, score: number, gate: ReviewGate) =>
    `Review gate missed for ${sha7}: verdict "${boundedText(verdict, "unknown")}", score ${score} (floor ${gate.minScore}; allowed: ${verdictsText(gate)}).`,
  inProgress: (sha7: string) => `Review started for ${sha7} — this run reports the review of this commit.`,
  unconfirmed: "Review attempt could not be confirmed complete; publication status is unknown.",
  skipped: "No new changes since the last reviewed head; nothing to review for this head.",
  inheritedGateMet: (head7: string, base7: string, verdict: string, score: number, gate: ReviewGate) =>
    `No new changes at ${head7} (since ${base7}); the review gate result of ${base7} is inherited: verdict "${boundedText(verdict, "unknown")}", score ${score} (floor ${gate.minScore}; allowed: ${verdictsText(gate)}).`,
  inheritedGateMissed: (head7: string, base7: string, verdict: string, score: number, gate: ReviewGate) =>
    `No new changes at ${head7} (since ${base7}); the review gate of ${base7} was missed: verdict "${boundedText(verdict, "unknown")}", score ${score} (floor ${gate.minScore}; allowed: ${verdictsText(gate)}).`,
  sameHeadInheritedGateMet: (sha7: string, verdict: string, score: number, gate: ReviewGate) =>
    `No new changes since the reviewed head ${sha7}; its own gate result is inherited: verdict "${boundedText(verdict, "unknown")}", score ${score} (floor ${gate.minScore}; allowed: ${verdictsText(gate)}).`,
  sameHeadInheritedGateMissed: (sha7: string, verdict: string, score: number, gate: ReviewGate) =>
    `No new changes since the reviewed head ${sha7}; its own gate was missed: verdict "${boundedText(verdict, "unknown")}", score ${score} (floor ${gate.minScore}; allowed: ${verdictsText(gate)}).`,
  superseded: (sha7: string) =>
    `Review attempt was superseded by a newer commit; no review was published for ${sha7}.`,
  skippedByDelivery: (reason: string) =>
    `Review was skipped for this head: ${boundedText(reason, "the delivery was skipped before execution")}. No review was published.`,
} as const;

/**
 * The approved wording of a terminal review failure, keyed by its persisted
 * category (compass D9). Fixed text with its ONE next step — never formatted
 * from an error, and no entry promises a retry, a recovery or a refund: the
 * bot-mention path the text names starts a NEW attempt.
 *
 * `budget-stop` is absent on purpose: its approved text is the existing
 * exhaustion summary, which is derived from the attempt's own typed record (see
 * `terminalFailureSummary`).
 */
export const TERMINAL_FAILURE_TEXT = {
  paused:
    "Code review is paused right now. Your review has not run. Wait for the operator to resume the service; no action is needed from you.",
  "unknown-failure":
    "Something went wrong while running this review. Nothing is wrong with your change. Re-trigger the review by mentioning the review bot in a PR comment.",
  "cap-stop":
    "This review was stopped because it ran longer than the platform's maximum review duration. Nothing is wrong with your change. Re-trigger the review by mentioning the review bot in a PR comment.",
} as const satisfies Record<Exclude<CheckFailureStatus, "budget-stop">, string>;

/** The approved text for a category: its fixed wording, or the trusted formatter. */
export function terminalFailureSummary(
  status: CheckFailureStatus,
  budgetExhaustion?: BudgetExhaustedOutcome,
): string {
  if (status !== "budget-stop") return TERMINAL_FAILURE_TEXT[status];
  if (budgetExhaustion === undefined) {
    throw new Error('terminalFailureSummary: "budget-stop" requires the resolved budgetExhaustion record');
  }
  return budgetExhaustedSummary(budgetExhaustion);
}

function terminalFailure(status: CheckFailureStatus, budgetExhaustion?: BudgetExhaustedOutcome): CheckConclusion {
  return {
    desired: "failure",
    title: CHECK_NAME,
    summary: terminalFailureSummary(status, budgetExhaustion),
    failureStatus: status,
  };
}

const STOP_CATEGORY: Record<BudgetExhaustedOutcome["budgetWindow"], CheckFailureStatus> = {
  preparation: "cap-stop",
  runner: "budget-stop",
};

const BUDGET_EXHAUSTED_CAUSE_TEXT: Record<BudgetExhaustedOutcome["cause"], string> = {
  "runner-deadline": "runner deadline reached",
  "consumer-deadline": "consumer deadline reached",
  "sandbox-kill": "sandbox execution killed at its deadline",
};

/**
 * The Check's completeness statement for a budget stop (Review budget spec
 * § Exhaustion and Check publication). Full form when the runner window and
 * every counter are known; otherwise the short form appends only observed
 * counters, in order, and never implies a rerun would succeed. A counter the
 * attempt never observed stays out — it is null in the record, never 0.
 * Milliseconds render as exact decimal seconds with no trailing zeros, and a
 * non-positive window reports `0s` — the durable row keeps the raw `budgetMs`,
 * the summary never names an impossible budget.
 */
export function budgetExhaustedSummary(outcome: BudgetExhaustedOutcome): string {
  const budget = String(Math.max(0, outcome.budgetMs) / 1000);
  const tail =
    " — a time-budget failure, not a verdict on the PR; shrink the diff or use a tier whose ceiling covers it.";
  const { seatsDispatched, seatsStopped, changedLines } = outcome;
  if (
    outcome.budgetWindow === "runner" &&
    seatsStopped !== null &&
    seatsDispatched !== null &&
    changedLines !== null
  ) {
    return (
      `Review budget exhausted: ${outcome.tier} review stopped at ${budget}s ` +
      `with ${seatsStopped}/${seatsDispatched} seats stopped before finishing ` +
      `(${changedLines} changed lines)${tail}`
    );
  }
  const counters: string[] = [];
  if (seatsStopped !== null && seatsDispatched !== null) {
    counters.push(`${seatsStopped}/${seatsDispatched} seats stopped before finishing`);
  } else if (seatsStopped !== null) {
    counters.push(`${seatsStopped} seats stopped`);
  } else if (seatsDispatched !== null) {
    counters.push(`${seatsDispatched} seats dispatched`);
  }
  if (changedLines !== null) counters.push(`${changedLines} changed lines`);
  return (
    `Review budget exhausted: ${outcome.tier} review reached its ${budget}s ${outcome.budgetWindow} budget ` +
    `(${BUDGET_EXHAUSTED_CAUSE_TEXT[outcome.cause]})` +
    (counters.length === 0 ? "" : `; ${counters.join("; ")}`) +
    tail
  );
}

function verdictsText(gate: ReviewGate): string {
  return gate.passVerdicts.map((verdict) => boundedText(verdict, "unknown")).join(" | ").slice(0, 400);
}

/** What the caller knows about execution, alongside the persisted proof. */
export type CheckTerminalOutcome =
  | "pre-publication-failure"
  | "degraded-not-posted"
  | "publication-unknown"
  | "expired"
  | "local-error"
  | "skipped"
  | "superseded"
  | "budget-exhausted";

/**
 * Decide the Check conclusion from spec §7.9's matrix:
 *
 * | persisted proof / knowledge                                   | desired |
 * |---------------------------------------------------------------|---------|
 * | confirmed normal publication that MEETS the App review gate    | success |
 * | confirmed normal publication that misses the gate              | failure |
 * | confirmed normal publication with an unreadable App gate       | failure |
 * | confirmed normal publication with an unreadable review/tally   | failure |
 * | confirmed degraded publication                                 | failure |
 * | definitive failure before any publication send                 | failure |
 * | degraded send rejected, no earlier unknown send                | failure |
 * | any send with unconfirmed result, or expired attempt w/o proof | failure |
 * | recovery exhausted                                             | proof-derived, else failure |
 * | empty increment: inherits the reviewed head's gate result      | success/failure |
 * | empty increment with no readable baseline result               | failure |
 * | early claim contradicted by a newer checked-out head           | failure |
 *
 * Proof precedence (normal over degraded within the exact scope/SHA) lives in
 * `readPublicationProof`, which the caller uses to obtain `proof`; this
 * function trusts what it is handed and reads `kind` alone. A `null` proof is
 * UNPROVEN — which is not the same as "not published", and is why an unknown
 * outcome must conclude `failure` rather than guess. `review` is the review
 * THIS proof publication carried (`readPublishedReview` reads that publication
 * and never falls back to the scope/SHA row); `null` or a null score is
 * UNREADABLE, never a pass. `gate` is the stored App gate; `null` is unreadable
 * CONFIGURATION and fails closed — there is no permissive default to fall back
 * to. The `inherited` branch (an EMPTY increment) has NO neutral exit: the
 * baseline row, its envelope and its verdict are read fail-closed, so a
 * baseline that cannot be read is a `failure`, never a neutral required check
 * an empty commit could use to shed a failing one. `neutral` is reachable only
 * for a free-standing `skipped` round with no inheritable head, where there is
 * nothing to inherit and no send to lose; a degraded publication cannot prove
 * the gate was met (clarify C3) and concludes `failure`.
 *
 * Every `failure` reached from an EXECUTION fault carries the approved category
 * of that fault (`TERMINAL_FAILURE_TEXT`), so no branch may interpolate a cause
 * into the public text. Two failures carry none on purpose: a missed gate is a
 * verdict — the review ran and reported — and a superseded attempt is not a
 * fault at all.
 */
export function decideConclusion(input: {
  proof: PublicationProof | null;
  outcome: CheckTerminalOutcome;
  gate: ReviewGate | null;
  review: PublishedReview | null;
  inherited?: { headSha: string; reviewedHeadSha: string };
  headSha?: string;
  budgetExhaustion?: BudgetExhaustedOutcome;
}): CheckConclusion {
  const { proof, outcome, gate, review, inherited } = input;
  if (outcome === "budget-exhausted") {
    if (input.budgetExhaustion === undefined) {
      throw new Error(
        'decideConclusion: outcome "budget-exhausted" requires the resolved budgetExhaustion record',
      );
    }
    return terminalFailure(STOP_CATEGORY[input.budgetExhaustion.budgetWindow], input.budgetExhaustion);
  }
  if (proof !== null) {
    if (proof.kind === "degraded") return terminalFailure("unknown-failure");
    const sha7 = proof.headSha.slice(0, 7);
    if (gate === null || review === null || review.scorePct === null) {
      return terminalFailure("unknown-failure");
    }
    // A partial round names its coverage on BOTH faces — this summary and the
    // published body render the SAME sentence — and it is DELIVERED work: a
    // confirmed-published partial concludes success whatever the verdict's
    // gate position, because unreviewed seats can hold the difference the
    // gate score cannot see. The summary names the gate position honestly,
    // never claiming the full gate was met when it was not.
    const seatLine = partialSeatCoverageLine(review.seatCoverage);
    if (seatLine !== "") {
      return {
        desired: "success",
        title: CHECK_NAME,
        summary: withSeatCoverage(
          review.scorePct >= gate.minScore && gate.passVerdicts.includes(review.verdict)
            ? CHECK_SUMMARIES.gateMet(sha7, proof.round, review.verdict, review.scorePct, gate)
            : CHECK_SUMMARIES.gateMissed(sha7, review.verdict, review.scorePct, gate) +
                " — a partial review is a delivered review: the Check passes despite the gate miss",
          seatLine,
        ),
      };
    }
    const met = review.scorePct >= gate.minScore && gate.passVerdicts.includes(review.verdict);
    return met
      ? {
          desired: "success",
          title: CHECK_NAME,
          summary: CHECK_SUMMARIES.gateMet(sha7, proof.round, review.verdict, review.scorePct, gate),
        }
      : {
          desired: "failure",
          title: CHECK_NAME,
          summary: CHECK_SUMMARIES.gateMissed(sha7, review.verdict, review.scorePct, gate),
        };
  }
  if (inherited !== undefined) {
    const head7 = inherited.headSha.slice(0, 7);
    const base7 = inherited.reviewedHeadSha.slice(0, 7);
    const sameHead = inherited.headSha === inherited.reviewedHeadSha;
    if (review === null || gate === null || review.scorePct === null) {
      return terminalFailure("unknown-failure");
    }
    const met = review.scorePct >= gate.minScore && gate.passVerdicts.includes(review.verdict);
    return met
      ? {
          desired: "success",
          title: CHECK_NAME,
          summary: sameHead
            ? CHECK_SUMMARIES.sameHeadInheritedGateMet(head7, review.verdict, review.scorePct, gate)
            : CHECK_SUMMARIES.inheritedGateMet(head7, base7, review.verdict, review.scorePct, gate),
        }
      : {
          desired: "failure",
          title: CHECK_NAME,
          summary: sameHead
            ? CHECK_SUMMARIES.sameHeadInheritedGateMissed(head7, review.verdict, review.scorePct, gate)
            : CHECK_SUMMARIES.inheritedGateMissed(head7, base7, review.verdict, review.scorePct, gate),
        };
  }
  if (outcome === "skipped") {
    return { desired: "neutral", title: CHECK_NAME, summary: CHECK_SUMMARIES.skipped };
  }
  if (outcome === "superseded") {
    const sha7 = input.headSha === undefined || input.headSha === "" ? "unknown" : input.headSha.slice(0, 7);
    return { desired: "failure", title: CHECK_NAME, summary: CHECK_SUMMARIES.superseded(sha7) };
  }
  return terminalFailure("unknown-failure");
}

function boundedText(text: string, fallback: string): string {
  const value = text.trim().length === 0 ? fallback : text;
  return redactSecrets(value).replace(/[\r\n]+/g, " ").slice(0, 240);
}

/** The gate summary and the partial-coverage sentence, one space apart; no sentence, no change. */
function withSeatCoverage(summary: string, seatLine: string): string {
  return seatLine === "" ? summary : `${summary} ${seatLine}`;
}


/**
 * What the production lifecycle needs beyond the frozen §7.10 hook input.
 * `getAdapter` is the per-App routing seam: the consumer hands back the
 * adapter bound to THIS message's App credential (the single purpose-scoped
 * `review-write` client, spec §7.6), so the Check lane never mints a second
 * token, client or permission set. `null` = no Checks surface for the App,
 * which is an INELIGIBLE attempt — no row, no remote call.
 */
export type CheckLifecycleDeps = {
  db: D1Like;
  getAdapter(scope: Scope): ChecksAdapter | null;
  getCheckGate(scope: Scope): Promise<ReviewGate | null>;
  nowMs(): number;
};

/**
 * The per-invocation abandonment latch: one object per `begin` this caller
 * starts, handed IN with the call and read only by that call. It is never
 * reset or reused, so a detached begin's abandonment can never be undone by a
 * later message, and two invocations cannot observe each other's state.
 *
 * `signal` is the standard `AbortSignal` the consumer drives when its §7.10
 * budget elapses; `isAbandoned()` reads it. Both are provided so a caller can
 * either await the signal or poll the predicate without holding a second
 * source of truth.
 */
export type CheckBeginLatch = {
  signal: AbortSignal;
  isAbandoned(): boolean;
};

/**
 * One immutable-lifetime abandonment latch. The controller is captured by the
 * returned closure and is deliberately NOT exposed: only the consumer's own
 * timer may trip it, and nothing can re-arm it.
 */
export function createCheckBeginLatch(): CheckBeginLatch & { abandon(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    isAbandoned: () => controller.signal.aborted,
    abandon: () => controller.abort(),
  };
}

/**
 * The handle `begin` hands back to the seam: the persisted attempt id plus the
 * exact claim lease this invocation holds. Structurally identical to the
 * consumer's §7.10 `CheckHandle`; declared here so this module needs no
 * pipeline→consumer import for the shape.
 */
export type CheckLifecycleHandle = {
  attemptId: string;
  scope: Scope;
  githubAppId: number;
  headSha: string;
  lease: Lease;
};

/** The §7.10 hook pair, as `begin`/`terminalize` (spec §7.10). */
export type CheckLifecycle = {
  begin(input: {
    scope: Scope;
    githubAppId: number;
    headSha: string;
    triggeredBy: string;
    action: string;
    rerunCheckRunId?: number;
    executionDeadlineMs: number;
    expect?: { key: string; generation: number };
    latch?: CheckBeginLatch;
  }): Promise<CheckLifecycleHandle | null>;
  terminalize(input: {
    handle: CheckLifecycleHandle;
    publicationId: string | null;
    outcome: CheckTerminalOutcome;
    inheritedHeadSha?: string;
    budgetExhaustion?: BudgetExhaustedOutcome;
    updateBudgetMs?: number;
  }): Promise<void>;
  markInProgress(input: {
    handle: CheckLifecycleHandle;
    summary: string;
    updateBudgetMs?: number;
    warn: (detail: string) => void;
  }): Promise<CheckPromotion>;
  settleSkipped(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    rerunCheckRunId?: number;
    attachDeliveryId?: string;
    reason: string;
    paused?: boolean;
    warn?: (detail: string) => void;
    updateBudgetMs?: number;
  }): Promise<boolean>;
  markQueuedBehindInflight(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    rerunCheckRunId?: number;
    attachDeliveryId?: string;
    summary: string;
    updateBudgetMs: number;
    warn: (detail: string) => void;
  }): Promise<boolean>;
  abandonTerminalize(input: {
    handle: CheckLifecycleHandle;
    reason: string;
    outcome?: CheckTerminalOutcome;
    budgetExhaustion?: BudgetExhaustedOutcome;
    inheritedHeadSha?: string;
    firstRecoveryDelayMs?: number;
  }): Promise<boolean>;
};

/**
 * What the delivery-side attach needs: the registry plus ONE App's Checks
 * adapter (the single purpose-scoped client, spec §7.6).
 */
export type CheckAttachDeps = {
  db: D1Like;
  adapter: ChecksAdapter;
  nowMs: () => number;
};

/**
 * What one attach attempt produced. The caller must be able to tell a legitimate
 * no-op (another delivery or an earlier attach owns this head) from a real
 * failure, because only the failure arm owes the operator a warn (spec §7.9).
 */
export type CheckAttachResult =
  | { kind: "attached"; deliveryId: string }
  | { kind: "skipped"; reason: "busy" | "terminal" | "adopted" }
  | { kind: "failed"; reason: string };

/**
 * Attach a Check to an ACCEPTED delivery (spec §7.7 step 4 / §7.9).
 *
 * The delivery path claims the attempt, creates the `queued` run against
 * the payload's head SHA (the review's own begin promotes it to `in_progress`,
 * §7.9) and gives the row straight back, so the run appears
 * within seconds of the webhook instead of when a worker finally starts the
 * message. The row keeps `create_state = 'known'` and the run id — the durable
 * facts the consumer's `begin` adopts — and the long
 * `CHECK_ATTACH_WINDOW_MS` deadline keeps it adoptable across the queue delay.
 * That deadline is PROVISIONAL: the first execution admission narrows it, once,
 * to the attempt's frozen absolute deadline (`queue send + operator cap`).
 *
 * One run per head: the claim goes through `claimAttempt`, so a duplicate
 * delivery, a queue redelivery or a synchronize event that finds the key
 * `busy`/`terminal` creates nothing. Best-effort by contract: a failed create
 * releases the row to the recovery lane (which adopts rather than re-creates)
 * and answers `failed`; the caller owns "never block the enqueue, never change
 * the response" AND the one warn the failure arm owes.
 */
export async function attachCheckAtAcceptance(
  deps: CheckAttachDeps,
  input: {
    scope: Scope;
    githubAppId: number;
    headSha: string;
    triggeredBy: string;
    action: string;
    rerunCheckRunId?: number;
    deliveryId: string;
  },
): Promise<CheckAttachResult> {
  const { deliveryId } = input;
  const claimed = await claimAttempt(deps.db, {
    scope: input.scope,
    githubAppId: input.githubAppId,
    headSha: input.headSha,
    triggeredBy: input.triggeredBy,
    action: input.action,
    rerunCheckRunId: input.rerunCheckRunId,
    attachDeliveryId: deliveryId,
    holder: `delivery:${deliveryId}`,
    nowMs: deps.nowMs(),
    executionDeadlineMs: deps.nowMs() + CHECK_ATTACH_WINDOW_MS,
  });
  if (claimed.kind === "absent") {
    throw new Error("review-checks: a delivery attach claim answered absent — the store must mint without an expectation");
  }
  if (claimed.kind !== "claimed") return { kind: "skipped", reason: claimed.kind };
  const { identity } = claimed.attempt;
  const begun = await deps.adapter.beginCheck({ identity, lease: claimed.lease });
  if (begun.kind !== "ready") {
    await releaseToRecovery(deps, identity.attemptId, claimed.lease, begun.reason, begun.requests > 0);
    return { kind: "failed", reason: begun.reason };
  }
  const attached = await attachCheckRunId(deps.db, identity.attemptId, claimed.lease, begun.remote.id, deps.nowMs());
  if (!attached) {
    const reason = "the attach could not record the created run";
    await releaseToRecovery(deps, identity.attemptId, claimed.lease, reason, true);
    return { kind: "failed", reason };
  }
  const nowMs = deps.nowMs();
  const released = await releaseAttachedCheck(
    deps.db,
    identity.attemptId,
    claimed.lease,
    nowMs + CHECK_ATTACH_GRACE_MS,
    nowMs,
  );
  if (!released) {
    const current = await getCheckAttempt(deps.db, identity.attemptId).catch(() => null);
    const adoptedByConsumer =
      current !== null &&
      current.lease !== null &&
      current.lease.holder.startsWith("consumer:") &&
      current.lease.untilMs > nowMs;
    if (adoptedByConsumer) return { kind: "skipped", reason: "adopted" };
    return { kind: "failed", reason: "the attached row could not be released to the admitted message" };
  }
  return { kind: "attached", deliveryId };
}

async function releaseToRecovery(
  deps: CheckAttachDeps,
  attemptId: string,
  lease: Lease,
  reason: string,
  requestsSpent: boolean,
): Promise<void> {
  const nowMs = deps.nowMs();
  await deferCheckRecovery(
    deps.db,
    attemptId,
    lease,
    {
      state: requestsSpent ? "remote-unconfirmed" : "pending",
      nextAttemptMs: nowMs + CHECK_BACKOFF_MS[0]!,
      reason,
    },
    nowMs,
  );
}

/**
 * How long the consumer waits before its ONE retry of a refused adoption
 * (spec §7.9). The delivery path can still be mid-attach when the message is
 * admitted — a fresh `delivery:*` holder, or a run id not yet written — so the
 * first adoption refuses; this slice is enough for that attach to finish and
 * well inside the 2 s begin budget.
 */
export const CHECK_ATTACH_OVERLAP_RETRY_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryableOverlap(attempt: CheckAttempt): boolean {
  return attempt.lease !== null && attempt.lease.holder.startsWith("delivery:") && attempt.desired === "in_progress";
}

/**
 * The production §7.10 lifecycle.
 *
 * `begin` maps the seam input onto a FENCED attempt: an ineligible App (no
 * Checks surface) registers nothing, `claimAttempt` is the one race-decided
 * insert, and only a create whose response proved the attempt's identity is
 * attached to the row before the handle is returned. A `busy` answer whose
 * active row the DELIVERY path already attached (released, `known`, run id
 * present) is adopted through the same fenced claim and yields that row's
 * handle, so the review terminalizes the run inline. A `busy` row a live
 * holder owns, and `terminal` (a generation already ended with a PROVEN
 * publication), yield `null`: no second row, no second remote run.
 *
 * `terminalize` decides from PERSISTED proof, never from the code path that
 * called it: only this attempt's OWN publication is read — RL-12 head reuse
 * makes any head-keyed fallback another generation's proof, so an attempt
 * that published nothing has none — `setCheckDesired` freezes that intent
 * BEFORE the one bounded remote update, and `observed` advances ONLY from a
 * response the adapter validated. Every write is fenced on the handle's live
 * lease, so a stale/lost holder writes nothing — and the attempt stays
 * recoverable (`pending`/`remote-unconfirmed` + backoff) for the scheduled
 * lane, never blocking or delaying the review.
 */
export function createCheckLifecycle(deps: CheckLifecycleDeps): CheckLifecycle {
  const fenceFor = (lease: Lease): { lease: Lease; nowMs: number } => ({ lease, nowMs: deps.nowMs() });

  const abandonUnterminalized = async (
    attemptId: string,
    lease: Lease,
    reason: string,
    requestsSpent: boolean,
  ): Promise<void> => {
    await releaseForRecovery(attemptId, lease, reason, requestsSpent);
  };

  const releaseForRecovery = async (
    attemptId: string,
    lease: Lease,
    reason: string,
    requestsSpent: boolean,
    firstRecoveryDelayMs?: number,
  ): Promise<boolean> => {
    const nowMs = deps.nowMs();
    return deferCheckRecovery(
      deps.db,
      attemptId,
      lease,
      {
        state: requestsSpent ? "remote-unconfirmed" : "pending",
        nextAttemptMs: nowMs + (firstRecoveryDelayMs ?? CHECK_BACKOFF_MS[0]!),
        reason,
      },
      nowMs,
    );
  };

  const adoptLateCreatedRun = async (identity: CheckIdentity, lease: Lease, remoteId: number): Promise<void> => {
    const fence = fenceFor(lease);
    if (!(await attachCheckRunId(deps.db, identity.attemptId, fence.lease, remoteId, fence.nowMs))) return;
    await abandonUnterminalized(identity.attemptId, lease, "the creating invocation was abandoned by the consumer budget", true);
    await recordTerminalizeOutcome(deps.db, identity.attemptId, "no-handle", null).catch(() => {});
  };

  return {
    async begin(input) {
      const adapter = deps.getAdapter(input.scope);
      if (adapter === null) return null;
      const claim = await claimAttempt(deps.db, {
        scope: input.scope,
        githubAppId: input.githubAppId,
        headSha: input.headSha,
        triggeredBy: input.triggeredBy,
        action: input.action,
        rerunCheckRunId: input.rerunCheckRunId,
        holder: `consumer:${crypto.randomUUID()}`,
        nowMs: deps.nowMs(),
        executionDeadlineMs: input.executionDeadlineMs,
        ...(input.expect === undefined ? {} : { expect: input.expect }),
      });
      if (input.expect !== undefined && claim.kind !== "absent") {
        const ownsFrozenPair =
          claim.attempt.identity.generation === input.expect.generation &&
          (await readCheckIdentity(deps.db, claim.attempt.identity.attemptId))?.key === input.expect.key;
        if (!ownsFrozenPair) return null;
      }
      if (claim.kind === "busy") {
        const busy = claim.attempt;
        const adopt = (): Promise<Lease | null> =>
          adoptReleasedCheckAttempt(deps.db, {
            attemptId: busy.identity.attemptId,
            githubAppId: input.githubAppId,
            holder: `consumer:${crypto.randomUUID()}`,
            executionDeadlineMs: input.executionDeadlineMs,
            nowMs: deps.nowMs(),
          });
        let adopted = await adopt();
        if (adopted === null && retryableOverlap(busy)) {
          await delay(CHECK_ATTACH_OVERLAP_RETRY_MS);
          adopted = await adopt();
        }
        if (adopted === null) return null;
        if (input.latch?.isAbandoned() === true) {
          await recordTerminalizeOutcome(deps.db, claim.attempt.identity.attemptId, "no-handle", null).catch(() => {});
          await abandonUnterminalized(
            claim.attempt.identity.attemptId,
            adopted,
            "the adopting invocation was abandoned by the consumer budget after the run was adopted",
            true,
          );
          return null;
        }
        return {
          attemptId: claim.attempt.identity.attemptId,
          scope: claim.attempt.identity.scope,
          githubAppId: claim.attempt.identity.githubAppId,
          headSha: claim.attempt.identity.headSha,
          lease: adopted,
        };
      }
      if (claim.kind !== "claimed") return null;
      const { identity } = claim.attempt;
      const begun = await adapter.beginCheck({ identity, lease: claim.lease });
      if (begun.kind !== "ready") {
        await releaseForRecovery(identity.attemptId, claim.lease, begun.reason, begun.requests > 0);
        return null;
      }
      if (input.latch?.isAbandoned() === true) {
        await adoptLateCreatedRun(identity, claim.lease, begun.remote.id);
        return null;
      }
      const attached = await attachCheckRunId(
        deps.db,
        identity.attemptId,
        claim.lease,
        begun.remote.id,
        fenceFor(claim.lease).nowMs,
      );
      if (!attached) {
        await releaseForRecovery(
          identity.attemptId,
          claim.lease,
          "the check run could not be attached under this lease",
          true,
        );
        return null;
      }
      if (input.latch?.isAbandoned() === true) {
        await recordTerminalizeOutcome(deps.db, identity.attemptId, "no-handle", null).catch(() => {});
        await abandonUnterminalized(
          identity.attemptId,
          claim.lease,
          "the creating invocation was abandoned by the consumer budget after the run was attached",
          true,
        );
        return null;
      }
      return {
        attemptId: identity.attemptId,
        scope: identity.scope,
        githubAppId: identity.githubAppId,
        headSha: identity.headSha,
        lease: claim.lease,
      };
    },

    async markInProgress(input) {
      const adapter = deps.getAdapter(input.handle.scope);
      if (adapter === null) return { kind: "settled", promoted: false };
      let attempt: CheckAttempt | null;
      try {
        attempt = await getCheckAttempt(deps.db, input.handle.attemptId);
      } catch {
        return { kind: "settled", promoted: false };
      }
      if (attempt === null || attempt.terminalMs !== null) return { kind: "settled", promoted: false };
      return (
        (await adapter.markInProgress?.({
          identity: attempt.identity,
          lease: input.handle.lease,
          summary: input.summary,
          updateBudgetMs: input.updateBudgetMs,
          warn: input.warn,
        })) ?? { kind: "settled", promoted: false }
      );
    },

    async settleSkipped(input) {
      const adapter = deps.getAdapter(input.scope);
      const nowMs = deps.nowMs();
      const claimed = await claimAttachedCheckForSettlement(deps.db, {
        scope: input.scope,
        headSha: input.headSha,
        triggeredBy: input.triggeredBy,
        action: input.action,
        rerunCheckRunId: input.rerunCheckRunId,
        attachDeliveryId: input.attachDeliveryId,
        holder: `skip:${crypto.randomUUID()}`,
        executionDeadlineMs: nowMs + CHECK_LEASE_MS,
        nowMs,
      });
      if (claimed === null) return false;
      const { identity } = claimed.attempt;
      let proof: PublicationProof | null = null;
      try {
        proof = await readPublicationProof(deps.db, { scope: input.scope, headSha: input.headSha });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (!(err instanceof SyntaxError)) {
          input.warn?.(`publication proof read failed (settling nothing; left to the recovery lane): ${detail}`);
          return false;
        }
        input.warn?.(`publication proof unreadable (falling back to the persisted review): ${detail}`);
      }
      const degraded = proof !== null && proof.kind === "degraded";
      const review = degraded
        ? null
        : (proof === null
            ? null
            : await readPublishedReview(deps.db, {
                scope: input.scope,
                headSha: input.headSha,
                publicationId: proof.publicationId,
              })) ?? (await readInheritedReview(deps.db, { scope: input.scope, headSha: input.headSha }));
      const gate = review === null ? null : await deps.getCheckGate(input.scope);
      if (review !== null && gate === null) {
        input.warn?.(
          "the App's gate is unreadable from this lane — settling nothing; the recovery lane reads the real gate",
        );
        return false;
      }
      const conclusion: CheckConclusion = degraded
        ? terminalFailure("unknown-failure")
        : proof !== null || review !== null
          ? decideConclusion({
              proof: null,
              outcome: "skipped",
              gate,
              review,
              inherited: { headSha: input.headSha, reviewedHeadSha: input.headSha },
            })
          : input.paused === true
            ?
              {
                desired: "neutral",
                title: CHECK_NAME,
                summary: TERMINAL_FAILURE_TEXT.paused,
                failureStatus: "paused",
              }
            : {
                desired: "neutral",
                title: CHECK_NAME,
                summary: CHECK_SUMMARIES.skippedByDelivery(input.reason),
              };
      const intentFence = fenceFor(claimed.lease);
      if (!(await setCheckDesired(deps.db, identity.attemptId, intentFence.lease, conclusion, null, intentFence.nowMs))) {
        return false;
      }
      if (adapter === null) {
        return releaseCheckClaim(deps.db, identity.attemptId, claimed.lease, deps.nowMs());
      }
      const ownedFence = fenceFor(claimed.lease);
      const owned = await getCheckOwnership(deps.db, identity.attemptId, ownedFence.lease, ownedFence.nowMs);
      if (owned === null) return false;
      if (owned.checkRunId === null) {
        await releaseForRecovery(identity.attemptId, claimed.lease, "the skipped attempt has no attached run", false);
        return false;
      }
      const completed = await adapter.completeCheck({
        identity: owned.identity,
        lease: claimed.lease,
        checkRunId: owned.checkRunId,
        conclusion,
        updateBudgetMs: input.updateBudgetMs,
      });
      if (completed.kind !== "completed") {
        await releaseForRecovery(identity.attemptId, claimed.lease, completed.reason, completed.requests > 0);
        return false;
      }
      const observedFence = fenceFor(claimed.lease);
      return recordCheckObservation(deps.db, identity.attemptId, observedFence.lease, completed.remote, observedFence.nowMs);
    },

    async markQueuedBehindInflight(input) {
      const selectRelabelable = () =>
        markCheckQueuedBehindInflight(deps.db, {
          scope: input.scope,
          headSha: input.headSha,
          triggeredBy: input.triggeredBy,
          action: input.action,
          rerunCheckRunId: input.rerunCheckRunId,
          attachDeliveryId: input.attachDeliveryId,
          title: CHECK_NAME,
          summary: input.summary,
          nowMs: deps.nowMs(),
        });
      const relabeled = await selectRelabelable();
      if (relabeled === null) return false;
      const adapter = deps.getAdapter(input.scope);
      if (adapter === null) return false;
      const sent = await adapter.markQueuedBehindInflight?.({
        scope: input.scope,
        headSha: input.headSha,
        triggeredBy: input.triggeredBy,
        action: input.action,
        rerunCheckRunId: input.rerunCheckRunId,
        attachDeliveryId: input.attachDeliveryId,
        checkRunId: relabeled.checkRunId,
        summary: input.summary,
        updateBudgetMs: input.updateBudgetMs,
        warn: input.warn,
      });
      return sent ?? false;
    },

    async terminalize(input) {
      const { handle } = input;
      const ownPublicationId = input.publicationId ?? undefined;
      const readProof =
        input.outcome === "budget-exhausted" ||
        (ownPublicationId === undefined && input.inheritedHeadSha === undefined)
          ? null
          : await readPublicationProof(deps.db, {
              scope: handle.scope,
              headSha: handle.headSha,
              publicationId: ownPublicationId,
            });
      const proof =
        readProof !== null && ownPublicationId !== undefined && readProof.publicationId !== ownPublicationId
          ? null
          : readProof;
      const gateAndReview: readonly [ReviewGate | null, PublishedReview | null] =
        proof !== null
          ? await Promise.all([
              deps.getCheckGate(handle.scope),
              readPublishedReview(deps.db, {
                scope: handle.scope,
                headSha: handle.headSha,
                publicationId: proof.publicationId,
              }),
            ])
          : input.inheritedHeadSha === undefined
            ? [null, null]
            : await Promise.all([
                deps.getCheckGate(handle.scope),
                readInheritedReview(deps.db, {
                  scope: handle.scope,
                  headSha: input.inheritedHeadSha,
                }),
              ]);
      const [gate, review] = gateAndReview;
      const inherited =
        input.inheritedHeadSha === undefined
          ? undefined
          : { headSha: handle.headSha, reviewedHeadSha: input.inheritedHeadSha };
      const conclusion = decideConclusion({
        proof,
        outcome: input.outcome,
        gate,
        review,
        inherited,
        headSha: handle.headSha,
        ...(input.budgetExhaustion === undefined ? {} : { budgetExhaustion: input.budgetExhaustion }),
      });
      const intentFence = fenceFor(handle.lease);
      const frozen = await setCheckDesired(
        deps.db,
        handle.attemptId,
        intentFence.lease,
        conclusion,
        proof !== null ? proof.publicationId : input.publicationId,
        intentFence.nowMs,
      );
      if (!frozen) return;
      const ownedFence = fenceFor(handle.lease);
      const owned = await getCheckOwnership(deps.db, handle.attemptId, ownedFence.lease, ownedFence.nowMs);
      if (owned === null) return;
      const attemptId = owned.identity.attemptId;
      const checkRunId = owned.checkRunId;
      if (checkRunId === null) {
        await releaseForRecovery(attemptId, fenceFor(handle.lease).lease, "no remote check run attached to this attempt", true);
        return;
      }
      const adapter = deps.getAdapter(handle.scope);
      if (adapter === null) {
        await releaseForRecovery(attemptId, fenceFor(handle.lease).lease, "no Checks surface for this App", true);
        return;
      }
      const completed = await adapter.completeCheck({
        identity: owned.identity,
        lease: fenceFor(handle.lease).lease,
        checkRunId,
        conclusion,
        updateBudgetMs: input.updateBudgetMs,
      });
      if (completed.kind === "completed") {
        const observedFence = fenceFor(handle.lease);
        await recordCheckObservation(deps.db, attemptId, observedFence.lease, completed.remote, observedFence.nowMs, {
          conclusionUnproven: proof === null,
        });
        return;
      }
      await releaseForRecovery(attemptId, fenceFor(handle.lease).lease, completed.reason, completed.requests > 0);
    },

    async abandonTerminalize(input) {
      const { handle } = input;
      const conclusion: CheckConclusion =
        input.outcome === undefined
          ? terminalFailure("unknown-failure")
          : decideConclusion({
              proof: null,
              outcome: input.outcome,
              gate: input.inheritedHeadSha === undefined ? null : await deps.getCheckGate(handle.scope),
              review:
                input.inheritedHeadSha === undefined
                  ? null
                  : await readInheritedReview(deps.db, { scope: handle.scope, headSha: input.inheritedHeadSha }),
              ...(input.inheritedHeadSha === undefined
                ? {}
                : { inherited: { headSha: handle.headSha, reviewedHeadSha: input.inheritedHeadSha } }),
              headSha: handle.headSha,
              ...(input.budgetExhaustion === undefined ? {} : { budgetExhaustion: input.budgetExhaustion }),
            });
      const fence = fenceFor(handle.lease);
      await setCheckFallbackDesired(deps.db, handle.attemptId, fence.lease, conclusion, fence.nowMs);
      return releaseForRecovery(
        handle.attemptId,
        fence.lease,
        input.reason,
        true,
        input.firstRecoveryDelayMs,
      );
    },
  };
}
