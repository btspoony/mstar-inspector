/**
 * M7 Check recovery reconciler (plan 68 Task 3, spec review-lifecycle
 * §7.11.2) — the second independent cron lane, composed after plan 67's M8
 * reconciler (`runSweep` → `reconcileReviewLifecycle` → `reconcileReviewChecks`,
 * each stage caught on its own).
 *
 * One bounded pass selects at most 25 due attempts (§7.11.2 predicate, one
 * bound `nowMs`), reacquires each with a conditional epoch-fenced UPDATE that
 * never takes a live lease, decides the terminal conclusion from PERSISTED
 * proof, persists that intent before any remote send, and then either adopts
 * the run this attempt already created (`external_id`/App/SHA, `filter:"all"`,
 * ≤2 pages) or creates it — only from a definitively unsent state. A returned
 * terminal run is validated against the persisted desired intent before
 * `observed` advances; anything else stays `remote-unconfirmed` with backoff.
 *
 * Spec invariants this module is responsible for:
 *
 * - **Expiry uses the execution deadline.** A row still wanting `in_progress`
 *   is due only past `execution_deadline_ms`; the 120s recovery lease never
 *   moves that deadline, and no bookkeeping time participates in the
 *   decision. An expired attempt becomes a TERMINAL conclusion (never
 *   `in_progress`, which `completeCheck`'s type excludes).
 * - **Intent before update, observation after a validated response.**
 *   `setCheckDesired` freezes the bounded conclusion before `completeCheck`
 *   is called; `recordCheckObservation` is the only writer of `observed` and
 *   only accepts a payload whose identity, status and conclusion match the
 *   persisted intent — so a stale-epoch response can never be recorded.
 * - **Adoption before creation.** A possibly-sent create is resolved by a
 *   bounded read-only walk, never by a second create (RL-12: `external_id` is
 *   correlation, not server-side idempotency). An uncertain create remains
 *   `remote-unconfirmed`, and a known remote id is retained, never cleared.
 * - **Budgets.** ≤6 requests per row, ≤100 requests per 60s run, each request
 *   ≤5s clamped by the remaining run deadline. Admission is enforced at the
 *   single transport choke point every request funnels through (token mint,
 *   identity probe, list/create/update/get alike), so the bound is real
 *   rather than a per-operation estimate. A refusal happens BEFORE dispatch:
 *   the row stays due, nothing is mutated, and NO attempt is spent.
 * - **M8 owns publication discovery.** The Check lane reads persisted
 *   publication proof through the one journal reader and never triggers a
 *   send, replay or paid re-review; plan 67's lane — composed before this one
 *   — is the only writer of that proof.
 * - **Throw-proof.** Every row is isolated, and the whole pass is wrapped: a
 *   recovery failure is logged and folded into `errors`, so nothing ever
 *   escapes into `scheduled`.
 */

import type { ScheduledEnv } from "./env";
import type { Scope } from "../contracts/recheck";
import type { D1Like } from "../store/types";
import {
  attachCheckRunId,
  CHECK_MAX_ATTEMPTS,
  CHECK_NAME,
  CHECK_RECONCILE_LIMIT,
  CHECK_BACKOFF_MS,
  claimCheckRecovery,
  type CheckAttempt,
  type CheckConclusion,
  type CheckRemote,
  deferCheckRecovery,
  getCheckAttempt,
  getCheckOwnership,
  listCheckReconcileBatch,
  markCheckLocalError,
  readPublicationProof,
  recordCheckObservation,
  reenableChecksForApps,
  releaseCheckClaim,
  releaseExpiredCheckClaim,
  setCheckDesired,
  suspendCheckRecovery,
} from "../store/review-checks";
import type { CheckOwnership, Lease, PublicationProof } from "../store/review-checks";
import { CHECK_SUMMARIES, decideConclusion, type ChecksAdapter } from "../pipeline/checks";
import type { ReviewCommenter } from "../pipeline/comment";
import { createReviewCommenter } from "../pipeline/comment";
import { createSecretbox } from "../dashboard/secretbox";
import type { ReconcileTransport } from "./lifecycle-reconcile";

// ---------------------------------------------------------------------------
// Summary + budget constants (spec §7.11.2 verbatim values)
// ---------------------------------------------------------------------------

export type CheckReconcileSummary = {
  examined: number;
  completed: number;
  unconfirmed: number;
  suspended: number;
  gaveUp: number;
  errors: number;
};

/** Whole-run request budget (§7.11.2: "≤100 requests/60s/run"). */
export const CHECK_RECONCILE_MAX_REQUESTS = 100;
/** Whole-run wall-clock window in ms (§7.11.2). */
export const CHECK_RECONCILE_RUN_BUDGET_MS = 60_000;
/** Per-request cap (§7.11.2: "≤5s/request"). */
export const CHECK_RECONCILE_PER_REQUEST_MS = 5_000;
/** Per-row request cap (§7.11.2: "≤6 requests/row"). */
export const CHECK_ROW_MAX_REQUESTS = 6;
/**
 * Preflight estimate for the credential lane (spec §7.11.2 "the App is
 * enabled"): the §7.5 live App-identity proof (`GET /app`) plus the
 * installation-token mint. Both are REAL requests metered at the transport;
 * this constant is only the admission estimate consulted before a pair is
 * built, and is never charged (charging an estimate on top of the metered
 * requests would double-count).
 */
const CREDENTIAL_REQUESTS = 2;
/**
 * Bound on the status-driven re-enable pass. The pairs are selected from the
 * rows that are ACTUALLY suspended — never a window over all Apps — so the
 * bound is the row batch's own order rather than an app-count ceiling.
 */
const REENABLE_PAIR_LIMIT = CHECK_RECONCILE_LIMIT;

/** Lease holder label for Check recovery claims. */
const HOLDER = "check-reconcile";

// ---------------------------------------------------------------------------
// Log + deps
// ---------------------------------------------------------------------------

/** Structured JSON-lines log (warn for failures, one info summary line). */
export type CheckReconcileLog = {
  warn: (fields: { event: string; detail: string }, msg?: string) => void;
  info: (fields: Record<string, unknown>, msg?: string) => void;
};

export const defaultCheckReconcileLog: CheckReconcileLog = {
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
  info: (fields, msg) => console.log(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

/**
 * The per-request bound contract (§7.11): the same shape the M8 lane hands to
 * its reviewer factory, so both independent reconcilers enforce one contract.
 */
export type CheckTransport = ReconcileTransport;

/** Why a pair's Check credential path cannot be used (spec §7.6). */
export type CheckCredentialReason = "missing" | "deleted" | "disabled" | "decrypt-failed" | "identity-mismatch";

export type CheckCredentialResolution =
  | {
      kind: "ok";
      adapter: ChecksAdapter;
      /**
       * `github_apps.review_enabled = 0` (spec §7.6 pause / kill switch). A
       * paused App may still READ — adoption and terminalization of a run that
       * already exists — but must never create a Check that was never sent, so
       * the lane gates `beginCheck` on this flag rather than refusing
       * credentials outright.
       */
      paused: boolean;
    }
  | { kind: "unavailable"; reason: CheckCredentialReason };

/**
 * Exact `(app_id, installation_id)` credential routing for the Check lane.
 * The production implementation is the §7.6 chain — routing gates → decrypt →
 * the ONE `createReviewCommenter` construction point per pair per run (whose
 * `checks: "write"` mint and Checks client are the T1 adapter) → live
 * `GET /app` identity proof. No second `createAppAuth`, no second client.
 */
export type CheckCredentialFactory = (input: {
  db: D1Like;
  env: ScheduledEnv;
  scope: Scope;
  now: () => number;
  transport: CheckTransport;
}) => Promise<CheckCredentialResolution>;

export type CheckReconcileDeps = {
  /** Injectable clock (integer Unix ms); defaults to Date.now. */
  now?: () => number;
  /** Injectable credential factory; defaults to the exact-pair §7.6 chain. */
  credentials?: CheckCredentialFactory;
  /** Injectable log; defaults to structured JSON lines. */
  log?: CheckReconcileLog;
};

// ---------------------------------------------------------------------------
// Credential routing (spec §7.6 — exact pair, never a repository-wide scan)
// ---------------------------------------------------------------------------

type CheckRoutingRow = {
  id: string;
  github_app_id: number;
  status: string;
  deleted_at: string | null;
  review_enabled: number;
  private_key_enc: string;
};

async function checkRoutingRow(db: D1Like, appId: string, installationId: number): Promise<CheckRoutingRow | null> {
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
    .first<CheckRoutingRow>();
}

/**
 * The production Check credential factory: the same §7.6 gates M8 applies
 * (missing mapping / soft-deleted / disabled → `unavailable`, no GitHub), the
 * encrypted-envelope decrypt, and the single purpose-scoped commenter whose
 * `checks` adapter is the T1 surface. The live identity probe proves the
 * routed `github_app_id` is the App these credentials actually authenticate
 * as before any Check request is allowed.
 *
 * Pause (`review_enabled = 0`) does NOT make the pair unusable — credentials
 * are still minted so the lane can adopt and terminalize a Check that already
 * exists — but the flag rides the resolution because §7.6 forbids a paused App
 * from producing a NEW Check. The lane, not this factory, owns that gate.
 */
export const productionCheckCredentials: CheckCredentialFactory = async ({ db, env, scope, now, transport }) => {
  const row = await checkRoutingRow(db, scope.appId, scope.installationId);
  if (row === null) return { kind: "unavailable", reason: "missing" };
  if (row.deleted_at !== null) return { kind: "unavailable", reason: "deleted" };
  if (row.status !== "active") return { kind: "unavailable", reason: "disabled" };
  try {
    const pem = await createSecretbox(env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    // The single construction point (§7.6): `db` wires the T1 Checks adapter,
    // `nowMs` fences every local send on the run's clock, and `fetchImpl`
    // routes every request (including auth-app's own mint POST) through the
    // run's bounded transport.
    const commenter: ReviewCommenter = createReviewCommenter(
      { APP_ID: String(row.github_app_id), PRIVATE_KEY: pem },
      { db, nowMs: now, fetchImpl: transport.fetchImpl },
    );
    const identity = (await commenter.getAppIdentity?.()) ?? null;
    if (identity === null || identity.githubAppId !== row.github_app_id) {
      return { kind: "unavailable", reason: "identity-mismatch" };
    }
    const adapter = commenter.checks;
    if (adapter === undefined) return { kind: "unavailable", reason: "decrypt-failed" };
    return { kind: "ok", adapter, paused: row.review_enabled === 0 };
  } catch {
    // missing key / tampered envelope — fail closed, never a mutation
    return { kind: "unavailable", reason: "decrypt-failed" };
  }
};

/** Operator-facing suspension reasons (no payload/secret). */
const UNAVAILABLE_REASON_TEXT: Record<CheckCredentialReason, string> = {
  missing: "mapping missing",
  deleted: "deleted",
  disabled: "disabled",
  "decrypt-failed": "credential decrypt failed",
  "identity-mismatch": "live App identity does not match the routed github_app_id",
};

// ---------------------------------------------------------------------------
// Run budget (§7.11.2 step 5) and the enforced transport
// ---------------------------------------------------------------------------

type RunBudget = {
  /** ACTUAL requests issued this run (mutated only at the transport). */
  spent: number;
  deadline: number;
  /** ACTUAL requests issued for the CURRENT row (reset per row). */
  rowSpent: number;
  /** Only the row's own operations count against the ≤6/row cap. */
  rowActive: boolean;
  /**
   * Set when a request was refused BEFORE dispatch. The caller must then stop
   * without spending an attempt — the work item stays due — and must not
   * interpret the resulting `unavailable` as a credential failure.
   */
  refused: boolean;
};

/**
 * Non-mutating preflight admission. Checks the whole-run cap, the run
 * deadline and (for row-scoped calls) the per-row cap. The credential lane is
 * charged to the run only: its identity probe and mint are once-per-pair work
 * shared by every row of that pair, so counting them against the first row's
 * ≤6 would shrink that row's real allowance.
 */
function canSpend(budget: RunBudget, nowMs: number, cost: number, rowScoped: boolean): boolean {
  if (budget.spent + cost > CHECK_RECONCILE_MAX_REQUESTS) return false;
  if (nowMs >= budget.deadline) return false;
  if (rowScoped && budget.rowActive && budget.rowSpent + cost > CHECK_ROW_MAX_REQUESTS) return false;
  return true;
}

/** Charge one ACTUAL request (called only from the transport choke point). */
function reserve(budget: RunBudget, cost: number): void {
  budget.spent += cost;
  if (budget.rowActive) budget.rowSpent += cost;
}

/**
 * The run's allowance refused a request BEFORE it was dispatched (§7.11.2
 * step 5: budget deferral leaves work due and spends no attempt). Distinct
 * from a transport failure because a refused request provably never reached
 * GitHub, so the row must not be marked as an attempted-and-failed recovery.
 *
 * Octokit re-wraps a custom transport rejection (`RequestError` with the
 * original parked on `cause`), so the refusal is recognized by walking the
 * error CHAIN by identity — never by message text, which would classify any
 * error merely mentioning the budget as un-dispatched.
 */
class RecoveryBudgetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryBudgetRefused";
  }
}

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
 * The enforced per-request transport bound AND the actual-request meter: every
 * request gets an abort signal at `min(5s, time left in the run)` computed AT
 * the request, so a request issued late cannot outlive the run. Metering lives
 * here — the single choke point every request funnels through — because a
 * per-operation estimate can never bound what a paginating scan actually
 * issues. A request that cannot be admitted fails BEFORE dispatch and marks
 * the budget, so the caller can tell a deferral from a failed attempt.
 *
 * A refusal AFTER a recovery claim does not leave a lease behind. The lane
 * hands the claim straight back with `releaseCheckClaim` (or
 * `releaseExpiredCheckClaim` for the zero-dispatch case, whose fence is
 * identity rather than liveness): holder and lease are cleared, and attempts,
 * backoff, desired/observed, remote IDs and error state are all preserved. The
 * row is selector-due again at the SAME instant, not after a 120-second lapse.
 * `deferCheckRecovery` is deliberately not used here, because it increments
 * `attempts` and the spec forbids charging an attempt for work that never ran.
 */
function buildTransport(budget: RunBudget, now: () => number): CheckTransport {
  const boundMs = (): number => Math.max(1, Math.min(CHECK_RECONCILE_PER_REQUEST_MS, budget.deadline - now()));
  return {
    boundMs,
    fetchImpl: (input, init) => {
      if (!canSpend(budget, now(), 1, true)) {
        budget.refused = true;
        return Promise.reject(
          new RecoveryBudgetRefused(
            `check recovery request budget exhausted (spent=${budget.spent}/${CHECK_RECONCILE_MAX_REQUESTS}, row=${budget.rowSpent}/${CHECK_ROW_MAX_REQUESTS}) — request not dispatched; work stays due`,
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
  const index = Math.min(Math.max(attemptsAfter - 1, 0), CHECK_BACKOFF_MS.length - 1);
  return CHECK_BACKOFF_MS[index]!;
}

/** Structured give-up line — App/scope/work ID + reason, no payload/secret. */
function giveUpLine(scope: Scope, workId: string, attempts: number, reason: string): string {
  return `gave up after ${attempts} attempts (app=${scope.appId}, installation=${scope.installationId}, owner=${scope.owner}, repo=${scope.repo}, pr=${scope.prNumber}, work=${workId}): ${reason}`;
}

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

/**
 * One bounded M7 Check recovery pass. Never throws (the §7.11 composition
 * contract: each cron stage is caught independently — a throw here must never
 * escape into `scheduled`). Returns the per-outcome summary counts.
 */
export async function reconcileReviewChecks(
  env: ScheduledEnv,
  deps: CheckReconcileDeps = {},
): Promise<CheckReconcileSummary> {
  const log = deps.log ?? defaultCheckReconcileLog;
  const summary: CheckReconcileSummary = {
    examined: 0, completed: 0, unconfirmed: 0, suspended: 0, gaveUp: 0, errors: 0,
  };
  try {
    const db = env.DB;
    if (!db) {
      log.warn(
        { event: "ops_check_reconcile_db_unbound", detail: "DB binding missing — check reconcile skipped" },
        "check reconcile skipped",
      );
      return summary;
    }
    const now = deps.now ?? (() => Date.now());
    const budget: RunBudget = {
      spent: 0,
      deadline: now() + CHECK_RECONCILE_RUN_BUDGET_MS,
      rowSpent: 0,
      rowActive: false,
      refused: false,
    };
    const transport = buildTransport(budget, now);
    const credentials = deps.credentials ?? productionCheckCredentials;
    // One credential resolution per App pair per run: exactly one identity
    // probe and one purpose-scoped client, reused by every row of that pair.
    const credentialCache = new Map<string, Promise<CheckCredentialResolution>>();

    // 0. Status-driven re-enable (D1 only): rows of an App that is active and
    //    not deleted resume with fresh fencing and their identities intact.
    //    The live credential proof is re-established by the row loop below, so
    //    a pair that is still unusable is suspended again on its next due run
    //    — this can never auto-resume work for a broken App.
    await reenableHealthyAppChecks(db, now(), log);

    // 1. Due attempts, ONE bound nowMs at every predicate position.
    const rows = await listCheckReconcileBatch(db, now(), CHECK_MAX_ATTEMPTS, CHECK_RECONCILE_LIMIT);
    for (const row of rows) {
      summary.examined += 1;
      budget.rowSpent = 0;
      budget.refused = false;
      budget.rowActive = true;
      try {
        await reconcileCheckAttempt(env, db, now, budget, transport, credentials, credentialCache, row, log, summary);
      } catch (error) {
        summary.errors += 1;
        log.warn(
          {
            event: "ops_check_reconcile_row_failed",
            detail: `${row.identity.attemptId}: ${error instanceof Error ? error.message : String(error)}`,
          },
          "check reconcile row failed — row left to its next due time",
        );
      } finally {
        budget.rowActive = false;
      }
    }

    log.info({ event: "ops_check_reconcile", ...summary }, "check reconcile pass complete");
    return summary;
  } catch (error) {
    // Throw-proof wrapper (§7.11): a recovery failure never escapes into
    // `scheduled`; the partial summary is returned to the composition.
    summary.errors += 1;
    log.warn(
      { event: "ops_check_reconcile_failed", detail: error instanceof Error ? error.message : String(error) },
      "check reconcile failed — retained rows stay due",
    );
    return summary;
  }
}

/**
 * §7.11.2 step 6's re-enable half: an App row that is active and not deleted
 * lets its suspended Check rows resume (fresh claims, same identities). This
 * is a D1-only transition — no credential is trusted from a previous run, and
 * the pair's usability is proven again by the row loop before any request.
 *
 * Pairs are drawn from the SUSPENDED rows themselves (the work that actually
 * needs resuming), so a pair is considered exactly when it holds suspended
 * Check work — never a window over every App in the deployment, which would
 * both spuriously resume nothing and miss a pair beyond the window.
 */
async function reenableHealthyAppChecks(db: D1Like, nowMs: number, log: CheckReconcileLog): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT ga.id AS app_id, rc.installation_id AS installation_id
         FROM review_checks rc
         JOIN github_apps ga ON ga.id = rc.app_id
        WHERE rc.recovery_state = 'suspended'
          AND ga.status = 'active' AND ga.deleted_at IS NULL
        ORDER BY rc.installation_id, ga.id
        LIMIT ?`,
    )
    .bind(REENABLE_PAIR_LIMIT)
    .all<{ app_id: string; installation_id: number }>();
  if (results.length === 0) return;
  try {
    await reenableChecksForApps(
      db,
      results.map((row) => ({ appId: row.app_id, installationId: row.installation_id })),
      nowMs,
    );
  } catch (error) {
    log.warn(
      {
        event: "ops_check_reconcile_reenable_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      "check re-enable skipped — suspended rows stay suspended",
    );
  }
}

/**
 * One due attempt, §7.11.2 steps 1–5 in order. Ownership is only ever granted
 * by `claimCheckRecovery`; everything after it is fenced on that lease, and
 * every exit leaves the row in a state its next run can continue from.
 *
 * Two exits deliberately give the claim BACK (`releaseCheckClaim`) instead of
 * settling the row as a failed attempt, because in neither case did a recovery
 * action actually run:
 *   - the run's request budget refused a request before dispatch, and
 *   - a paused App's never-sent attempt has no legal create.
 * Both leave every durable field untouched (attempts, due time, IDs, desired/
 * observed, error), so the row is immediately selector-due again rather than
 * withheld behind a 120s lease it never used (§7.11.2 step 5).
 */
async function reconcileCheckAttempt(
  env: ScheduledEnv,
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  transport: CheckTransport,
  credentials: CheckCredentialFactory,
  credentialCache: Map<string, Promise<CheckCredentialResolution>>,
  row: CheckAttempt,
  log: CheckReconcileLog,
  summary: CheckReconcileSummary,
): Promise<void> {
  const attemptId = row.identity.attemptId;
  const scope = row.identity.scope;

  // The pair's credential path first: a pair that cannot be used must be
  // suspended, not claimed (no ownership is taken for work that cannot run).
  const resolved = await credentialsForPair(db, env, scope, now, budget, transport, credentials, credentialCache, log, summary);
  if (resolved.kind !== "ok") return;

  // 1. Reacquire: a conditional UPDATE repeating the SELECTOR'S FULL
  //    eligibility that increments the epoch. A live lease — another
  //    invocation's or this holder's unexpired one — is never taken, and a row
  //    that stopped being due after selection (a forward backoff, the attempt
  //    cap, an `in_progress` still inside its execution deadline) is refused
  //    here. Nothing is stamped or spent on refusal.
  const claimed = await claimCheckRecovery(db, attemptId, HOLDER, now());
  if (claimed === null) return;
  const lease: Lease = claimed;

  const owned = await getCheckOwnership(db, attemptId, lease, now());
  if (owned === null) return; // fence lost between claim and read

  // Re-read against the CLAIM, not the selection: the decision below must use
  // the eligibility the claim actually proved, so a row whose attempts or due
  // time moved after selection cannot feed a stale `attempts` into the
  // backoff/give-up arithmetic.
  const current = await getCheckAttempt(db, attemptId);
  if (current === null) return;
  const attemptsBefore = current.attempts;

  // 2. Proof by exact App/scope/SHA, preferring this attempt's publication id.
  //    M8's lane precedes this one and owns read-only discovery; the Check
  //    lane only ever READS what that lane persisted — never a send, replay
  //    or paid re-review.
  const proof = await readProof(db, owned);
  const conclusion = terminalConclusion(owned, proof);

  // Intent BEFORE any remote update: the persisted row is the only source the
  // send reads, so the frozen text cannot be swapped after this point.
  await setCheckDesired(db, attemptId, lease, conclusion, proof?.publicationId ?? null, now());
  const intent = await getCheckOwnership(db, attemptId, lease, now());
  if (intent === null) return;
  // A row whose persisted intent is still `in_progress` has nothing terminal
  // to push — `setCheckDesired` refuses to move it backwards and
  // `completeCheck` cannot carry it. That is the paused-App shape: give the
  // claim back so the row stays due without spending an attempt.
  if (intent.desired === "in_progress") {
    await releaseCheckClaim(db, attemptId, lease, now());
    return;
  }
  if (intent.desiredTitle === null || intent.desiredSummary === null) return;

  const frozen: CheckConclusion = {
    desired: intent.desired,
    title: intent.desiredTitle,
    summary: intent.desiredSummary,
  };

  // 3. Known remote id → GET/validate ownership before any update; otherwise
  //    adopt the run this attempt already created before considering a create.
  let checkRunId = intent.checkRunId;
  if (checkRunId === null) {
    // Adoption runs FIRST, always (spec §7.11.2 step 3): it is the only
    // honest way to answer "did a create land?" without minting a second run.
    // Adoption is READ-ONLY, so it is legal even for a paused App — §7.6 lets
    // a paused Check be discovered, it only forbids producing a new one.
    const adopted = await resolved.adapter.adoptCheckRun({ identity: intent.identity });
    if (budget.refused) {
      await releaseCheckClaim(db, attemptId, lease, now());
      return;
    }
    if (adopted.kind === "found") {
      // An adopted run is attached only through the store's legal transition,
      // which requires a create to have been attempted. A `not-sent` row that
      // nevertheless has a matching run is a durable contradiction: creating
      // again would mint a duplicate for the same head, so it is settled
      // honestly instead (RL-12 forbids the blind recreate either way).
      const attached = await attachCheckRunId(db, attemptId, lease, adopted.remote.id, now());
      if (!attached) {
        await settleFailedAttempt(
          db, now, attemptsBefore, row, lease,
          `a matching run exists but the attempt's durable create state is '${intent.createState}' — attachment refused`,
          log, summary,
        );
        return;
      }
      checkRunId = adopted.remote.id;
    } else if (adopted.kind === "absent") {
      // Create ONLY from a definitively unsent state (RL-12). `sending`/
      // `unknown` mean a create may already have reached GitHub: absence was
      // observable, but an unobservable run is not proof none was created, so
      // that case stays recoverable rather than creating again.
      if (intent.createState !== "not-sent") {
        await settleFailedAttempt(
          db, now, attemptsBefore, row, lease,
          "a create may already have been sent and no run is observable — read-only adoption only",
          log, summary,
        );
        return;
      }
      // Pause / kill switch (spec §7.6): a paused App performs NO new Check.
      // The walk above proved the run was never created, so there is nothing
      // to terminalize either — the honest outcome is to leave the work due,
      // with the claim released and no attempt spent, until the App resumes.
      if (resolved.paused) {
        await releaseCheckClaim(db, attemptId, lease, now());
        log.info(
          { event: "ops_check_reconcile_paused_deferral", detail: `attempt=${attemptId}` },
          "paused App holds a never-sent Check — left due, no create",
        );
        return;
      }
      const ready = await resolved.adapter.beginCheck({ identity: intent.identity, lease });
      if (budget.refused) {
        await releaseCheckClaim(db, attemptId, lease, now());
        return;
      }
      if (ready.kind === "unavailable") {
        // `requests === 0` is the adapter's proof that the Checks callable was
        // never invoked — the durable `sending` mark has no request behind it
        // and the adapter has already rolled it back to `not-sent`. This is a
        // no-request refusal, so §7.11.2 step 5 applies exactly as it does to a
        // budget refusal: leave the row due without spending an attempt.
        //
        // The identity-fenced release is required rather than the liveness one:
        // a zero-request refusal is typically the live-time fence itself (the
        // lease expired while the client was resolved), so `releaseCheckClaim`
        // could write nothing on precisely the path that needs it.
        if (ready.requests === 0) {
          const released = await releaseExpiredCheckClaim(db, attemptId, lease, now());
          if (!released) {
            // The epoch/state moved under us: a newer claim owns the row now, so
            // its state is none of ours to touch. Nothing was charged and no
            // request was made; the row is left to its current owner.
            log.warn(
              { event: "ops_check_reconcile_zero_dispatch_release_missed", detail: `attempt=${attemptId}` },
              "zero-dispatch refusal hit a claim that had already moved",
            );
            return;
          }
          log.info(
            { event: "ops_check_reconcile_zero_dispatch_deferral", detail: `attempt=${attemptId}` },
            "no-request create refusal — row released, no attempt spent",
          );
          return;
        }
        // `requests > 0` (or an older adapter that cannot say): a create may
        // have reached GitHub. RL-12 honesty applies — adopt-only recovery with
        // a spent attempt and backoff.
        await settleFailedAttempt(db, now, attemptsBefore, row, lease, ready.reason, log, summary);
        return;
      }
      // Attach immediately, before any further request: if a later step is
      // deferred, the id is already durable and the next run adopts it.
      const attached = await attachCheckRunId(db, attemptId, lease, ready.remote.id, now());
      if (!attached) {
        await settleFailedAttempt(
          db, now, attemptsBefore, row, lease,
          "the created run could not be attached to this attempt's durable state",
          log, summary,
        );
        return;
      }
      checkRunId = ready.remote.id;
    } else {
      // `incomplete`/`ambiguous`: the walk could not PROVE absence, so no
      // create is legal and the row stays due with its attempt deferred.
      await settleFailedAttempt(
        db, now, attemptsBefore, row, lease,
        `adoption is ${adopted.kind} — absence unproven, no create`,
        log, summary,
      );
      return;
    }
  }

  // 4. Terminalize the owned run and record `observed` only from a validated
  //    response that matches the persisted intent.
  const fetched = await resolved.adapter.fetchCheckRun({ identity: intent.identity, checkRunId });
  if (budget.refused) {
    await releaseCheckClaim(db, attemptId, lease, now());
    return;
  }
  if (fetched.kind === "unavailable") {
    await settleFailedAttempt(db, now, attemptsBefore, row, lease, fetched.reason, log, summary);
    return;
  }
  if (fetched.kind === "absent") {
    // The recorded remote id is RETAINED (never cleared to create a lookalike);
    // a vanished run is reported honestly and retried under the same identity.
    await settleFailedAttempt(db, now, attemptsBefore, row, lease, "the recorded check run is absent remotely", log, summary);
    return;
  }
  if (fetched.remote.status === "completed") {
    const recorded = await recordTerminal(db, attemptId, lease, fetched.remote, frozen, now, summary);
    if (recorded === "mismatch") {
      await settleFailedAttempt(
        db, now, attemptsBefore, row, lease,
        `remote run concluded ${fetched.remote.conclusion ?? "null"}, persisted intent is ${frozen.desired}`,
        log, summary,
      );
    }
    return;
  }

  const completed = await resolved.adapter.completeCheck({
    identity: intent.identity,
    lease,
    checkRunId,
    conclusion: frozen,
  });
  if (budget.refused) {
    await releaseCheckClaim(db, attemptId, lease, now());
    return;
  }
  if (completed.kind === "unavailable") {
    // §7.11.2 step 4: preserve desired and actual observed, stay
    // `remote-unconfirmed`, back off, release the lease.
    await settleFailedAttempt(db, now, attemptsBefore, row, lease, completed.reason, log, summary);
    return;
  }
  const recorded = await recordTerminal(db, attemptId, lease, completed.remote, frozen, now, summary);
  if (recorded === "mismatch") {
    await settleFailedAttempt(
      db, now, attemptsBefore, row, lease,
      "the validated response did not match the persisted terminal intent",
      log, summary,
    );
  }
}

/**
 * Advance `observed` from a validated remote terminal payload. The store
 * re-checks identity, status and the intended conclusion against the fenced
 * row, so an old-epoch response (the row has moved on) writes nothing.
 * Returns `mismatch` when the payload is a different outcome than intended,
 * `lost` when the fence no longer belongs to this invocation.
 */
async function recordTerminal(
  db: D1Like,
  attemptId: string,
  lease: Lease,
  remote: CheckRemote,
  frozen: CheckConclusion,
  now: () => number,
  summary: CheckReconcileSummary,
): Promise<"recorded" | "mismatch" | "lost"> {
  const agrees = remote.status === "completed" && remote.conclusion === frozen.desired;
  if (!agrees) return "mismatch";
  const written = await recordCheckObservation(db, attemptId, lease, remote, now());
  if (!written) return "lost";
  summary.completed += 1;
  return "recorded";
}

/**
 * One failed recovery action: backoff (1/2/4/8/16 min) or, at the 5-attempt
 * cap, a terminal `local-error` with the structured App/scope/work-ID line.
 * The row, its external id and any known remote run id are RETAINED — nothing
 * here drops work or claims the remote finished.
 *
 * `attemptsBefore` is the count read back through the CLAIM's fence, never the
 * selected row's copy: a row whose attempts moved between selection and claim
 * must not feed a stale number into the ladder or the cap test.
 */
async function settleFailedAttempt(
  db: D1Like,
  now: () => number,
  attemptsBefore: number,
  row: CheckAttempt,
  lease: Lease,
  reason: string,
  log: CheckReconcileLog,
  summary: CheckReconcileSummary,
): Promise<void> {
  const attemptId = row.identity.attemptId;
  const attemptsAfter = attemptsBefore + 1; // this recovery claimed exactly one
  if (attemptsAfter >= CHECK_MAX_ATTEMPTS) {
    const line = giveUpLine(row.identity.scope, attemptId, attemptsAfter, reason);
    const marked = await markCheckLocalError(db, attemptId, lease, line, now());
    if (marked) {
      summary.gaveUp += 1;
      log.warn({ event: "ops_check_reconcile_gave_up", detail: line }, "check recovery gave up at the attempt cap");
    } else {
      // The fence moved before the give-up could be written: the row belongs
      // to whoever holds it now, and nothing was marked.
      summary.errors += 1;
    }
    return;
  }
  const deferred = await deferCheckRecovery(
    db,
    attemptId,
    lease,
    { state: "remote-unconfirmed", nextAttemptMs: now() + backoffFor(attemptsAfter), reason },
    now(),
  );
  if (deferred) summary.unconfirmed += 1;
  summary.errors += 1;
}

/**
 * The pair's credential resolution, cached per run. A resolution that failed
 * because the RUN refused a request is NOT cached and does NOT suspend the
 * pair: that is a budget deferral, not evidence about the App.
 */
async function credentialsForPair(
  db: D1Like,
  env: ScheduledEnv,
  scope: Scope,
  now: () => number,
  budget: RunBudget,
  transport: CheckTransport,
  credentials: CheckCredentialFactory,
  cache: Map<string, Promise<CheckCredentialResolution>>,
  log: CheckReconcileLog,
  summary: CheckReconcileSummary,
): Promise<CheckCredentialResolution> {
  const key = `${scope.appId}:${scope.installationId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  // Preflight admission for the credential lane (probe + mint). Refused →
  // stop before any claim; the row stays due and no attempt is spent.
  if (!canSpend(budget, now(), CREDENTIAL_REQUESTS, false)) {
    budget.refused = true;
    return { kind: "unavailable", reason: "decrypt-failed" };
  }
  let refusedDuringProbe = false;
  const resolution = (async () => {
    try {
      const settled = await credentials({ db, env, scope, now, transport });
      if (settled.kind === "unavailable" && budget.refused) refusedDuringProbe = true;
      return settled;
    } catch (error) {
      log.warn(
        { event: "ops_check_reconcile_credential_failed", detail: error instanceof Error ? error.message : String(error) },
        "check credential factory threw — pair treated as unavailable",
      );
      return { kind: "unavailable", reason: "decrypt-failed" } satisfies CheckCredentialResolution;
    }
  })();
  cache.set(key, resolution);
  const settled = await resolution;
  if (refusedDuringProbe) {
    // The probe never dispatched: this says nothing about the App. Do not
    // cache the refusal (the next row must re-ask) and do not suspend.
    cache.delete(key);
    return { kind: "unavailable", reason: "decrypt-failed" };
  }
  if (settled.kind === "unavailable") {
    const reason = `app ${UNAVAILABLE_REASON_TEXT[settled.reason]} — no Check mutation for (${scope.appId}, ${scope.installationId})`;
    const suspended = await suspendCheckRecovery(
      db,
      { appId: scope.appId, installationId: scope.installationId },
      reason,
      now(),
    );
    summary.suspended += suspended;
    log.warn({ event: "ops_check_reconcile_pair_suspended", detail: reason }, "credential routing unavailable — pair suspended durably");
  }
  return settled;
}

/**
 * Read the exact-scope persisted publication proof (normal proof preferred
 * over degraded, this attempt's publication id first). A read failure is
 * UNPROVEN, never "not published".
 */
async function readProof(db: D1Like, owned: CheckOwnership): Promise<PublicationProof | null> {
  try {
    return await readPublicationProof(db, {
      scope: owned.identity.scope,
      headSha: owned.identity.headSha,
      ...(owned.publicationId === null ? {} : { publicationId: owned.publicationId }),
    });
  } catch {
    return null;
  }
}

/**
 * The terminal conclusion for a due attempt (spec §7.9 matrix): a persisted
 * publication proof decides `success`/`neutral` regardless of how the attempt
 * expired; an expired attempt with no proof is the honest unconfirmed
 * `failure`. An intent the consumer already persisted is preserved verbatim —
 * this lane only ever corrects it upward, on proof.
 */
function terminalConclusion(owned: CheckOwnership, proof: PublicationProof | null): CheckConclusion {
  if (proof !== null) return decideConclusion({ proof, outcome: "expired" });
  if (owned.desired === "in_progress") return decideConclusion({ proof: null, outcome: "expired" });
  return {
    desired: owned.desired,
    title: owned.desiredTitle ?? CHECK_NAME,
    summary: owned.desiredSummary ?? CHECK_SUMMARIES.unconfirmed,
  };
}

/**
 * The §7.11.2 operator surface: reopen RECOVERY of the same historical Check
 * identity (the store owns the fenced conditional UPDATE — see
 * `src/store/review-checks.ts`). Generation, external id, remote run id, the
 * published proof link and `observed` are all retained; nothing restarts model
 * work, a live lease is refused, and a suspended App stays suspended until its
 * explicit re-enable.
 */
export { retryCheckRecovery } from "../store/review-checks";
