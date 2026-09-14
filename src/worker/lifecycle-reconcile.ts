/**
 * M8 publication and thread recovery reconciler (plan 67 Task 5, spec
 * review-lifecycle §7.11 composition + §7.11.1) — the self-sufficient cron
 * lane that makes crash recovery no longer lose assessments.
 *
 * Two bounded lanes per run, publication lane first with at most half the
 * run's GitHub request budget:
 *   1. Publication lane (`listPublicationRecovery`, LIMIT 10):
 *      - `confirmed` → local idempotent apply (proof-gated, NO GitHub —
 *        "after proof, local apply may proceed even if GitHub is
 *        unavailable");
 *      - `prepared` older than PREPARED_SEND_MIN_AGE_MS → read-only
 *        staleness pre-check (never a stale send over a newer round — that
 *        row is superseded), then a conditional epoch-fenced lease claim
 *        and ONE send of the exact prepared body (review or degraded
 *        chain), proof persisted before any local apply;
 *      - `sending`/`unknown` → read-only discovery only: the PR's bounded
 *        newest issue comments are scanned for the EXACT prepared body
 *        (marker + digest match, bot-suffixed author) — a hit proves the
 *        publication and applies the saved payload without the model; a
 *        miss stays unknown and defers with backoff ("never issue a blind
 *        second create").
 *   2. Thread lane (`listResolutionRecovery`, LIMIT 10): each queued
 *      association with a stored verified snapshot is re-driven through the
 *      §7.5 resolution surface (T2 — ownership proof, HEAD/conversation
 *      fences and adoption are its contract, never re-implemented here).
 *      Outcomes: resolved / abandoned (terminal), needs-recheck (stops
 *      cycling, concern retained for the next real review), retry (backoff
 *      1/2/4/8/16 min; at the 5-attempt cap a terminal, visible local-error
 *      — never deleted).
 *
 * Credential routing (spec §7.6): the EXACT `(app_id, installation_id)`
 * pair through `app_installations` into the matching `github_apps` row —
 * never a repository-wide App scan, never cross-App substitution. Missing
 * mapping, soft-deleted or disabled App → every pending row of the pair is
 * durably `suspended` (attempts untouched) and nothing calls GitHub;
 * `listSuspendedLifecycleApps` + the same exact-pair routing query re-check
 * suspension each run, and an App that re-enabled resumes with fresh
 * fencing. A paused App (review_enabled=0) keeps the frozen pause policy:
 * no NEW primary publication (prepared rows are left due), but local apply
 * of already-confirmed publications, read-only discovery and
 * previously-authorized resolution retry continue.
 *
 * Budgets (spec §7.11.1): ≤80 GitHub requests and 45s per run, ≤15 requests
 * per thread operation, each request ≤5s and capped by the remaining run
 * deadline. The per-operation envelopes are PRE-FLIGHT ADMISSION ESTIMATES
 * that decide whether an operation may start; the ACTUAL requests are what
 * the run is charged, metered at the single transport choke point every
 * request funnels through. Reserving estimates AND metering real requests
 * would double-count (a scan estimated at 3 that paginates 11 times must
 * cost 11, not 14). Budget/deadline exhaustion therefore stops a lane before
 * any claim — a claim never happens, so no attempt is spent — and a refusal
 * inside an already-claimed send releases that claim back to due `prepared`
 * rather than recording post-attempt uncertainty. The ≤5s per-request bound
 * is ENFORCED, not declared: the App's commenter is built with a bounded
 * `fetchImpl` that aborts every request (identity probe, token mint and API
 * calls alike) at `min(5s, remaining run deadline)`, so a hung request
 * cannot outlive the run. Timeout and unknown outcomes stay conservative —
 * the send is not retried blindly, the row is deferred or capped durably.
 *
 * Throw-proof: the whole function is wrapped — a recovery failure (even a
 * throwing injected dependency) is logged and folded into `errors`; nothing
 * ever throws out of `scheduled`.
 */

import type { ScheduledEnv } from "./env";
import type { Scope } from "../contracts/recheck";
import type { D1Like } from "../store/types";
import {
  applyPublishedLifecycle,
  claimPublication,
  deferPublicationRecovery,
  deferResolutionRecovery,
  getPublicationCreatedMs,
  getResolutionRecoveryRow,
  listPublicationRecovery,
  listResolutionRecovery,
  listSuspendedLifecycleApps,
  LIFECYCLE_BACKOFF_MS,
  LIFECYCLE_MAX_ATTEMPTS,
  markPublicationFailed,
  markPublicationLocalError,
  markPublicationUnknown,
  markResolutionLocalError,
  PREPARED_SEND_MIN_AGE_MS,
  recordNeedsRecheck,
  recordPublicationProof,
  reenableLifecycleForApps,
  releaseUnspentPublicationClaim,
  supersedePublication,
  suspendPublicationRecovery,
  suspendResolutionRecovery,
  type Lease,
  type PublicationRow,
} from "../store/finding-lifecycle";
import { createSecretbox } from "../dashboard/secretbox";
import { createReviewCommenter, PreparedSendRejected, type CommenterFetch, type ReviewCommenter, type UpsertPlan } from "../pipeline/comment";
import { sha256Hex } from "../pipeline/review-threads";

// ---------------------------------------------------------------------------
// Summary + budget constants (spec §7.11.1 verbatim values)
// ---------------------------------------------------------------------------

export type LifecycleReconcileSummary = {
  examined: number;
  applied: number;
  resolved: number;
  unknown: number;
  suspended: number;
  errors: number;
};

/** Whole-run GitHub request budget (§7.11.1: "≤80 requests/45s"). */
export const RECONCILE_MAX_REQUESTS = 80;
/** Whole-run wall-clock budget in ms (§7.11.1). */
export const RECONCILE_RUN_BUDGET_MS = 45_000;
/** Per-request cap (§7.11.1: "each request ≤5s"). */
export const RECONCILE_PER_REQUEST_MS = 5_000;
/** Per-thread-operation request cap (§7.11.1: "≤15 GitHub requests"). */
export const RECONCILE_THREAD_OPERATION_REQUESTS = 15;
/** The publication lane gets at most half the run budget before the thread lane. */
export const RECONCILE_PUBLICATION_LANE_MAX_REQUESTS = 40;
/** Bounded selection per lane (§7.11.1: LIMIT 10). */
export const RECONCILE_SELECT_LIMIT = 10;
/**
 * Conservative, non-mutating preflight admission estimates for the
 * publication lane's operations (plan, send, read-only discovery).
 * `canSpend` consults them only to decide whether an operation may start;
 * they are NOT reservations and are never charged — the transport meters
 * every ACTUAL request (§7.11.1), and charging an estimate on top would
 * double-count a paginating scan.
 */
const PLAN_REQUESTS = 1;
const SEND_REQUESTS = 2;
const DISCOVERY_REQUESTS = 2;
/**
 * The §7.5 live App-identity proof (`GET /app`) issues exactly one request
 * per App pair per run (the resolution is cached). The probe's request is
 * metered at the shared transport choke point like every other request the
 * pair issues, so it is counted under the whole-run cap; this constant is
 * only the preflight estimate the suspended-pair re-enable admission
 * consults before the pair is built. It is neither a charge nor a
 * reservation — `reviewerForPair` charges nothing and `budget.spent` is
 * mutated only by the transport's `reserve`. The estimate is accounted
 * separately from the per-thread-operation admission bound (≤15 requests of
 * the §7.5 surface itself, §7.11.1): the two gate different operations, and
 * the probe is metered once, at the transport — never double-counted.
 */
const IDENTITY_REQUESTS = 1;

/** Lease holder label for M8 recovery claims. */
const HOLDER = "lifecycle-reconcile";

// ---------------------------------------------------------------------------
// Reviewer surface — the §7.6 credential-routing seam
// ---------------------------------------------------------------------------

/**
 * The GitHub surface M8 needs. `resolveFindingThread` is T2's §7.5 adapter
 * (wired by `createReviewCommenter(env, { db })`) — the reconciler consumes
 * it; it never re-implements ownership proofs or fences.
 */
export type ReconcileReviewer = Pick<
  ReviewCommenter,
  "planReviewUpsert" | "postPreparedReview" | "postPreparedDegraded" | "listDiscussion"
> & {
  resolveFindingThread: NonNullable<ReviewCommenter["resolveFindingThread"]>;
};

/** Why a pair's credentials cannot be used (spec §7.6). */
export type ReviewerUnavailableReason = "missing" | "deleted" | "disabled" | "decrypt-failed" | "identity-mismatch";

export type ReviewerResolution =
  | { kind: "ok"; reviewer: ReconcileReviewer; paused: boolean; botLogin: string }
  | {
      kind: "unavailable";
      reason: ReviewerUnavailableReason;
      /**
       * Digest of the ENCRYPTED credential envelope this pair is suspended
       * on (§7.6 / P67-QC-007). It is not a secret (the envelope is already
       * ciphertext) and lets a later pass tell "same credentials, same
       * mismatch" from "the operator corrected the credentials" without
       * touching the network. Absent when no credential row was reachable.
       */
      credentialFingerprint?: string;
    };

/**
 * The run's transport bound, handed to the reviewer factory so every request
 * the lane issues is aborted at `min(5s, remaining run time)`. `boundMs()`
 * is read at each request, so a request issued late in the run gets only the
 * remaining time; the run deadline is the ceiling either way.
 */
export type ReconcileTransport = {
  /** Abort a single request after at most this many ms (≥1). */
  boundMs: () => number;
  /** Wrapped fetch — the ONLY transport the built reviewer may use. */
  fetchImpl: CommenterFetch;
};

/**
 * Exact `(app_id, installation_id)` credential routing (spec §7.6): the
 * routing query binds BOTH durable ids through `app_installations` into the
 * matching `github_apps` row. Missing mapping / soft-deleted / disabled →
 * `unavailable` (the reconciler suspends the pair durably); a decrypted PEM
 * builds THIS App's commenter — the only credential source, never another
 * App's. `paused` rides the ok resolution (review_enabled = 0): the frozen
 * pause policy is enforced by the lanes, not by refusing credentials.
 * `transport` carries the run's per-request bound; when supplied, the built
 * commenter (and its token mint) issues EVERY request through it.
 */
export type ReviewerFactory = (input: {
  db: D1Like;
  env: ScheduledEnv;
  appId: string;
  installationId: number;
  transport?: ReconcileTransport;
}) => Promise<ReviewerResolution>;

type RoutingRow = {
  id: string;
  github_app_id: number;
  status: string;
  deleted_at: string | null;
  review_enabled: number;
  private_key_enc: string;
};

/** The exact-pair routing query (also the re-enable probe — D1 only). */
async function routingRow(db: D1Like, appId: string, installationId: number): Promise<RoutingRow | null> {
  return db
    .prepare(
      `SELECT ga.id AS id, ga.github_app_id AS github_app_id, ga.status AS status,
              ga.deleted_at AS deleted_at, ga.review_enabled AS review_enabled,
              ga.private_key_enc AS private_key_enc
       FROM app_installations ai
       JOIN github_apps ga ON ga.id = ai.app_id
       WHERE ai.app_id = ? AND ai.installation_id = ?`,
    )
    .bind(appId, installationId)
    .first<RoutingRow>();
}

/**
 * The production reviewer factory: routing gates → decrypt → per-App
 * commenter → live App-identity proof. The identity probe happens BEFORE the
 * resolution is handed out (spec §7.6: an identity mismatch must make no
 * GitHub mutation), so a mismatched pair is suspended durably by the caller
 * and never reaches a publication/discovery/resolution surface. A failed or
 * malformed probe is `identity-mismatch` too — the lanes must not mutate
 * under an unproven identity.
 */
export const productionReviewerFactory: ReviewerFactory = async ({ db, env, appId, installationId, transport }) => {
  const row = await routingRow(db, appId, installationId);
  if (row === null) return { kind: "unavailable", reason: "missing" };
  if (row.deleted_at !== null) return { kind: "unavailable", reason: "deleted" };
  if (row.status !== "active") return { kind: "unavailable", reason: "disabled" };
  // The suspension fingerprint binds a durable identity-mismatch suspension
  // to the credentials it was proven against (§7.6 / P67-QC-007): digesting
  // the ENCRYPTED envelope means the value can be persisted and compared
  // without ever exposing or re-deriving the private key.
  const credentialFingerprint = await sha256Hex(row.private_key_enc);
  try {
    const pem = await createSecretbox(env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    const commenter = createReviewCommenter({ APP_ID: String(row.github_app_id), PRIVATE_KEY: pem }, {
      db,
      ...(transport === undefined ? {} : { fetchImpl: transport.fetchImpl }),
    });
    const { resolveFindingThread, getAppIdentity } = commenter;
    if (resolveFindingThread === undefined || getAppIdentity === undefined) {
      return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
    }
    // The single purpose-scoped App-auth construction point also proves the
    // LIVE identity (spec §7.5's JWT `GET /app`): the row's `github_app_id`
    // must be the App the credentials actually authenticate as, with a
    // nonblank slug. Any disagreement — wrong key, rotated credential,
    // substituted pair — means no mutation is authorized for this pair.
    const identity = await getAppIdentity();
    if (identity === null || identity.githubAppId !== row.github_app_id) {
      return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint };
    }
    return {
      kind: "ok",
      paused: row.review_enabled === 0,
      // The authenticated `<slug>[bot]` login is the EXACT App-ownership
      // proof (spec §7.5); recovery must never fall back to a generic
      // `[bot]` suffix (P67-QC-011).
      botLogin: `${identity.slug}[bot]`,
      reviewer: {
        planReviewUpsert: (input) => commenter.planReviewUpsert(input),
        postPreparedReview: (input) => commenter.postPreparedReview(input),
        postPreparedDegraded: (input) => commenter.postPreparedDegraded(input),
        listDiscussion: (input) => commenter.listDiscussion(input),
        resolveFindingThread,
      },
    };
  } catch {
    // missing key / tampered envelope — fail closed
    return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
  }
};

// ---------------------------------------------------------------------------
// Log + deps
// ---------------------------------------------------------------------------

/** Structured JSON-lines log (warn for failures, one info summary line). */
export type ReconcileLog = {
  warn: (fields: { event: string; detail: string }, msg?: string) => void;
  info: (fields: Record<string, unknown>, msg?: string) => void;
};

export const defaultReconcileLog: ReconcileLog = {
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
  info: (fields, msg) => console.log(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

export type LifecycleReconcileDeps = {
  /** Injectable clock (integer Unix ms); defaults to Date.now. */
  now?: () => number;
  /** Injectable reviewer factory; defaults to the exact-pair D1 routing above. */
  reviewer?: ReviewerFactory;
  /** Injectable log; defaults to structured JSON lines. */
  log?: ReconcileLog;
};

// ---------------------------------------------------------------------------
// Run budget
// ---------------------------------------------------------------------------

type RunBudget = {
  /** ACTUAL requests issued this run (mutated only at the transport). */
  spent: number;
  deadline: number;
  /**
   * Admission ceiling for the lane currently running (§7.11.1: "Publication
   * lane gets at most half the run budget before the thread lane"). Applied
   * to actual requests at the transport so the lane share is a real bound,
   * not merely a scheduling hint.
   */
  laneCap: number;
};

/**
 * Non-mutating preflight admission (§7.11.1). The per-operation envelopes
 * below are ESTIMATES used only to decide whether an operation may start —
 * they are never charged, because the transport meters every ACTUAL request
 * and charging both would double-count (an operation estimated at 3 that
 * issues 11 real requests must cost 11, not 14). A false return stops the
 * lane WITHOUT spending an attempt — no claim, no GitHub call, the row
 * simply stays due.
 */
function canSpend(budget: RunBudget, nowMs: number, cost: number, laneScoped: boolean): boolean {
  if (budget.spent + cost > RECONCILE_MAX_REQUESTS) return false;
  if (laneScoped && budget.spent + cost > RECONCILE_PUBLICATION_LANE_MAX_REQUESTS) return false;
  if (budget.spent + cost > budget.laneCap) return false;
  if (nowMs >= budget.deadline) return false;
  return true;
}

/** Charge one ACTUAL request (called only from the transport choke point). */
function reserve(budget: RunBudget, cost: number): void {
  budget.spent += cost;
}

/**
 * The run's request allowance refused a request BEFORE it was dispatched
 * (spec §7.11.1: "budget exhaustion is not a failed attempt"). It is a
 * distinct type because the refusal must be told apart from a send that
 * MIGHT have reached GitHub: the caller restores the claimed publication to
 * its due `prepared` state instead of recording post-attempt `unknown`, so a
 * publication that was never sent is never stranded behind read-only
 * discovery. Nothing dispatches, so no attempt is spent either.
 *
 * Thrown by the transport only; classified by chain in the lanes below.
 */
class RecoveryBudgetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryBudgetRefused";
  }
}

/**
 * Does this error CHAIN carry a pre-dispatch budget refusal? Octokit does not
 * let a custom transport error reach the caller intact: `fetchWrapper`
 * re-wraps every non-abort rejection in `RequestError(message, 500, ...)`
 * with the original parked on `cause` (`@octokit/request`), and the
 * paginate/plugin layers re-wrap again. The refusal therefore has to be
 * recognized by walking `cause` rather than by an `instanceof` at the throw
 * site. The chain is walked by IDENTITY, never by message text — a message
 * match would classify any error that merely mentions the budget as
 * un-dispatched, which is exactly the false "never sent" claim this
 * distinction exists to prevent. Each link is read defensively: `cause` is
 * not typed on `Error`, and a hostile/cyclic cause chain must not hang the
 * recovery lane, so the walk is bounded and deduplicated by identity.
 */
function isBudgetRefusal(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof RecoveryBudgetRefused) return true;
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

/**
 * The enforced per-request transport bound AND the actual-request meter
 * (§7.11.1: "each request ≤5s and additionally capped by remaining run
 * deadline"; ≤80 requests/run). Every request gets its own abort signal at
 * `min(5s, time left in the run)` — computed at the request, so a request
 * issued late in the run cannot exceed the run's remaining time. A
 * caller-supplied signal is preserved by combining signals rather than being
 * replaced. This is the same runtime primitive the sweep's alert webhook
 * uses (`AbortSignal.timeout`).
 *
 * Metering lives HERE, at the single choke point every request funnels
 * through (identity probe, token mint, pagination pages, mutations alike),
 * because per-operation reservations are only PRE-FLIGHT ESTIMATES: one
 * `octokit.paginate` call or one 5-page thread scan issues many real HTTP
 * requests that a per-operation cost can never bound. Reserving per request
 * is what makes the ≤80 cap true. A request that cannot be admitted FAILS
 * BEFORE DISPATCH (the throw below) — the lane's caller-visible behavior is
 * unchanged: a throw is typed by the lane into a deferral, so the work
 * stays durable and due rather than being lost or silently unmetered.
 */
function buildTransport(budget: RunBudget, now: () => number): ReconcileTransport {
  const boundMs = (): number => Math.max(1, Math.min(RECONCILE_PER_REQUEST_MS, budget.deadline - now()));
  return {
    boundMs,
    fetchImpl: (input, init) => {
      // Admission + accounting for THIS request, atomically before dispatch.
      if (!canSpend(budget, now(), 1, false)) {
        return Promise.reject(
          new RecoveryBudgetRefused(
            `recovery request budget exhausted (spent=${budget.spent}/${RECONCILE_MAX_REQUESTS}, deadline=${budget.deadline}) — request not dispatched; work stays due`,
          ),
        );
      }
      reserve(budget, 1);
      const timeout = AbortSignal.timeout(boundMs());
      const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
      return fetch(input, { ...init, signal });
    },
  };
}

/** Backoff for the NEXT attempt after `attemptsAfter` consumed attempts. */
function backoffFor(attemptsAfter: number): number {
  const index = Math.min(Math.max(attemptsAfter - 1, 0), LIFECYCLE_BACKOFF_MS.length - 1);
  return LIFECYCLE_BACKOFF_MS[index]!;
}

/** Structured give-up line — App/scope/work ID + reason, no payload/secret. */
function giveUpLine(scope: Scope, workId: string, attempts: number, reason: string): string {
  return `gave up after ${attempts} attempts (app=${scope.appId}, installation=${scope.installationId}, owner=${scope.owner}, repo=${scope.repo}, pr=${scope.prNumber}, work=${workId}): ${reason}`;
}

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

/**
 * One bounded M8 recovery pass. Never throws (the §7.11 composition
 * contract: each cron stage is caught independently — a throw here must
 * never escape into `scheduled`). Returns the per-lane summary counts.
 */
export async function reconcileReviewLifecycle(
  env: ScheduledEnv,
  deps: LifecycleReconcileDeps = {},
): Promise<LifecycleReconcileSummary> {
  const log = deps.log ?? defaultReconcileLog;
  const summary: LifecycleReconcileSummary = {
    examined: 0, applied: 0, resolved: 0, unknown: 0, suspended: 0, errors: 0,
  };
  try {
    const db = env.DB;
    if (!db) {
      log.warn(
        { event: "ops_lifecycle_reconcile_db_unbound", detail: "DB binding missing — reconcile skipped" },
        "lifecycle reconcile skipped",
      );
      return summary;
    }
    const now = deps.now ?? (() => Date.now());
    const budget: RunBudget = { spent: 0, deadline: now() + RECONCILE_RUN_BUDGET_MS, laneCap: RECONCILE_MAX_REQUESTS };
    const reviewerFactory = deps.reviewer ?? productionReviewerFactory;
    // The enforced per-request bound (§7.11.1): every request made by a
    // reviewer this run builds is aborted at min(5s, remaining run time).
    const transport = buildTransport(budget, now);
    // Per-pair resolution cache: one routing pass (and at most ONE bulk
    // suspension) per App pair per run.
    const reviewerCache = new Map<string, Promise<ReviewerResolution>>();

    // 0. Exact-App re-enable policy (D1 only, no credentials):
    //    - a DISABLED App resumes by status alone once its row is active
    //      again (§7.6 "Re-enable allows due suspended rows to resume with
    //      the same IDs and fresh fencing");
    //    - every other suspension kind (identity mismatch, missing mapping,
    //      deleted App, credential failure) is DURABLE until an exact-App
    //      live identity proof succeeds (P67-QC-007). Unchanged credentials
    //      are proven unchanged by the recorded encrypted-envelope digest —
    //      the pair is left alone with no probe and no churn — and the
    //      proof is attempted again only after the credential envelope
    //      actually changed (the operator's correction).
    const suspendedPairs = await listSuspendedLifecycleApps(db, RECONCILE_SELECT_LIMIT);
    for (const pair of suspendedPairs) {
      try {
        const row = await routingRow(db, pair.appId, pair.installationId);
        const active = row !== null && row.deleted_at === null && row.status === "active";
        if (!active) continue;
        if (pair.requiresIdentityProof) {
          const currentFingerprint = row === null ? null : await sha256Hex(row.private_key_enc);
          if (currentFingerprint === null || currentFingerprint === pair.credentialFingerprint) {
            // Same credentials that already proved the mismatch (or no
            // evidence they changed): stay suspended, issue nothing.
            continue;
          }
          // Credentials changed — the operator's correction is the one event
          // that reopens the identity question. The probe is a real request,
          // so it passes the same whole-run admission gate as any other
          // (§7.11.1): unaffordable → the pair simply stays suspended.
          if (!canSpend(budget, now(), IDENTITY_REQUESTS, false)) continue;
          const proof = await reviewerFactory({
            db,
            env,
            appId: pair.appId,
            installationId: pair.installationId,
            transport,
          });
          if (proof.kind !== "ok") {
            // Still mismatched / still unusable: re-stamp BOTH lanes with the
            // CURRENT fingerprint so the next pass can tell again.
            const suspension = {
              kind: proof.reason,
              reason: UNAVAILABLE_REASON_TEXT[proof.reason],
              ...(proof.credentialFingerprint === undefined
                ? {}
                : { credentialFingerprint: proof.credentialFingerprint }),
            };
            await suspendPublicationRecovery(db, pair, suspension, now());
            await suspendResolutionRecovery(db, pair, suspension, now());
            continue;
          }
          // Identity proved against the corrected credentials: cache it so
          // this run's lanes reuse the proof instead of probing again.
          reviewerCache.set(`${pair.appId}:${pair.installationId}`, Promise.resolve(proof));
        }
        await reenableLifecycleForApps(db, [pair], now());
      } catch (error) {
        log.warn(
          { event: "ops_lifecycle_reenable_probe_failed", detail: error instanceof Error ? error.message : String(error) },
          "suspension re-enable probe failed — pair stays suspended",
        );
      }
    }

    // 1. Publication lane — at most half the run's request budget. The cap is
    // applied to ACTUAL requests at the transport (a paginating scan or a
    // token mint can issue more than its operation estimate), so the half
    // share is a real bound for this lane rather than a scheduling hint.
    budget.laneCap = RECONCILE_PUBLICATION_LANE_MAX_REQUESTS;
    await reconcilePublications(env, db, now, budget, reviewerFactory, transport, reviewerCache, log, summary);

    // 2. Thread lane — the remaining run budget (its own ≤15-request
    // per-operation envelope is the admission estimate; the actual requests
    // are metered under the whole-run cap).
    budget.laneCap = RECONCILE_MAX_REQUESTS;
    await reconcileResolutions(env, db, now, budget, reviewerFactory, transport, reviewerCache, log, summary);

    log.info({ event: "ops_lifecycle_reconcile", ...summary }, "lifecycle reconcile pass complete");
    return summary;
  } catch (error) {
    // Throw-proof wrapper (§7.11): a recovery failure never escapes into
    // `scheduled`; the partial summary is returned to the composition.
    summary.errors += 1;
    log.warn(
      { event: "ops_lifecycle_reconcile_failed", detail: error instanceof Error ? error.message : String(error) },
      "lifecycle reconcile failed — retained rows stay due",
    );
    return summary;
  }
}

/**
 * The per-run reviewer cache key. Probes are cached per (app, installation)
 * pair, so every budget gate that needs to know whether a pair's identity
 * probe is already accounted builds this key the same way (lockstep).
 */
const pairKeyOf = (scope: Scope): string => `${scope.appId}:${scope.installationId}`;

/**
 * Resolve (and cache) the reviewer for a pair; on `unavailable` suspend the
 * pair's pending rows durably (once per pair per run — attempts untouched,
 * no cross-App substitution).
 *
 * Transport metering only. The live App-identity probe the factory runs
 * (`GET /app`) is a GitHub request like any other, so it is metered at the
 * transport choke point (`buildTransport`) together with every later request
 * this pair issues; nothing is charged here. Charging a per-operation
 * estimate HERE on top of the real requests would double-count the probe and
 * shrink the run's true §7.11.1 allowance. A cached pair resolves without a
 * second probe, so it also costs nothing.
 */
async function reviewerForPair(
  db: D1Like,
  env: ScheduledEnv,
  scope: Scope,
  nowMs: number,
  budget: RunBudget,
  reviewerFactory: ReviewerFactory,
  transport: ReconcileTransport,
  reviewerCache: Map<string, Promise<ReviewerResolution>>,
  log: ReconcileLog,
  summary: LifecycleReconcileSummary,
): Promise<ReviewerResolution> {
  const pairKey = pairKeyOf(scope);
  const cached = reviewerCache.get(pairKey);
  if (cached !== undefined) return cached;
  const resolution = (async () => {
    try {
      // The factory proves the live App identity before returning; that probe
      // (and every other real request the pair issues) is metered at the
      // transport choke point, so no per-operation reservation is charged
      // here — reserving an estimate AND metering the real requests would
      // double-count and shrink the run's true allowance.
      return await reviewerFactory({ db, env, appId: scope.appId, installationId: scope.installationId, transport });
    } catch (error) {
      // A throwing factory is a credential-path failure — fail closed to a
      // durable suspension rather than letting it escape the lane.
      log.warn(
        { event: "ops_lifecycle_reviewer_factory_failed", detail: error instanceof Error ? error.message : String(error) },
        "reviewer factory threw — pair suspended",
      );
      return { kind: "unavailable", reason: "decrypt-failed" } satisfies ReviewerResolution;
    }
  })();
  reviewerCache.set(pairKey, resolution);
  const settled = await resolution;
  if (settled.kind === "unavailable") {
    const reason = `app ${UNAVAILABLE_REASON_TEXT[settled.reason]} — no GitHub mutation for this (${scope.appId}, ${scope.installationId}) pair`;
    const pair = { appId: scope.appId, installationId: scope.installationId };
    const suspension = {
      kind: settled.reason,
      reason,
      ...(settled.credentialFingerprint === undefined
        ? {}
        : { credentialFingerprint: settled.credentialFingerprint }),
    };
    const pubs = await suspendPublicationRecovery(db, pair, suspension, nowMs);
    const threads = await suspendResolutionRecovery(db, pair, suspension, nowMs);
    summary.suspended += pubs + threads;
    log.warn(
      { event: "ops_lifecycle_pair_suspended", detail: reason },
      "credential routing unavailable — pair suspended durably",
    );
  }
  return settled;
}

/**
 * Operator-facing suspension reasons (no payload/secret). An App-identity
 * mismatch gets its own line so the operator can tell a wrong/rotated
 * credential apart from a disabled or deleted App.
 */
const UNAVAILABLE_REASON_TEXT: Record<ReviewerUnavailableReason, string> = {
  missing: "mapping missing",
  deleted: "deleted",
  disabled: "disabled",
  "decrypt-failed": "credential decrypt failed",
  "identity-mismatch": "live App identity does not match the routed github_app_id — no GitHub mutation",
};

// --- publication lane -------------------------------------------------------

async function reconcilePublications(
  env: ScheduledEnv,
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  reviewerFactory: ReviewerFactory,
  transport: ReconcileTransport,
  reviewerCache: Map<string, Promise<ReviewerResolution>>,
  log: ReconcileLog,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const rows = await listPublicationRecovery(db, now(), RECONCILE_SELECT_LIMIT);
  for (const row of rows) {
    summary.examined += 1;
    // A definitively failed send is not re-sent by recovery (the operator
    // retry retains that phase deliberately); applied/superseded pending
    // rows are bookkeeping residue — examined, never re-worked.
    if (row.phase === "failed" || row.phase === "applied" || row.phase === "superseded") continue;
    if (row.phase === "confirmed") {
      await applyConfirmedPublication(db, now, row, summary);
      continue;
    }
    // prepared / sending / unknown need GitHub — route credentials first.
    // The identity probe and every other real request are metered at the
    // transport; this gate only decides whether even ONE request could still
    // fit the run, so an exhausted run stops the lane before any claim.
    const scope = row.payload.scope;
    if (!canSpend(budget, now(), 1, true)) continue; // stays due, no claim
    const resolved = await reviewerForPair(db, env, scope, now(), budget, reviewerFactory, transport, reviewerCache, log, summary);
    if (resolved.kind === "unavailable") continue; // pair suspended durably
    if (row.phase === "prepared") {
      await sendPreparedPublication(db, now, budget, resolved, row, log, summary);
    } else {
      await discoverUncertainPublication(db, now, budget, resolved, row, summary);
    }
  }
}

/**
 * The crashed-window core: a confirmed publication whose local apply never
 * completed. Proof-gated, idempotent, and PURELY local — no GitHub calls
 * and no reviewer needed ("after proof, local apply may proceed even if
 * GitHub is unavailable"); the frozen pause policy keeps this lane running.
 */
async function applyConfirmedPublication(
  db: D1Like,
  now: () => number,
  row: PublicationRow,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const lease = await claimPublication(db, row.id, HOLDER, now());
  if (lease === null) return; // another invocation owns the live lease
  try {
    const applied = await applyPublishedLifecycle(db, row.id, lease, now(), now);
    if (applied) {
      summary.applied += 1;
      return;
    }
    await settleFailedPublicationAttempt(db, now, row, lease, "apply rejected (lease/proof/payload gate)", summary, false);
  } catch (error) {
    await settleFailedPublicationAttempt(db, now, row, lease, error instanceof Error ? error.message : String(error), summary, false);
  }
}

/**
 * Send a prepared publication once, with the same identity (§7.7 failure
 * matrix: "Staged, before send → M8 sends once with same identity when
 * enabled/current"). Order: pause gate → age gate → budget → read-only
 * staleness pre-check (supersede instead of a stale send over a newer
 * round) → conditional claim → exact-body send → proof → apply.
 */
async function sendPreparedPublication(
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  resolved: Extract<ReviewerResolution, { kind: "ok" }>,
  row: PublicationRow,
  log: ReconcileLog,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const scope = row.payload.scope;
  // Frozen pause policy: no NEW primary publication while paused — the row
  // stays due (no attempt spent) for the re-enabled future.
  if (resolved.paused) return;
  // Age gate: only a settled prepared row (≥60s old) is recovery-sent; the
  // consumer owns younger ones.
  const createdMs = await getPublicationCreatedMs(db, row.id);
  if (createdMs === null || now() - createdMs < PREPARED_SEND_MIN_AGE_MS) return;
  // Preflight admission only — the plan/send requests are metered as they are
  // actually issued at the transport, so nothing is charged twice.
  if (!canSpend(budget, now(), PLAN_REQUESTS + SEND_REQUESTS, true)) return; // remains due, no attempt
  // Read-only staleness pre-check: never send a stale publication over a
  // newer round. A pre-check failure is typed "stay due" — no claim, no
  // attempt.
  let plan: UpsertPlan;
  try {
    plan = await resolved.reviewer.planReviewUpsert({
      installationId: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
      prNumber: scope.prNumber,
    });
  } catch {
    return;
  }
  if (plan.action === "update" && plan.round - 1 >= row.payload.round) {
    const superseded = await supersedePublication(
      db,
      row.id,
      `a newer publication round (${plan.round - 1}) already owns the PR surface`,
      now(),
    );
    if (superseded) {
      log.warn(
        { event: "ops_lifecycle_publication_superseded", detail: `publication=${row.id} round=${row.payload.round}` },
        "stale prepared publication superseded — never sent over a newer round",
      );
    }
    return;
  }
  const lease = await claimPublication(db, row.id, HOLDER, now());
  if (lease === null) return; // claimed elsewhere between pre-check and claim
  try {
    const target = {
      installationId: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
      prNumber: scope.prNumber,
      headSha: row.payload.headSha,
      round: row.payload.round,
      targetCommentId: row.payload.targetCommentId,
      body: row.payload.body,
      publicationId: row.id,
    };
    let commentId: number;
    if (row.payload.kind === "degraded") {
      const sent = await resolved.reviewer.postPreparedDegraded(target);
      // 0 = posted but the response carried no id — the typed sentinel
      // ("sent, id uncaptured"); §7.5 discovery binds the exact comment later.
      commentId = sent.commentId ?? 0;
    } else {
      const sent = await resolved.reviewer.postPreparedReview(target);
      commentId = sent.commentId;
    }
    const recorded = await recordPublicationProof(db, row.id, lease, {
      publicationId: row.id,
      scope,
      headSha: row.payload.headSha,
      kind: row.payload.kind,
      round: row.payload.round,
      commentId,
      bodySha256: row.payload.bodySha256,
      confirmedMs: now(),
    });
    if (!recorded) {
      await settleFailedPublicationAttempt(db, now, row, lease, "proof persistence rejected the confirmation", summary, true);
      return;
    }
    const applied = await applyPublishedLifecycle(db, row.id, lease, now(), now);
    if (applied) {
      summary.applied += 1;
      return;
    }
    await settleFailedPublicationAttempt(db, now, row, lease, "post-proof apply did not complete", summary, false);
  } catch (error) {
    if (error instanceof PreparedSendRejected) {
      // A definitive pre-send rejection (§7.7): no request left the Worker,
      // so `failed` is the truthful durable phase — never the post-attempt
      // `unknown`. Payload, digest and attempts are retained; recovery never
      // re-sends a failed row (the phase is skipped on selection). The
      // summary's frozen shape (§7.11.1) has no `failed` field, so this
      // terminal outcome is reported through `errors`, exactly like the
      // other terminal give-up paths.
      const marked = await markPublicationFailed(db, row.id, lease, error.message, now());
      if (marked) {
        log.warn(
          { event: "ops_lifecycle_publication_failed", detail: `publication=${row.id}: ${error.message}` },
          "prepared publication definitively rejected before send — recorded failed, never re-sent",
        );
      }
      summary.errors += 1;
      return;
    }
    if (isBudgetRefusal(error)) {
      // The allowance refused a request BEFORE dispatch (§7.11.1: "budget
      // exhaustion is not a failed attempt"). This send never left the
      // Worker, so the claim is unwound — the row returns to due `prepared`
      // with its attempt returned and stays re-sendable next run. Recording
      // post-attempt `unknown` here would strand a publication that was
      // never dispatched (P67-QC-018), and spending an attempt would charge
      // a run's exhaustion against the publication.
      const restored = await releaseUnspentPublicationClaim(db, row.id, lease, now());
      if (!restored) {
        // The claim was no longer ours (another invocation moved or released
        // the row first). Report rather than assume the restore applied; the
        // row keeps whatever truthful state its new owner gave it.
        summary.errors += 1;
        log.warn(
          { event: "ops_lifecycle_publication_claim_restore_missed", detail: `publication=${row.id}` },
          "budget refusal hit a claim that had already moved — row left to its current owner",
        );
        return;
      }
      log.warn(
        { event: "ops_lifecycle_publication_budget_refused", detail: `publication=${row.id}` },
        "publication send refused before dispatch — claim released, row stays due, no attempt spent",
      );
      return;
    }
    // The send MAY have landed (§7.7): the honest phase is unknown —
    // read-only discovery only, never a blind second create.
    await settleFailedPublicationAttempt(db, now, row, lease, error instanceof Error ? error.message : String(error), summary, true);
  }
}

/**
 * Read-only discovery for `sending`/`unknown` rows (§7.7 "Remote unknowns"):
 * scan the PR's bounded newest issue comments for the EXACT prepared body
 * (marker + digest — body equality implies both). Ownership is proven against
 * the EXACT authenticated `<slug>[bot]` login of this App (§7.5 / P67-QC-011),
 * never a generic `[bot]` suffix: the body embeds an opaque publication UUID,
 * so the risk is low either way, but App-scoped ownership is the contract the
 * rest of the resolve path already enforces. A hit is proof: persist it and
 * apply the saved payload without the model. A miss defers with backoff —
 * never a blind second create; the cap leaves it local-error for operator
 * inspection.
 */
async function discoverUncertainPublication(
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  resolved: Extract<ReviewerResolution, { kind: "ok" }>,
  row: PublicationRow,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const scope = row.payload.scope;
  if (!canSpend(budget, now(), DISCOVERY_REQUESTS, true)) return; // stays unknown/due, no attempt
  const lease = await claimPublication(db, row.id, HOLDER, now());
  if (lease === null) return; // another invocation owns discovery
  try {
    const discussion = await resolved.reviewer.listDiscussion({
      installationId: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
      prNumber: scope.prNumber,
      threads: [], // issue comments only — the publication lives on the PR conversation
    });
    const hit = discussion.items.find(
      (item) =>
        item.source === "issue" && item.author === resolved.botLogin && item.body === row.payload.body,
    );
    if (hit === undefined) {
      await settleFailedPublicationAttempt(db, now, row, lease, "read-only discovery found no exact publication match", summary, true);
      return;
    }
    const commentId = Number(hit.id);
    if (!Number.isSafeInteger(commentId) || commentId <= 0) {
      await settleFailedPublicationAttempt(db, now, row, lease, "discovered publication carries an unusable comment id", summary, true);
      return;
    }
    const recorded = await recordPublicationProof(db, row.id, lease, {
      publicationId: row.id,
      scope,
      headSha: row.payload.headSha,
      kind: row.payload.kind,
      round: row.payload.round,
      commentId,
      bodySha256: row.payload.bodySha256,
      confirmedMs: now(),
    });
    if (!recorded) {
      await settleFailedPublicationAttempt(db, now, row, lease, "proof persistence rejected the discovered publication", summary, true);
      return;
    }
    const applied = await applyPublishedLifecycle(db, row.id, lease, now(), now);
    if (applied) {
      summary.applied += 1;
      return;
    }
    await settleFailedPublicationAttempt(db, now, row, lease, "post-proof apply did not complete", summary, false);
  } catch (error) {
    await settleFailedPublicationAttempt(db, now, row, lease, error instanceof Error ? error.message : String(error), summary, true);
  }
}

/**
 * One failed publication attempt: backoff (1/2/4/8/16 min) or, at the
 * 5-attempt cap, a terminal durable local-error with the structured
 * App/scope/work-ID line — the row is retained for operator inspection,
 * never deleted. Budget exhaustion never reaches this path (no attempt was
 * spent).
 */
async function settleFailedPublicationAttempt(
  db: D1Like,
  now: () => number,
  row: PublicationRow,
  lease: Lease,
  reason: string,
  summary: LifecycleReconcileSummary,
  /** true = the attempt was an uncertain send/discovery → phase `unknown`. */
  uncertain: boolean,
): Promise<void> {
  const attemptsAfter = row.attempts + 1; // the claim counted exactly one
  if (attemptsAfter >= LIFECYCLE_MAX_ATTEMPTS) {
    await markPublicationLocalError(db, row.id, lease, giveUpLine(row.payload.scope, row.id, attemptsAfter, reason), now());
    summary.errors += 1;
    return;
  }
  const nextAttemptMs = now() + backoffFor(attemptsAfter);
  const deferred = uncertain
    ? await markPublicationUnknown(db, row.id, lease, nextAttemptMs, reason, now())
    : await deferPublicationRecovery(db, row.id, lease, nextAttemptMs, reason, now());
  if (deferred && uncertain) summary.unknown += 1;
  summary.errors += 1;
}

// --- thread lane ------------------------------------------------------------

async function reconcileResolutions(
  env: ScheduledEnv,
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  reviewerFactory: ReviewerFactory,
  transport: ReconcileTransport,
  reviewerCache: Map<string, Promise<ReviewerResolution>>,
  log: ReconcileLog,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const rows = await listResolutionRecovery(db, now(), RECONCILE_SELECT_LIMIT);
  for (const { associationId, scope } of rows) {
    // Preflight admission BEFORE any claim: one operation may spend up to the
    // §7.11.1 ≤15-request thread envelope (estimate only — the ACTUAL requests
    // are metered at the transport). A false gate stops the lane WITHOUT a
    // claim or an attempt — the row simply stays due (§7.11.1: budget
    // exhaustion is not a failed attempt).
    if (!canSpend(budget, now(), RECONCILE_THREAD_OPERATION_REQUESTS, false)) return;
    summary.examined += 1;
    // Pair credentials come FIRST; the §7.5 surface claims and counts its
    // attempt only inside `resolveFindingThread`, which the admission above
    // precedes.
    const resolved = await reviewerForPair(db, env, scope, now(), budget, reviewerFactory, transport, reviewerCache, log, summary);
    if (resolved.kind === "unavailable") continue; // pair suspended durably
    // A paused App keeps "previously-authorized resolution retry" running
    // (frozen pause policy) — no extra gate here.
    const work = await getResolutionRecoveryRow(db, associationId);
    if (work === null) continue; // row vanished (operator action) — nothing to drive
    let verified;
    try {
      verified = JSON.parse(work.verifiedJson);
    } catch {
      // A corrupt snapshot can never satisfy the §7.5 fences — terminal
      // visible local-error instead of an eternal retry loop.
      await markResolutionLocalError(db, associationId, giveUpLine(work.scope, associationId, work.attempts, "stored verified snapshot is unreadable"), now());
      summary.errors += 1;
      continue;
    }
    try {
      const outcome = await resolved.reviewer.resolveFindingThread({ scope, associationId, verified });
      switch (outcome.kind) {
        case "resolved":
          summary.resolved += 1;
          break;
        case "abandoned":
          break; // terminal; the §7.5 surface persisted the state + reason
        case "needs-recheck":
          await recordNeedsRecheck(db, associationId, `resolve deferred to the next real review: ${outcome.reason}`, now());
          summary.unknown += 1;
          break;
        case "retry":
          await settleFailedResolveAttempt(db, now, associationId, work, outcome.reason, summary);
          break;
      }
    } catch (error) {
      // The §7.5 surface contracts typed outcomes; a throw is an infra
      // failure — attempt already consumed by its claim, so defer/cap.
      await settleFailedResolveAttempt(db, now, associationId, work, error instanceof Error ? error.message : String(error), summary);
    }
  }
}

/**
 * One failed resolve attempt: backoff (1/2/4/8/16 min) after the attempt
 * the §7.5 claim consumed, or the terminal visible local-error at the
 * 5-attempt cap — structured App/scope/work-ID line, row retained (never
 * deleted).
 */
async function settleFailedResolveAttempt(
  db: D1Like,
  now: () => number,
  associationId: string,
  work: { scope: Scope; attempts: number },
  reason: string,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const attemptsAfter = work.attempts + 1; // the §7.5 claim counted exactly one
  if (attemptsAfter >= LIFECYCLE_MAX_ATTEMPTS) {
    await markResolutionLocalError(db, associationId, giveUpLine(work.scope, associationId, attemptsAfter, reason), now());
    summary.errors += 1;
    return;
  }
  const nextAttemptMs = now() + backoffFor(attemptsAfter);
  const deferred = await deferResolutionRecovery(db, associationId, nextAttemptMs, reason, now());
  if (deferred) summary.errors += 1;
}
