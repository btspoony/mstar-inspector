/**
 * GitHub Checks adapter (spec review-lifecycle §7.9).
 *
 * One advisory Check per review attempt: created `in_progress` at the
 * authoritative head SHA and terminalized from PERSISTED publication proof.
 * The adapter is the only place a Check HTTP request is built, and it builds no
 * credential: the client comes from `src/pipeline/comment.ts`'s single per-App
 * `createAppAuth` path through the SAME purpose-scoped `review-write` octokit
 * (spec §7.6 — the `checks: "write"` grant rides that one permission set; there
 * is no second token, client or auth object).
 *
 * Contract boundaries the rest of the pipeline depends on:
 *
 *   - `beginCheck` sends `name`, `head_sha`, `external_id` and a status, and
 *     NEVER `details_url` (spec §7.9: "omit details_url entirely" — there is no
 *     Inspector destination, and RL-12 forbids inventing one).
 *   - A missing Checks surface, a 403/404 permission rejection, and any API or
 *     transport failure all return `{ kind: "unavailable", reason, requests }`.
 *     `requests` is the NUMBER of Checks calls this lane actually invoked: `0`
 *     for every refusal taken before the callable ran (unowned attempt, missing
 *     surface/client, an expired lease fence), `1` once it was answered or lost
 *     — the recovery lane's create-versus-adopt gate. The
 *     adapter never throws: Check failure must not block or delay publication
 *     (D3/RL-3), and `unavailable` changes recovery bookkeeping only — never
 *     the attempt's `desired` or `observed`.
 *   - Ownership is proven from PERSISTED state immediately before a send
 *     (`getCheckOwnership`) plus the identity fields on the response.
 *     `beginCheck` refuses an attempt that already owns a run; `completeCheck`
 *     refuses a run id this attempt did not persist, refuses `in_progress` by
 *     type, and never accepts a caller-chosen arbitrary check id.
 *   - `adoptCheckRun` matches ONLY on the persisted `external_id`, the owning
 *     `app.id`, `head_sha` and the exact run name, across at most two
 *     `filter: "all"` pages of `listForRef`. Zero exact matches after a
 *     complete walk is `absent`; a saturated walk, a malformed candidate or two
 *     distinct matches is `incomplete`/`ambiguous` — never `absent`, because
 *     GitHub caps `listForRef` at the 1000 most recent check suites on a ref.
 *   - `decideConclusion` reads PERSISTED proof, never a code path. A confirmed
 *     normal publication is `success` for every engine verdict: execution
 *     completion, not approval and not a merge gate.
 */

import type { D1Like } from "../store/types";
import {
  attachCheckRunId,
  CHECK_BACKOFF_MS,
  CHECK_NAME,
  claimAttempt,
  deferCheckRecovery,
  readPublicationProof,
  recordCheckObservation,
  rollbackCheckCreateDispatch,
  setCheckCreateState,
  setCheckDesired,
  type CheckAttempt,
  type CheckConclusion,
  type CheckIdentity,
  type CheckOwnership,
  type CheckRemote,
  type Lease,
  type PublicationProof,
  type Scope,
  getCheckAttempt,
  getCheckOwnership,
} from "../store/review-checks";
import { redactSecrets } from "./redact";

// ---------------------------------------------------------------------------
// Transport seam (spec §7.6: one credential path; §7.9: typed responses)
// ---------------------------------------------------------------------------

/** A check-run payload as the installed octokit types deliver it. */
export type CheckRunPayload = {
  id: number | bigint;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  app: { id: number | bigint } | null;
};

export type ChecksCreateParams = {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  external_id: string;
  status: "in_progress";
};

export type ChecksUpdateParams = {
  owner: string;
  repo: string;
  check_run_id: number;
  status: "completed";
  conclusion: CheckConclusion["desired"];
  title: string;
  summary: string;
};

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
      update(params: ChecksUpdateParams): Promise<{ data: CheckRunPayload }>;
      get(params: { owner: string; repo: string; check_run_id: number }): Promise<{ data: CheckRunPayload }>;
      listForRef(params: ChecksListParams): Promise<{ data: ChecksListPage }>;
    };
  };
};

// ---------------------------------------------------------------------------
// Remote evidence helpers
// ---------------------------------------------------------------------------

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
  if (payload.app === null || payload.app === undefined) {
    return {
      id,
      name: payload.name,
      head_sha: payload.head_sha,
      external_id: payload.external_id,
      status: payload.status,
      conclusion: payload.conclusion,
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

// ---------------------------------------------------------------------------
// Dependencies and adapter shape
// ---------------------------------------------------------------------------

export type ChecksDeps = {
  /** The journal/registry D1 face — proof and ownership are persisted state. */
  db: D1Like;
  /**
   * The per-App review-write octokit for the exact App installation and
   * repository (spec §7.6), supplied by `createReviewCommenter` so Checks share
   * the single `createAppAuth` construction point and its token cache.
   * null = no GitHub mutation (missing/disabled App, identity disagreement,
   * denial); every operation then reports `unavailable`.
   */
  getOctokit(input: { scope: Scope }): Promise<ChecksOctokit | null>;
  /**
   * The transaction clock (spec §7.0). Every ownership read and remote send
   * fences on `lease_until_ms > now`, so the adapter must be handed the
   * caller's current time rather than trusting a lease object it was given —
   * an expired holder may not create or update a remote Check merely because
   * recovery has not yet bumped the epoch (spec §7.9).
   */
  nowMs: () => number;
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
  }): Promise<
    | { kind: "completed"; remote: CheckRemote }
    | { kind: "unavailable"; reason: string; requests: number }
  >;
  /** Read-only GET + identity proof: the recovery lane's confirmation path (§7.11.2 step 3). */
  fetchCheckRun(input: {
    identity: CheckIdentity;
    checkRunId: number;
  }): Promise<
    { kind: "found"; remote: CheckRemote } | { kind: "absent" } | { kind: "unavailable"; reason: string }
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

/**
 * The one network request each send lane issues, so a refusal can report
 * whether the API was actually contacted (an `unavailable` that never sent
 * leaves nothing possibly-created on GitHub). A typed pre-dispatch refusal
 * reports `0`; EVERY other rejection — including one whose cause chain we
 * cannot classify — reports `1`, because "we cannot prove it was not sent" is
 * exactly the case that must stay adopt-only.
 */
function sendRequests<T>(promise: Promise<T>): Promise<{ sent: number; outcome: T | { failure: unknown } }> {
  return promise.then(
    (outcome) => ({ sent: 1, outcome }),
    (failure: unknown) => ({ sent: isRequestNotDispatched(failure) ? 0 : 1, outcome: { failure } }),
  );
}

/** Adoption walk bounds (spec §7.9: "max 2 pages", per_page 100). */
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
    fetchCheckRun: (input) => fetchCheckRunWith(deps, input),
  };
}

/**
 * Create the in-progress run for an attempt this invocation holds (spec §7.9
 * "Create/adopt"): prove the persisted row still belongs to this identity and
 * live lease, prove no run is attached yet, then send `external_id` with NO
 * `details_url`. A response failing the identity check is `unavailable` — an
 * unprovable create is never adopted, and the attempt stays `unknown` for
 * read-only recovery rather than blind re-creation.
 */
async function beginCheckWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity; lease: Lease },
): Promise<{ kind: "ready"; remote: CheckRemote } | { kind: "unavailable"; reason: string; requests: number }> {
  const nowMs = deps.nowMs();
  const owned = await guardOwnership(deps, input.identity, input.lease, nowMs);
  if (owned.kind === "unavailable") return owned;
  // Route on the PERSISTED scope, never the caller's (spec §7.6): the lease may
  // be valid while the supplied scope points at another installation/repo.
  const identity = owned.data.identity;
  if (owned.data.checkRunId !== null) {
    return refused("attempt already owns a remote check run");
  }
  // A create is legal ONLY from a definitive pre-send state (spec §7.9/RL-12):
  // `sending`/`unknown` mean a create may already have reached GitHub, and
  // since `external_id` is correlation rather than server-side idempotency, the
  // only honest recovery is bounded read-only adoption — never a second create.
  if (owned.data.createState !== "not-sent") {
    return refused(`create is not definitively unsent (create_state=${owned.data.createState}); adopt instead`);
  }
  // Resolve the client BEFORE any durable claim of a send: with no client
  // nothing has been attempted, so the row must stay `not-sent` (an honest
  // `sending` mark here would strand the attempt as possibly-sent forever).
  const client = await clientFor(deps, identity.scope);
  if (client === null) return refused("no review-write Checks client for this App");
  // Preflight the EXACT callable before recording anything (a surface can exist
  // while `create` is missing on an older/foreign client). A missing method is
  // a definitive pre-send refusal: the row must keep its honest `not-sent`
  // state rather than be marked as a create that could never have left.
  if (!hasChecksMethod(client, "create")) {
    return refused("Checks surface has no callable create method");
  }
  // Persist `sending` BEFORE the request leaves (spec §7.9): if the response is
  // lost, the row must already record that a create was attempted, because that
  // durable fact is what stops a later `beginCheck` from minting a second run.
  // Fenced on the live lease, so a lease lost between the guard and here aborts
  // the send instead of creating an unattributable run.
  const marked = await setCheckCreateState(deps.db, identity.attemptId, input.lease, "sending", undefined, nowMs);
  if (!marked) {
    return refused("could not record the create attempt under this lease");
  }
  // Client resolution minted a token and awaited the network; the lease may
  // have expired meanwhile WITHOUT an epoch takeover. Re-sample the clock and
  // re-prove the live lease immediately before the request: the earlier
  // snapshot authorised the decision, not the send itself (spec §7.9).
  if (!(await stillLive(deps, identity, input.lease))) {
    // Nothing was invoked, so the `sending` mark above now MISSTATES the row
    // (`requests: 0`). Undo it under an identity fence — this is exactly the
    // path where a liveness fence would be false — so the attempt does not sit
    // in the RL-12 adopt-only state with no request behind it. A lost race
    // leaves `sending` in place, which stays conservative: recovery then adopts
    // rather than creating again.
    await rollbackCheckCreateDispatch(deps.db, identity.attemptId, input.lease, nowMs);
    return refused("lease expired before the create request");
  }
  const { scope } = identity;
  const attempted = await sendRequests(
    client.rest.checks.create({
      owner: scope.owner,
      repo: scope.repo,
      name: CHECK_NAME,
      head_sha: identity.headSha,
      external_id: identity.externalId,
      status: "in_progress",
    }),
  );
  if ("failure" in attempted.outcome) {
    if (attempted.sent === 0) {
      // The transport refused BEFORE dispatch (a typed pre-dispatch marker), so
      // the `sending` mark above now MISSTATES the row: nothing left the
      // process. Undo it under the identity fence — this is exactly the path
      // where a liveness fence would be false — so the attempt does not sit in
      // the RL-12 adopt-only state with no request behind it. A lost race
      // leaves `sending` in place, which stays conservative.
      await rollbackCheckCreateDispatch(deps.db, identity.attemptId, input.lease, nowMs);
    }
    return { kind: "unavailable", requests: attempted.sent, reason: surfaceFailure(attempted.outcome.failure, "check create") };
  }
  const remote = toCheckRemote(attempted.outcome.data);
  // A malformed or foreign response is still a REQUEST: the run may exist on
  // GitHub, so recovery must adopt rather than create again.
  if (remote === null) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check create returned a malformed payload" };
  }
  if (!remoteBelongsTo(remote, identity)) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check create response does not match this attempt identity" };
  }
  return { kind: "ready", remote };
}

/**
 * Find the run this attempt's persisted `external_id` already created (spec
 * §7.9). Read-only by design: no create, no update, no state write — GitHub's
 * `external_id` is correlation, not server-side idempotency (RL-12), so the
 * only honest answer to "did my create land?" is an identity-matched read.
 */
async function adoptCheckRunWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity },
): Promise<
  { kind: "found"; remote: CheckRemote } | { kind: "absent" | "incomplete" | "ambiguous" }
> {
  // Adoption is read-only, but it is still an operation ON a persisted
  // attempt: resolve the stored identity first and target the stored scope, so
  // a caller cannot use it to probe another installation/repository (§7.9).
  const persisted = await persistedIdentity(deps, input.identity);
  if (persisted.kind === "unavailable") return { kind: "incomplete" };
  const identity = persisted.identity;
  const client = await clientFor(deps, identity.scope);
  if (client === null) return { kind: "incomplete" };
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
      // An errored walk proves nothing about presence or absence.
      return { kind: "incomplete" };
    }
    const runs = result?.data?.check_runs;
    if (!Array.isArray(runs)) return { kind: "incomplete" };
    for (const payload of runs) {
      const remote = toCheckRemote(payload);
      // A malformed candidate inside the App/name/SHA window makes the walk
      // ambiguous: skipping it could silently drop OUR run.
      if (remote === null) return { kind: "ambiguous" };
      if (remoteBelongsTo(remote, identity)) matches.push(remote);
    }
    if (matches.length > 1) return { kind: "ambiguous" };
    saturated = runs.length >= ADOPT_PAGE_SIZE;
    // A NON-saturated page exhausts the candidate set: the walk is complete, so
    // a single match is now provably unique and the absence of one is provable.
    // Returning `found` from a SATURATED page would be a claim about an
    // incomplete set — an unobserved duplicate on page 2 (a `Re-run` UI action,
    // a server-side anomaly) would then be treated as ours and terminalized
    // while the reachable second page was never read (spec §7.9: "Multiple/
    // incomplete candidates remain unknown").
    if (!saturated) {
      return matches.length === 1 ? { kind: "found", remote: matches[0]! } : { kind: "absent" };
    }
  }
  // The bound was reached while the pages were still saturated (spec §7.9:
  // "listForRef also caps at the 1000 most recent suites on a ref"), and
  // `ADOPT_MAX_PAGES` is all the honesty this lane may spend. Uniqueness is
  // NOT proven for a single match either, so the answer stays incomplete.
  return { kind: "incomplete" };
}

/**
 * Terminalize an owned run with a frozen conclusion (spec §7.9 "Desired versus
 * observed"): prove persisted ownership of the lease AND of `checkRunId`,
 * require the persisted terminal intent to agree with what is being sent (the
 * store freezes `desired` BEFORE any update), then validate the response's
 * identity and terminal state. Only a validated response lets the caller
 * advance `observed`.
 */
async function completeCheckWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity; lease: Lease; checkRunId: number; conclusion: CheckConclusion },
): Promise<{ kind: "completed"; remote: CheckRemote } | { kind: "unavailable"; reason: string; requests: number }> {
  const owned = await guardOwnership(deps, input.identity, input.lease, deps.nowMs());
  if (owned.kind === "unavailable") return owned;
  const identity = owned.data.identity;
  // The persisted row must already carry THIS terminal intent: `desired` is
  // frozen by `setCheckDesired` before any update (spec §7.9), so an
  // `in_progress` row here means the caller skipped the intent write. The
  // parameter type already excludes `in_progress`, so no send can carry it.
  if (owned.data.desired === "in_progress") {
    return refused("terminal intent was never persisted for this attempt");
  }
  // The FROZEN text is what ships (spec §7.9): the update carries the persisted
  // conclusion, title and summary, never the caller's copies. A caller that
  // mutates or enlarges the text between freezing the intent and completing the
  // run therefore cannot diverge from what was bounded and stored — and cannot
  // push an oversized/unredacted title into the public Check surface.
  const frozen = {
    desired: owned.data.desired as CheckConclusion["desired"],
    title: owned.data.desiredTitle,
    summary: owned.data.desiredSummary,
  };
  if (frozen.title === null || frozen.summary === null) {
    return refused("persisted terminal intent carries no frozen title/summary");
  }
  if (frozen.desired !== input.conclusion.desired) {
    return refused("conclusion does not match the persisted terminal intent");
  }
  if (owned.data.checkRunId !== input.checkRunId) {
    return refused("check run id is not the one this attempt persisted");
  }
  const client = await clientFor(deps, identity.scope);
  if (client === null) return refused("no review-write Checks client for this App");
  if (!hasChecksMethod(client, "update")) {
    return refused("Checks surface has no callable update method");
  }
  // Same fresh live-lease proof as the create path: token minting and client
  // resolution can cross `lease.untilMs`, and an expired holder must not
  // terminalize a remote run (spec §7.9).
  if (!(await stillLive(deps, identity, input.lease))) {
    return refused("lease expired before the update request");
  }
  const { scope } = identity;
  const attempted = await sendRequests(
    client.rest.checks.update({
      owner: scope.owner,
      repo: scope.repo,
      check_run_id: input.checkRunId,
      status: "completed",
      conclusion: frozen.desired,
      title: frozen.title,
      summary: frozen.summary,
    }),
  );
  if ("failure" in attempted.outcome) {
    return { kind: "unavailable", requests: attempted.sent, reason: surfaceFailure(attempted.outcome.failure, "check update") };
  }
  const remote = toCheckRemote(attempted.outcome.data);
  // An unprovable response is still a REQUEST: the update may have landed, so
  // `observed` stays untouched and the attempt defers to recovery.
  if (remote === null) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update returned a malformed payload" };
  }
  if (!remoteBelongsTo(remote, identity)) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update response does not match this attempt identity" };
  }
  if (remote.status !== "completed" || remote.conclusion !== frozen.desired) {
    return { kind: "unavailable", requests: attempted.sent, reason: "check update response is not the intended terminal state" };
  }
  return { kind: "completed", remote };
}

/**
 * Read one run back and prove it belongs to this attempt (spec §7.11.2 step 3:
 * "If ID known, GET/validate ownership before update"). `absent` = the remote
 * object is gone (404 or foreign identity); anything else is `unavailable`.
 */
async function fetchCheckRunWith(
  deps: ChecksDeps,
  input: { identity: CheckIdentity; checkRunId: number },
): Promise<
  { kind: "found"; remote: CheckRemote } | { kind: "absent" } | { kind: "unavailable"; reason: string }
> {
  const persisted = await persistedIdentity(deps, input.identity);
  if (persisted.kind === "unavailable") return persisted;
  const identity = persisted.identity;
  const client = await clientFor(deps, identity.scope);
  if (client === null) return { kind: "unavailable", reason: "no review-write Checks client for this App" };
  const { scope } = identity;
  try {
    const { data } = await client.rest.checks.get({
      owner: scope.owner,
      repo: scope.repo,
      check_run_id: input.checkRunId,
    });
    const remote = toCheckRemote(data);
    if (remote === null) return { kind: "unavailable", reason: "check get returned a malformed payload" };
    if (remote.id !== input.checkRunId) return { kind: "unavailable", reason: "check get returned a different run" };
    return remoteBelongsTo(remote, identity) ? { kind: "found", remote } : { kind: "absent" };
  } catch (error) {
    if (httpStatus(error) === 404) return { kind: "absent" };
    return { kind: "unavailable", reason: surfaceFailure(error, "check get") };
  }
}

/**
 * A send-lane refusal that provably never reached the API. `guardOwnership`
 * and every pre-dispatch branch funnel through here so the additive
 * `requests: number` contract cannot drift into an `undefined` count: an
 * unowned attempt, a missing callable and a refusal BEFORE the request all
 * report `0`, and only the lanes that actually invoked the callable report a
 * positive count (see `sendRequests`).
 */
function refused(reason: string): { kind: "unavailable"; reason: string; requests: 0 } {
  return { kind: "unavailable", reason, requests: 0 };
}

/**
 * The persisted-ownership read every send shares, behind the same never-throw
 * rule: a D1 read failure is `unavailable`, not an exception into the review.
 */
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

/**
 * Exact identity agreement between a caller-supplied identity and the PERSISTED
 * row (spec §7.6/§7.9). Every routing component is compared, not just the check
 * fields: a caller holding a valid lease but presenting a different
 * installation, owner, repository, PR, App row or SHA must not be able to aim
 * the purpose-scoped client — or an adoption read — at another tenant's scope.
 */
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

/**
 * The PERSISTED identity of an attempt, read without a lease (the read-only
 * lanes' entry point) or `null` when the row is gone. Adoption and fetch are
 * read-only, so they cannot present a lease — but they must still answer for
 * the stored attempt, never for a caller-supplied scope (spec §7.9).
 */
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

/**
 * The exact callable a lane is about to use. A structural surface can be
 * present while a method is missing (an older client, a partial double, a
 * foreign object), and calling it would throw — which would look like a
 * possibly-lost send instead of the definitive pre-send refusal it is.
 */
function hasChecksMethod(client: ChecksOctokit, method: "create" | "update" | "get" | "listForRef"): boolean {
  const surface = client?.rest?.checks as Record<string, unknown> | undefined;
  return typeof surface?.[method] === "function";
}

/**
 * Re-prove the live lease against a FRESH clock reading, immediately before a
 * remote request. Fails closed on a D1 read error: an unprovable lease is not
 * an authorised send.
 */
async function stillLive(deps: ChecksDeps, identity: CheckIdentity, lease: Lease): Promise<boolean> {
  try {
    return (await getCheckOwnership(deps.db, identity.attemptId, lease, deps.nowMs())) !== null;
  } catch {
    return false;
  }
}

/** Client resolution — a null or throwing transport is `unavailable`, never a throw. */
async function clientFor(deps: ChecksDeps, scope: Scope): Promise<ChecksOctokit | null> {
  try {
    return await deps.getOctokit({ scope });
  } catch {
    return null;
  }
}

/**
 * Map an octokit rejection to a bounded reason. 403/404 are the permission
 * answers the fresh-App manifest owes (spec §7.12); every other status or a
 * non-Error rejection is still only `unavailable` — Check failure never aborts
 * a review (RL-3).
 */
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

/** Redacted, bounded error text — a transport message may carry a URL or token. */
function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).replace(/[\r\n]+/g, " ").slice(0, 240);
}

// ---------------------------------------------------------------------------
// Conclusions (spec §7.9 matrix)
// ---------------------------------------------------------------------------

/** The execution-completion disclaimer (D3/RL-10: a Check is never approval). */
const SUCCESS_SUFFIX = "Execution completion only; not code approval or a merge gate.";

/** Frozen summaries, exactly as spec §7.9's matrix spells them. */
export const CHECK_SUMMARIES = {
  success: (sha7: string, round: number) => `Review published for ${sha7} (round ${round}). ${SUCCESS_SUFFIX}`,
  neutral: "Review output was invalid; a degraded summary comment was published.",
  prePublicationFailure: (reason: string) =>
    `Review execution failed before publication: ${reason}. No review was published.`,
  degradedNotPosted: "Review output was invalid and the degraded notice was not published.",
  unconfirmed: "Review attempt could not be confirmed complete; publication status is unknown.",
  exhausted: "Finalization could not be confirmed. Manual inspection may be required.",
} as const;

/** What the caller knows about execution, alongside the persisted proof. */
export type CheckTerminalOutcome =
  | "pre-publication-failure"
  | "degraded-not-posted"
  | "publication-unknown"
  | "expired"
  | "local-error";

/**
 * Decide the Check conclusion from spec §7.9's matrix:
 *
 * | persisted proof / knowledge                     | desired |
 * |-------------------------------------------------|---------|
 * | confirmed normal (`review`) publication          | success |
 * | confirmed degraded publication                   | neutral |
 * | definitive failure before any publication send   | failure |
 * | degraded send rejected, no earlier unknown send  | failure |
 * | any send with unconfirmed result                 | failure |
 * | expired attempt without proof                    | failure |
 * | recovery exhausted                               | proof-derived desired, else failure |
 *
 * Proof precedence (normal over degraded within the exact scope/SHA) lives in
 * `readPublicationProof`, which the caller uses to obtain `proof`; this
 * function trusts what it is handed and reads `kind` alone. A `null` proof is
 * UNPROVEN — which is not the same as "not published", and is why an unknown
 * outcome must conclude `failure` rather than guess.
 */
export function decideConclusion(input: {
  proof: PublicationProof | null;
  outcome: CheckTerminalOutcome;
  reason?: string;
}): CheckConclusion {
  const { proof, outcome } = input;
  if (proof !== null) {
    return proof.kind === "review"
      ? {
          desired: "success",
          title: CHECK_NAME,
          summary: CHECK_SUMMARIES.success(proof.headSha.slice(0, 7), proof.round),
        }
      : { desired: "neutral", title: CHECK_NAME, summary: CHECK_SUMMARIES.neutral };
  }
  if (outcome === "local-error") {
    return { desired: "failure", title: CHECK_NAME, summary: CHECK_SUMMARIES.exhausted };
  }
  if (outcome === "pre-publication-failure") {
    return {
      desired: "failure",
      title: CHECK_NAME,
      summary: CHECK_SUMMARIES.prePublicationFailure(boundedReason(input.reason)),
    };
  }
  if (outcome === "degraded-not-posted") {
    return { desired: "failure", title: CHECK_NAME, summary: CHECK_SUMMARIES.degradedNotPosted };
  }
  // publication-unknown and expired-without-proof are both unconfirmed.
  return { desired: "failure", title: CHECK_NAME, summary: CHECK_SUMMARIES.unconfirmed };
}

/** Bounded, redacted failure text — a public Check summary must not leak a token. */
function boundedReason(reason: string | undefined): string {
  const text = reason === undefined || reason.trim().length === 0 ? "unknown pipeline failure" : reason;
  return redactSecrets(text).replace(/[\r\n]+/g, " ").slice(0, 240);
}

// ---------------------------------------------------------------------------
// Lifecycle seam implementation (spec §7.10 hooks / §7.7 4+12)
// ---------------------------------------------------------------------------

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
  /** The transaction clock (spec §7.0) — re-read immediately before each fenced write. */
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
    executionDeadlineMs: number;
    /**
     * OPTIONAL per-invocation abandonment latch owned by the caller. When the
     * caller's §7.10 budget elapses it trips `abandon()`, and this `begin` then
     * stops attaching a created run on behalf of a caller that is gone —
     * leaving the attempt with a terminal obligation instead (see
     * `abandonUnterminalized`). Omitted → this invocation is never abandoned,
     * which is the non-consumer (test/recovery) default.
     */
    latch?: CheckBeginLatch;
  }): Promise<CheckLifecycleHandle | null>;
  terminalize(input: {
    handle: CheckLifecycleHandle;
    publicationId: string | null;
    outcome: CheckTerminalOutcome;
  }): Promise<void>;
};

/**
 * The production §7.10 lifecycle.
 *
 * `begin` maps the seam input onto a FENCED attempt: an ineligible App (no
 * Checks surface) registers nothing, `claimAttempt` is the one race-decided
 * insert, and only a create whose response proved the attempt's identity is
 * attached to the row before the handle is returned. `busy` (a nonterminal
 * attempt owns the key — duplicate delivery included) and `terminal` (a
 * generation already ended with a PROVEN publication) both yield `null`: no
 * second row, no second remote run.
 *
 * `terminalize` decides from PERSISTED proof, never from the code path that
 * called it: the proof is read by exact App/scope/SHA with this attempt's
 * publication id preferred, `setCheckDesired` freezes that intent BEFORE the
 * one bounded remote update, and `observed` advances ONLY from a response the
 * adapter validated. Every write is fenced on the handle's live lease, so a
 * stale/lost holder writes nothing — and the attempt stays recoverable
 * (`pending`/`remote-unconfirmed` + backoff) for the scheduled lane, never
 * blocking or delaying the review.
 */
export function createCheckLifecycle(deps: CheckLifecycleDeps): CheckLifecycle {
  /**
   * The fence for ONE fenced mutation: the lease this invocation holds, with a
   * clock sampled at this instant. Every fenced store call re-reads the clock
   * here, so a lease that expired while an asynchronous proof/attempt/client
   * read was in flight refuses the write (spec §7.9: all local updates require
   * `lease_until_ms > now`) — a clock captured before such a read cannot
   * authorise a mutation that lands after it.
   */
  const fenceFor = (lease: Lease): { lease: Lease; nowMs: number } => ({ lease, nowMs: deps.nowMs() });

  /**
   * A lease carried by an invocation the CONSUMER has already abandoned (the
   * §7.10 two-second hook budget elapsed). A refused attach or unavailable send
   * must not leave such an attempt holding a lease nothing will terminalize:
   * the recovery lane would not select it until its execution deadline (the
   * integrated claim still requires `desired <> 'in_progress' OR
   * execution_deadline_ms <= now`). The attempt is therefore released NOW with
   * an explicit terminalized intent, so recovery is due after the first backoff
   * rung instead of up to fifteen minutes later — identity, the attached run id
   * and any sent-request truth are all preserved.
   *
   * Both the release and the intent write are fenced on the live lease, so an
   * attempt whose lease has genuinely expired is untouched by this path — its
   * own expiry is what the deadline rule already covers. A refused-marker
   * failure when no request was dispatched is the exception: the lease is
   * provably dead in that case, and the identity fence is the honest one.
   */
  const abandonUnterminalized = async (
    identity: CheckIdentity,
    lease: Lease,
    reason: string,
    requestsSpent: boolean,
  ): Promise<void> => {
    const fence = fenceFor(lease);
    const frozen = await setCheckDesired(
      deps.db,
      identity.attemptId,
      fence.lease,
      {
        desired: "failure",
        title: CHECK_NAME,
        summary: CHECK_SUMMARIES.unconfirmed,
      },
      null,
      fence.nowMs,
    );
    if (frozen) {
      await releaseForRecovery(identity.attemptId, fence.lease, reason, requestsSpent);
      return;
    }
    if (!requestsSpent) {
      // No request was dispatched, so nothing may exist remotely: the
      // identity-fenced release is the correct one even though the lease is
      // dead (that is exactly why the intent write above refused).
      await releaseForRecovery(identity.attemptId, fence.lease, reason, false);
    }
  };

  /**
   * Hand an attempt to the recovery lane: release the lease and record the
   * honest state + backoff. `requestsSpent` is the caller's knowledge that a
   * remote request was already issued (or may have been) for this attempt:
   * such a row is `remote-unconfirmed` so recovery adopts instead of blindly
   * creating, otherwise it is `pending`. The clock is sampled for THIS write.
   */
  const releaseForRecovery = async (
    attemptId: string,
    lease: Lease,
    reason: string,
    requestsSpent: boolean,
  ): Promise<void> => {
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
  };

  /**
   * Record the run a cancelled invocation created, then hand the attempt to
   * recovery. The id is attached first — the durable fact recovery needs to
   * ADOPT this run instead of creating a second one — and the terminal intent
   * plus the released lease make the row due after the first backoff rung
   * rather than at the execution deadline. Every write is fenced on the live
   * lease: if the lease died while the create ran, the attach is refused and
   * the row keeps exactly what the adapter persisted (`sending` for the
   * adopt-only state the deadline rule already covers).
   */
  const adoptLateCreatedRun = async (identity: CheckIdentity, lease: Lease, remoteId: number): Promise<void> => {
    const fence = fenceFor(lease);
    if (!(await attachCheckRunId(deps.db, identity.attemptId, fence.lease, remoteId, fence.nowMs))) return;
    await abandonUnterminalized(identity, lease, "the creating invocation was abandoned by the consumer budget", true);
  };

  return {
    async begin(input) {
      // Eligibility BEFORE the claim (L2-accepted): an App whose commenter
      // exposes no Checks surface is ineligible outright — no registry row is
      // created for an attempt nothing could ever drive, and no lease is taken.
      const adapter = deps.getAdapter(input.scope);
      if (adapter === null) return null;
      // The claim INSERT establishes ownership, so no lease exists to fence on
      // yet; the clock is sampled for this write.
      const claim = await claimAttempt(deps.db, {
        scope: input.scope,
        githubAppId: input.githubAppId,
        headSha: input.headSha,
        triggeredBy: input.triggeredBy,
        action: input.action,
        holder: `consumer:${crypto.randomUUID()}`,
        nowMs: deps.nowMs(),
        executionDeadlineMs: input.executionDeadlineMs,
      });
      // busy = a nonterminal attempt already owns this key (a duplicate
      // delivery's second pass included); terminal = a generation of this key
      // already ended with a proven publication. Either way: no Check here.
      if (claim.kind !== "claimed") return null;
      const { identity } = claim.attempt;
      const begun = await adapter.beginCheck({ identity, lease: claim.lease });
      if (begun.kind !== "ready") {
        await releaseForRecovery(identity.attemptId, claim.lease, begun.reason, begun.requests > 0);
        return null;
      }
      // The consumer's §7.10 budget may already have elapsed while this create
      // ran. Its wait is bounded (publication is never delayed by a Check), so
      // the honest response is to stop attaching and leave the created run to
      // the recovery lane with a terminal obligation instead of a fifteen-minute
      // wait for the execution deadline. The check reads THIS call's own latch —
      // never ambient state — so a later message can neither un-abandon this
      // begin nor observe its abandonment. The attempt keeps its identity and
      // the run id this invocation just proved, so recovery ADOPTS rather than
      // creating a second run (RL-12).
      if (input.latch?.isAbandoned() === true) {
        await adoptLateCreatedRun(identity, claim.lease, begun.remote.id);
        return null;
      }
      // The run is OURS only once its id is attached under a lease this
      // invocation still holds: a create that awaited a token mint and the
      // network may have outlived it, and then we own nothing (the create stays
      // `sending` for read-only adoption, never a blind second create).
      const attached = await attachCheckRunId(
        deps.db,
        identity.attemptId,
        claim.lease,
        begun.remote.id,
        fenceFor(claim.lease).nowMs,
      );
      if (!attached) {
        // The invocation still owns the claim but cannot prove the run, so the
        // attempt is handed to recovery (a create WAS sent — possibly two, if a
        // concurrent writer attached first) instead of holding a lease nobody
        // will terminalize. A dead lease makes this a no-op by fence.
        await releaseForRecovery(
          identity.attemptId,
          claim.lease,
          "the check run could not be attached under this lease",
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

    async terminalize(input) {
      const { handle } = input;
      // PROOF decides (spec §7.9): exact App/scope/SHA, this attempt's
      // publication id preferred. `null` is UNPROVEN — never "not published" —
      // which is why an unconfirmed send must conclude `failure`, not success.
      const proof = await readPublicationProof(deps.db, {
        scope: handle.scope,
        headSha: handle.headSha,
        publicationId: input.publicationId ?? undefined,
      });
      const conclusion = decideConclusion({ proof, outcome: input.outcome });
      // Freeze the boundary title/summary and the proof link BEFORE any remote
      // update, fenced on the CURRENT lease with a clock sampled for THIS write
      // (the proof read awaited D1; its pre-read clock cannot authorise it).
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
        // No remote run exists to terminalize (an attempt whose create never
        // landed). Release it with its frozen intent instead of holding this
        // lease until the execution deadline: recovery is due after backoff.
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
      });
      if (completed.kind === "completed") {
        // `observed` advances ONLY from this validated response (spec §7.9),
        // under a fence re-read for this mutation.
        const observedFence = fenceFor(handle.lease);
        await recordCheckObservation(deps.db, attemptId, observedFence.lease, completed.remote, observedFence.nowMs);
        return;
      }
      // Unavailable/unconfirmed: recovery status, error and backoff only —
      // never `desired`, never `observed`. Publication is untouched either way.
      await releaseForRecovery(attemptId, fenceFor(handle.lease).lease, completed.reason, completed.requests > 0);
    },
  };
}
