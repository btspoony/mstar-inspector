/**
 * M7 Check recovery reconciler (spec review-lifecycle
 * §7.11.2) — the second independent cron lane, composed after the M8
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
 *   send, replay or paid re-review; the publication lane — composed before this one
 *   — is the only writer of that proof.
 * - **Throw-proof.** Every row is isolated, and the whole pass is wrapped: a
 *   recovery failure is logged and folded into `errors`, so nothing ever
 *   escapes into `scheduled`.
 */

import type { ScheduledEnv } from "./env";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { D1Like } from "../store/types";
import {
  attachCheckRunId,
  CHECK_MAX_ATTEMPTS,
  CHECK_NAME,
  CHECK_RECONCILE_LIMIT,
  CHECK_BACKOFF_MS,
  checkSuspensionKindOf,
  checkSuspensionReason,
  claimCheckRecovery,
  type CheckAttempt,
  type CheckConclusion,
  type CheckRemote,
  deferCheckForPendingPublication,
  deferCheckRecovery,
  getCheckAttempt,
  getCheckOwnership,
  listCheckReconcileBatch,
  listReenableableCheckPairs,
  markCheckLocalError,
  readPublicationProof,
  readPublishedReview,
  recordCheckObservation,
  reenableChecksForApps,
  releaseCheckClaim,
  releaseExpiredCheckClaim,
  setCheckDesired,
  suspendCheckForPause,
  suspendCheckRecovery,
} from "../store/review-checks";
import type { CheckIdentity, CheckOwnership, Lease, PublicationProof, PublishedReview } from "../store/review-checks";
import { findPublicationJournal, PUBLICATION_PROOF_WAIT_PHASES } from "../store/finding-lifecycle";
import {
  CHECK_SUMMARIES,
  CheckRequestNotDispatched,
  decideConclusion,
  isRequestNotDispatched,
  type ChecksAdapter,
  type ReviewGate,
  type UnconfirmedCause,
} from "../pipeline/checks";
import type { ReviewCommenter } from "../pipeline/comment";
import { createReviewCommenter } from "../pipeline/comment";
import { createAppsStore } from "../dashboard/apps-store";
import { createSecretbox } from "../dashboard/secretbox";
import { getCheckBudgets } from "../dashboard/runtime-config-store";
import { sha256Hex } from "../pipeline/review-threads";
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
  /** Rows whose claim was given back to WAIT for an in-flight publication. */
  deferred: number;
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
  | {
      kind: "unavailable";
      reason: CheckCredentialReason;
      /**
       * Digest of the ENCRYPTED credential envelope this verdict was proved
       * against (never the plaintext key) — the M8 P67-QC-007 fingerprint. It
       * rides the suspension reason so a later pass can tell "same credentials,
       * same failure" from "the operator corrected the credentials", which is
       * what makes an identity-mismatch suspension durable instead of churning.
       */
      credentialFingerprint?: string;
    };

/**
 * Exact `(app_id, installation_id)` credential routing for the Check lane.
 * The production implementation is the §7.6 chain — routing gates → decrypt →
 * the ONE `createReviewCommenter` construction point per pair per run (whose
 * `checks: "write"` mint and Checks client are the §7.9 adapter) → live
 * `GET /app` identity proof. No second `createAppAuth`, no second client.
 */
export type CheckCredentialFactory = (input: {
  db: D1Like;
  env: ScheduledEnv;
  scope: Scope;
  now: () => number;
  transport: CheckTransport;
  /**
   * The operator-configured `review.check.update_timeout_ms`, read ONCE per
   * reconcile run and threaded down. Omitted → the adapter's documented
   * default (injected factories and tests may ignore it).
   */
  updateBudgetMs?: number;
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
    // shortcut: tenant-bypass — check credential routing by exact (app_id,
    // installation_id); returns no tenant-facing field. Upgrade: tenant-filter it
    // once check reconciliation becomes workspace-scoped.
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
 * `checks` adapter is the only mint surface. The live identity probe proves the
 * routed `github_app_id` is the App these credentials actually authenticate
 * as before any Check request is allowed.
 *
 * Pause (`review_enabled = 0`) does NOT make the pair unusable — credentials
 * are still minted so the lane can adopt and terminalize a Check that already
 * exists — but the flag rides the resolution because §7.6 forbids a paused App
 * from producing a NEW Check. The lane, not this factory, owns that gate.
 */
export const productionCheckCredentials: CheckCredentialFactory = async ({ db, env, scope, now, transport, updateBudgetMs }) => {
  const row = await checkRoutingRow(db, scope.appId, scope.installationId);
  if (row === null) return { kind: "unavailable", reason: "missing" };
  if (row.deleted_at !== null) return { kind: "unavailable", reason: "deleted" };
  if (row.status !== "active") return { kind: "unavailable", reason: "disabled" };
  // The suspension fingerprint binds a durable mismatch to the credentials it
  // was proven against (P68-QC-003, the M8 P67-QC-007 contract): digesting the
  // ENCRYPTED envelope means the value can be persisted and compared without
  // ever exposing or re-deriving the private key, and no plaintext credential
  // is logged or stored.
  const credentialFingerprint = await sha256Hex(row.private_key_enc);
  try {
    const pem = await createSecretbox(env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    // The single construction point (§7.6): `db` wires the Checks adapter,
    // `nowMs` fences every local send on the run's clock, and `fetchImpl`
    // routes every request (including auth-app's own mint POST) through the
    // run's bounded transport.
    const commenter: ReviewCommenter = createReviewCommenter(
      { APP_ID: String(row.github_app_id), PRIVATE_KEY: pem },
      { db, nowMs: now, fetchImpl: transport.fetchImpl, checksUpdateBudgetMs: updateBudgetMs },
    );
    const identity = (await commenter.getAppIdentity?.()) ?? null;
    if (identity === null || identity.githubAppId !== row.github_app_id) {
      return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint };
    }
    const adapter = commenter.checks;
    if (adapter === undefined) return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
    return { kind: "ok", adapter, paused: row.review_enabled === 0 };
  } catch {
    // missing key / tampered envelope — fail closed, never a mutation
    return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
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
  /** True while a row's iteration is open, so its requests debit `rowSpent`. */
  rowActive: boolean;
  /**
   * Set when a request was refused BEFORE dispatch. The caller must then stop
   * without spending an attempt — the work item stays due — and must not
   * interpret the resulting `unavailable` as a credential failure.
   */
  refused: boolean;
};

/**
 * Non-mutating preflight admission, consulted at three points: before a
 * credential probe, before a row's work, and at every individual request in
 * the transport.
 *
 * THE ACCOUNTING RULE (P68-QC-004 — one rule, stated once, matching what is
 * enforced): **every actual metered request while a row is active is charged
 * to BOTH the run cap (`spent`, ≤100) and that row's cap (`rowSpent`, ≤6)** —
 * including the pair's credential probe and installation-token mint, because
 * they are real GitHub requests issued while the row is being worked.
 *
 * The only asymmetry is in ADMISSION, and it is deliberate: the credential
 * preflight consults the RUN cap only (`rowScoped = false`), because at that
 * moment no request has yet been attributed to the row and the probe is
 * once-per-pair work whose cost is not knowable per row. The `rowScoped = true`
 * path is what the transport uses, so a probe that then dispatches IS charged
 * to the row it was made for. Admission therefore never over-promises: the run
 * cap bounds every path, and the row cap binds from the first request onward.
 *
 * Consequence, accepted and measured rather than hidden: the first row of each
 * pair starts its own work with `rowSpent = 2` (probe + mint), so a maximal
 * 5-request row path (two-page adoption + create + fetch + update) can be
 * deferred once by the ≤6 bound and completed on the next pass, where the
 * pair's credentials are cached and the row gets the full allowance. Refusals
 * are pre-dispatch, uncharged beyond what already dispatched, and leave the row
 * due with no attempt spent, so this costs one bounded cron cycle and never a
 * correctness, honesty or budget breach. Both caps and the ≤5s per-request
 * bound are unchanged.
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
 * The enforced per-request transport bound AND the actual-request meter: every
 * request gets an abort signal at `min(5s, time left in the run)` computed AT
 * the request, so a request issued late cannot outlive the run. Metering lives
 * here — the single choke point every request funnels through — because a
 * per-operation estimate can never bound what a paginating scan actually
 * issues.
 *
 * A request that cannot be admitted fails BEFORE dispatch by throwing the
 * UPSTREAM typed marker (`CheckRequestNotDispatched`, `src/pipeline/checks.ts`)
 * — the same class the adapter's `sendRequests` classifies — so a pre-dispatch
 * refusal is provably zero-dispatched end to end: the adapter reports
 * `requests: 0`, rolls a `sending` mark back under identity fencing, and this
 * lane releases the claim without spending an attempt. A local look-alike
 * class would be a second, unrecognized grammar: `sendRequests` walks for the
 * shared marker by identity, so a private twin could never be classified and
 * the refusal would be reported as a possibly-sent request — the exact defect
 * P68-QC-005 names.
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
          new CheckRequestNotDispatched(
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

/**
 * The rung for the next proof-wait defer, from the SAME ladder the attempt
 * path backs off on. The wait spends no attempt, so `backoffFor` cannot place
 * it; its own elapsed time does. Every rung the wait has already outlived
 * widens the next one, so a publication that never proves itself is re-probed
 * a handful of times inside the window instead of every minute.
 */
function waitRungMs(attempt: CheckAttempt, nowMs: number): number {
  let outlivedMs = 0;
  for (let index = 0; index < CHECK_BACKOFF_MS.length; index += 1) {
    outlivedMs += CHECK_BACKOFF_MS[index]!;
    if (nowMs - attempt.createdAtMs < outlivedMs) return CHECK_BACKOFF_MS[index]!;
  }
  return CHECK_BACKOFF_MS[CHECK_BACKOFF_MS.length - 1]!;
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
    examined: 0, completed: 0, unconfirmed: 0, suspended: 0, gaveUp: 0, errors: 0, deferred: 0,
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
    // §7.10 Check budgets: ONE read per run (never per App, never per row), so
    // the lane's inherent 5 s request cap is tightened by whatever the operator
    // configured. A degraded read answers the documented defaults and logs one
    // line — it must never throw or abort the reconciliation.
    const checkBudgets = await getCheckBudgets(db);
    if (checkBudgets.degraded) {
      log.warn(
        {
          event: "ops_check_reconcile_budgets_degraded",
          detail: "check budgets unreadable — using the documented defaults",
        },
        "check reconcile budgets degraded",
      );
    }
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

    // 0. Suspension-aware re-enable (spec §7.6 / P68-QC-003): a disabled App
    //    resumes on status alone; a credential-suspended pair resumes only on a
    //    live proof after its envelope actually CHANGED. An unchanged envelope
    //    is skipped with no probe and no write, so an identity-mismatch pair
    //    stops occupying the bounded due batch and stops paying a remote probe
    //    on every cron pass.
    await reenableHealthyAppChecks(env, db, now, budget, credentials, transport, log, checkBudgets.updateMs);

    // 1. Due attempts, ONE bound nowMs at every predicate position.
    const rows = await listCheckReconcileBatch(db, now(), CHECK_MAX_ATTEMPTS, CHECK_RECONCILE_LIMIT);
    for (const row of rows) {
      summary.examined += 1;
      budget.rowSpent = 0;
      budget.refused = false;
      budget.rowActive = true;
      try {
        await reconcileCheckAttempt(env, db, now, budget, transport, credentials, credentialCache, row, log, summary, checkBudgets.updateMs);
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
 * §7.11.2 step 6's re-enable half (P68-QC-003). Resuming a suspended pair is
 * decision-heavy and the M8 lane's P67-QC-007 lesson is the contract: an
 * unchanged credential failure must NOT be re-probed and re-suspended every
 * pass, because its rows then never converge and permanently occupy the bounded
 * 25-row due batch.
 *
 * The scan is exact-pair, bounded, deterministic and D1-only while nothing has
 * changed:
 *
 *  1. Candidate pairs are drawn from the SUSPENDED rows themselves, so a pair
 *     is considered exactly when it holds suspended Check work — never a window
 *     over every App in the deployment.
 *  2. For each, the durable suspension kind and the encrypted-envelope digest
 *     are read from `review_checks.last_error` (the same grammar M8 writes), and
 *     the CURRENT digest is re-derived from `github_apps.private_key_enc`.
 *  3. An unchanged digest is SKIPPED with no probe and no write. A changed
 *     digest — the operator's correction — is the one event that reopens the
 *     identity question, and it costs a real credential probe whose verdict
 *     either resumes the pair or re-stamps the suspension with the new digest.
 *  4. `disabled` suspensions still resume on App status alone, because status
 *     is legitimate proof for that kind and no credential was ever in question.
 *
 * No stale credential object is trusted: a resumed pair always goes through the
 * ordinary row loop, which resolves credentials afresh and proves live identity
 * before any request.
 */
async function reenableHealthyAppChecks(
  env: ScheduledEnv,
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  credentials: CheckCredentialFactory,
  transport: CheckTransport,
  log: CheckReconcileLog,
  updateBudgetMs: number | undefined,
): Promise<void> {
  const { results: suspended } = await db
    // shortcut: tenant-bypass — bounded reconciliation scan selecting ids only;
    // no tenant-facing field. Upgrade: tenant-filter it once check
    // reconciliation becomes workspace-scoped.
    .prepare(
      `SELECT DISTINCT rc.app_id AS app_id, rc.installation_id AS installation_id
         FROM review_checks rc
         JOIN github_apps ga ON ga.id = rc.app_id
        WHERE rc.recovery_state = 'suspended'
          AND ga.status = 'active' AND ga.deleted_at IS NULL
        ORDER BY rc.installation_id, rc.app_id
        LIMIT ?`,
    )
    .bind(REENABLE_PAIR_LIMIT)
    .all<{ app_id: string; installation_id: number }>();
  if (suspended.length === 0) return;

  // The current credential digest per pair, so an unchanged envelope is
  // detectable WITHOUT touching the network. A pair whose digest cannot be read
  // yields a null the store's rule handles (F-005).
  const candidates: { appId: string; installationId: number; currentFingerprint: string | null }[] = [];
  for (const pair of suspended) {
    const routing = await checkRoutingRow(db, pair.app_id, pair.installation_id);
    const currentFingerprint = routing === null ? null : await sha256Hex(routing.private_key_enc);
    candidates.push({
      appId: pair.app_id,
      installationId: pair.installation_id,
      currentFingerprint,
    });
  }

  // Status-only resumes (kind `disabled`/`paused`) and operator corrections
  // resolve here with no further probe; a pair suspended for a credential
  // reason with an UNCHANGED envelope is filtered out and never re-probed
  // (P68-QC-003).
  let resumable: { appId: string; installationId: number }[];
  try {
    resumable = await listReenableableCheckPairs(db, candidates);
  } catch (error) {
    log.warn(
      { event: "ops_check_reconcile_reenable_read_failed", detail: error instanceof Error ? error.message : String(error) },
      "check re-enable scan failed — suspended rows stay suspended",
    );
    return;
  }
  if (resumable.length === 0) return;

  // A resume whose pair was suspended for a CREDENTIAL reason is allowed to
  // proceed only after a live probe proves the corrected credentials, so a
  // wrong key or a rotated credential re-suspends instead of running the row
  // loop against a still-broken pair. The probe is admission-gated (F-004).
  const confirmed: { appId: string; installationId: number }[] = [];
  for (const pair of resumable) {
    const probe = await reenableProbe(db, env, pair, now, budget, transport, credentials, updateBudgetMs);
    if (probe.kind === "resume") confirmed.push(pair);
    else if (probe.kind === "resuspend") {
      const reason = checkSuspensionReason(
        probe.reason,
        `app ${UNAVAILABLE_REASON_TEXT[probe.reason]} — no Check mutation for (${pair.appId}, ${pair.installationId})`,
        probe.credentialFingerprint,
      );
      await suspendCheckRecovery(db, pair, reason, now());
    } else if (probe.kind === "refused") {
      // Unaffordable or refused before dispatch: this pair's stored state —
      // kind, digest and reason — is left EXACTLY as it was, so a later pass
      // with budget re-asks. Writing a verdict here is what F-004 names.
      log.warn(
        { event: "ops_check_reconcile_reenable_probe_deferred", detail: `pair=(${pair.appId}, ${pair.installationId})` },
        "re-enable probe deferred — budget refused before dispatch, prior state retained",
      );
    }
    // `unchanged` (a digest that turned out equal on re-read) never resumes.
  }
  if (confirmed.length === 0) return;
  try {
    await reenableChecksForApps(db, confirmed, now());
  } catch (error) {
    log.warn(
      { event: "ops_check_reconcile_reenable_failed", detail: error instanceof Error ? error.message : String(error) },
      "check re-enable skipped — suspended rows stay suspended",
    );
  }
}

/**
 * The one probe that may resume a credential-suspended pair. `disabled` and
 * `paused` need none — App status and the kill switch are their own proofs —
 * so every other kind must be re-proved live before its rows return to the
 * batch, because a corrected envelope that still does not authenticate must
 * stay suspended rather than churn.
 *
 * The probe is a REAL request, so it passes the same admission discipline as
 * every other one (F-004). Two outcomes must never be recorded as a verdict:
 *
 *  - the estimate does not fit the run/deadline budget → the pair is skipped
 *    with NO probe and NO write, its previously recorded state (including the
 *    digest the no-churn filter reads) left exactly as it was so a later pass
 *    can retry; and
 *  - the shared transport refused a request BEFORE dispatch → that is a
 *    deferral, not evidence about credentials. Converting it into a verdict
 *    would `decrypt-failed`-stamp the CURRENT digest, and the no-churn filter
 *    would then read that digest as "credentials demonstrably unchanged" and
 *    suppress every future probe — durably stranding rows whose credentials
 *    work. This mirrors exactly how `credentialsForPair` consumes
 *    `budget.refused` on the row path.
 */
async function reenableProbe(
  db: D1Like,
  env: ScheduledEnv,
  pair: { appId: string; installationId: number },
  now: () => number,
  budget: RunBudget,
  transport: CheckTransport,
  credentials: CheckCredentialFactory,
  updateBudgetMs: number | undefined,
): Promise<
  | { kind: "resume" }
  | { kind: "unchanged" }
  | { kind: "refused" }
  | { kind: "resuspend"; reason: CheckCredentialReason; credentialFingerprint?: string }
> {
  const rows = await db
    // shortcut: tenant-bypass — per-pair Check resume probe selecting the kill
    // switch only; no tenant-facing field. Upgrade: tenant-filter it once the
    // check store becomes workspace-scoped.
    .prepare(
      `SELECT rc.last_error, ga.review_enabled
         FROM review_checks rc
         JOIN github_apps ga ON ga.id = rc.app_id
        WHERE rc.app_id = ? AND rc.installation_id = ? AND rc.recovery_state = 'suspended'`,
    )
    .bind(pair.appId, pair.installationId)
    .all<{ last_error: string | null; review_enabled: number }>();
  // A pair may hold mixed suspension kinds (the kill-switch hold is per row, a
  // credential suspension covers the pair). A row whose kill switch is STILL
  // off blocks every path, including the credential probe below: resuming a
  // held row because a sibling looks provable is exactly the mixed-kind
  // mistake this pair read exists to prevent.
  const kinds = rows.results.map((row) => checkSuspensionKindOf(row.last_error));
  if (rows.results.some((row, index) => kinds[index] === "paused" && row.review_enabled === 0)) {
    return { kind: "unchanged" };
  }
  // Only when EVERY suspended row is status-resumable may this skip the
  // credential probe: `disabled` was proved by App status and a LIFTED
  // `paused` by the switch, and neither owes a proof.
  if (kinds.length > 0 && kinds.every((kind) => kind === "disabled" || kind === "paused")) {
    return { kind: "resume" };
  }
  // Admission BEFORE the factory (M8's discipline): an unaffordable probe must
  // not run at all, so nothing is written and the pair stays retryable.
  if (!canSpend(budget, now(), CREDENTIAL_REQUESTS, false)) return { kind: "refused" };
  // Scoped to THIS probe: the flag is shared run state, so it is cleared
  // immediately before the call and read immediately after.
  budget.refused = false;
  try {
    const settled = await credentials({
      db,
      env,
      scope: { appId: pair.appId, installationId: pair.installationId, owner: "", repo: "", prNumber: 0 },
      now,
      transport,
      updateBudgetMs,
    });
    // A pre-dispatch refusal is a deferral, never a credential verdict.
    if (budget.refused) return { kind: "refused" };
    if (settled.kind === "ok") return { kind: "resume" };
    return {
      kind: "resuspend",
      reason: settled.reason,
      ...(settled.credentialFingerprint === undefined ? {} : { credentialFingerprint: settled.credentialFingerprint }),
    };
  } catch (error) {
    // A refusal that reached the caller as a throw is still a deferral, not
    // evidence about credentials — recognized by the SHARED typed marker
    // (walking the error chain, exactly as `sendRequests` does) as well as by
    // the flag, because a factory may rethrow rather than return. Anything else
    // is a real failure and is recorded as one.
    if (budget.refused || isRequestNotDispatched(error)) return { kind: "refused" };
    return { kind: "resuspend", reason: "decrypt-failed" };
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
  updateBudgetMs: number | undefined,
): Promise<void> {
  const attemptId = row.identity.attemptId;
  const scope = row.identity.scope;

  // §7.11.2 step 2a — the publication-proof WAIT, decided BEFORE any credential
  // work: a row that is only waiting must not mint GitHub requests, and it must
  // not push terminal rows behind its App-identity probe. While the exact
  // scope/head still owes a proof, and the execution deadline is ahead, the row
  // is not concludable yet: claim it (D1 only) and give the claim straight
  // back, spending no attempt.
  //
  // The publication that answers for this attempt is the NEWEST journal row for
  // the exact scope/head whose LAST WRITE landed at or after this attempt was
  // admitted — one row exists per scope/head/kind and the writer REUSES it for
  // a same-head re-trigger, so creation time cannot separate generations, but
  // a write this attempt caused (stage/claim/proof) can. Conflict-reuse alone
  // writes nothing, so a prior generation's row that nobody stamped after
  // admission stays unattributed. The wait is bound to that row: its readable
  // proof ENDS the wait and is read by that exact id. Abandonment is not a
  // conclusion, so an abandoned attempt keeps its own `publication_id` NULL,
  // and once its review publishes that row's id is the only proof its Check
  // can conclude from. Otherwise only this attempt's own `publication_id` link
  // counts — never a head-matched proof, so the wait is bounded by that write
  // or, failing it, by the deadline. Neither `reviews` nor `review_failures`
  // carries attempt identity either, so their rows cannot end it early.
  let proofPublicationId: string | null = row.publicationId;
  // The attempt's own deadline is the wait's hard stop: past it the row must
  // conclude. The SAME journal probe still runs — not to wait, but to name the
  // proof the deadline could not read and to end on a proof that did land.
  const beforeDeadline = now() < row.executionDeadlineMs;
  const pending = await probePendingPublication(db, row);
  // `pending` (a readable journal row still without proof) and `unknown` (an
  // unreadable journal read) both defer. `proven` supplies the id to conclude
  // from; `none` leaves the decision to this attempt's own link, and a null
  // link keeps waiting — the publication may simply not be prepared yet.
  if (pending.kind === "proven") proofPublicationId = pending.publicationId;
  // A `pending` row carries its own id too, but only an attempt with NO link of
  // its own reads it: past the deadline the proof read then answers `unproven`
  // (proof bytes absent) or `unreadable` (present but malformed) from THAT row,
  // instead of the link-less `unlinked` that would report "the proof never
  // landed" over proof bytes that exist. A link already names this attempt's
  // publication, so a proof-less row must never displace it.
  else if (pending.kind === "pending" && proofPublicationId === null) {
    proofPublicationId = pending.publicationId;
  }
  if (beforeDeadline) {
    // The D1 half of the pair gate runs BEFORE the wait (spec §7.6, §7.11.2
    // step 2): a row whose App is disabled/deleted or whose installation
    // mapping vanished must take the durable suspension path, never loop with
    // its Check never converging. That holds for a wait-terminal row too — the
    // gate leads the wait, so the dead-attempt short-circuit below must not
    // skip it.
    const unusable = await pairUnusableReason(db, scope);
    if (unusable !== null) {
      await suspendUnusablePair(db, scope, unusable, undefined, now, log, summary);
      return;
    }
    // Terminal for the WAIT: nothing was staged for this attempt and it links
    // no publication of its own, so no later read in this lane can change that
    // answer. It is NOT a conclusion — the deadline concludes it, naming the
    // missing evidence `unstaged` — and it is not a defer either: the row stays
    // due, so the pass costs the probe and the pair gate, and a journal row
    // that DOES appear is still seen on the next tick.
    if (waitIsTerminal(pending, proofPublicationId)) return;
    const waiting =
      pending.kind === "pending" ||
      pending.kind === "unknown" ||
      (await readProof(db, row.identity, proofPublicationId)).kind !== "read";
    if (waiting) {
      const waitingLease = await claimCheckRecovery(db, attemptId, HOLDER, now());
      if (waitingLease === null) return;
      const nextAttemptMs = now() + waitRungMs(row, now());
      if (!(await deferCheckForPendingPublication(db, attemptId, waitingLease, nextAttemptMs, now()))) return;
      summary.deferred += 1;
      log.info(
        {
          event: "check_recovery_deferred_pending_publication",
          attempt_id: attemptId,
          // The PROBE's answer and the journal's phase are different facts: a
          // readable journal whose phase is literally 'unknown' must not be
          // confused with a failed read.
          probe_state: pending.kind,
          ...(pending.kind === "pending" ? { phase: pending.phase } : {}),
          next_attempt_ms: nextAttemptMs,
        },
        "check recovery waiting for the publication proof — claim given back, no attempt spent",
      );
      return;
    }
  }

  // The pair's credential path first: a pair that cannot be used must be
  // suspended, not claimed (no ownership is taken for work that cannot run).
  const resolved = await credentialsForPair(db, env, scope, now, budget, transport, credentials, credentialCache, log, summary, updateBudgetMs);
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
  //    or paid re-review. The id is the wait's attributed one (the newest
  //    journal row's own publication), falling back to the link the claim read.
  const proofSourceId = proofPublicationId ?? owned.publicationId;
  const proofRead = await readProof(db, owned.identity, proofSourceId);
  const proof = proofRead.kind === "read" ? proofRead.proof : null;
  // The gate decision needs the App's stored gate and the review THIS proof
  // published. A missing or corrupt gate row, or a tallies-free review, is
  // unreadable, so it can never be corrected into a success (spec §7.9).
  // Both reads are guarded like the proof read above: a persistent read
  // failure must still leave the row a persisted terminal conclusion, never a
  // throw that keeps re-selecting the same due attempt forever.
  const [gate, review] = await Promise.all([
    readRecoveryGate(db, scope.appId),
    readRecoveryReview(db, owned, proof?.publicationId ?? null),
  ]);
  const conclusion = terminalConclusion(
    owned,
    proof,
    gate,
    review,
    beforeDeadline ? undefined : deadlineCause(pending, proofSourceId, proofRead),
  );

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
      // to terminalize either. Rather than releasing the claim and leaving the
      // row immediately due (which re-mints a client and re-walks adoption on
      // every cron window without progress — P68-QC-006), take the row out of
      // the due batch through the durable `paused` suspension: same attempt,
      // same identity, `attempts` untouched, and ZERO credential/adoption
      // requests while the pause lasts. The ordinary re-enable scan returns it
      // to the batch once `review_enabled` allows work, where the create runs
      // under a fresh claim.
      if (resolved.paused) {
        const deferred = await suspendCheckForPause(
          db,
          attemptId,
          lease,
          "App is paused (review_enabled = 0) — never-sent Check held until work is allowed",
          now(),
        );
        if (deferred) {
          summary.suspended += 1;
          log.info(
            { event: "ops_check_reconcile_paused_deferral", detail: `attempt=${attemptId}` },
            "paused App holds a never-sent Check — deferred out of the due batch, no create",
          );
        } else {
          // The fence moved; the row belongs to whoever holds it now.
          summary.errors += 1;
        }
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
  updateBudgetMs: number | undefined,
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
      const settled = await credentials({ db, env, scope, now, transport, updateBudgetMs });
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
    await suspendUnusablePair(db, scope, settled.reason, settled.credentialFingerprint, now, log, summary);
  }
  return settled;
}

/**
 * The durable pair suspension (spec §7.6 / P68-QC-003), shared by the
 * credential path and the pre-credential lifecycle gate: encode the KIND and
 * the encrypted-envelope digest in the record so a later pass can tell a
 * status-resumable `disabled` suspension from one that needs a live proof, and
 * can detect the operator's correction WITHOUT a probe. No plaintext credential
 * is ever stored or logged.
 */
async function suspendUnusablePair(
  db: D1Like,
  scope: Scope,
  credentialReason: CheckCredentialReason,
  credentialFingerprint: string | undefined,
  now: () => number,
  log: CheckReconcileLog,
  summary: CheckReconcileSummary,
): Promise<void> {
  const detail = `app ${UNAVAILABLE_REASON_TEXT[credentialReason]} — no Check mutation for (${scope.appId}, ${scope.installationId})`;
  const suspended = await suspendCheckRecovery(
    db,
    { appId: scope.appId, installationId: scope.installationId },
    checkSuspensionReason(credentialReason, detail, credentialFingerprint),
    now(),
  );
  summary.suspended += suspended;
  log.warn({ event: "ops_check_reconcile_pair_suspended", detail }, "credential routing unavailable — pair suspended durably");
}

/**
 * The D1-decidable half of the pair-usability gate (spec §7.6): the SAME
 * predicate `productionCheckCredentials` applies before any GitHub work —
 * missing installation mapping, soft-deleted App, or a disabled App. `null`
 * means the pair is usable as far as D1 can tell.
 *
 * It exists so the publication-proof WAIT cannot swallow the lifecycle gate: a
 * waiting row of an unusable pair must enter the durable `suspended` state,
 * exactly as it does on the credential path. Pause (`review_enabled = 0`) is
 * NOT part of this predicate — a paused App may still adopt and terminalize.
 */
async function pairUnusableReason(db: D1Like, scope: Scope): Promise<CheckCredentialReason | null> {
  const routing = await checkRoutingRow(db, scope.appId, scope.installationId);
  if (routing === null) return "missing";
  if (routing.deleted_at !== null) return "deleted";
  if (routing.status !== "active") return "disabled";
  return null;
}

/**
 * The proof of the publication THIS attempt owns — the one its own intent write
 * linked into `publication_id` (spec §7.9). The outcome distinguishes WHY it is
 * not a proof, because the deadline conclusion names the missing evidence:
 * `unlinked` (no publication row was staged for this attempt), `unproven` (the
 * linked row carries no proof), `unreadable` (the read itself failed).
 *
 * There is deliberately no head-keyed fallback. Under RL-12 a re-trigger reuses
 * the head, so another generation's publication for the SAME scope/SHA is
 * indistinguishable from this attempt's own except by that link; adopting its
 * proof would freeze this attempt's Check from an envelope it never published,
 * and the frozen row could never be corrected.
 */
type ProofRead =
  | { kind: "read"; proof: PublicationProof }
  | { kind: "unlinked" }
  | { kind: "unproven" }
  | { kind: "unreadable" };

async function readProof(
  db: D1Like,
  identity: CheckIdentity,
  publicationId?: string | null,
): Promise<ProofRead> {
  if (publicationId === null || publicationId === undefined) return { kind: "unlinked" };
  try {
    const proof = await readPublicationProof(db, {
      scope: identity.scope,
      headSha: identity.headSha,
      publicationId,
    });
    // The store reader prefers the linked row but still falls back to another
    // row of the same head; only the linked row's own proof is this attempt's.
    return proof !== null && proof.publicationId === publicationId
      ? { kind: "read", proof }
      : { kind: "unproven" };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * The App's gate, or `null` when it cannot be read (unknown row, corrupt
 * stored verdicts, or a failed read) — the same "unreadable" meaning the
 * consumer lane gets, so a review proof concludes `failure`. A read failure is
 * never a reason to abandon the row: the conclusion below still gets
 * persisted.
 */
async function readRecoveryGate(db: D1Like, appId: string): Promise<ReviewGate | null> {
  try {
    return await createAppsStore(db).getCheckGate(appId);
  } catch {
    return null;
  }
}

/**
 * The review THIS proof publication carried — the same preference the proof
 * read makes, so the Check is judged by the envelope the attempt published
 * rather than by the scope/SHA `reviews` projection, which can lag the apply
 * or belong to an earlier attempt for the same head SHA. A read failure is
 * UNREADABLE (`null`), which `decideConclusion` already treats as a failure —
 * never a pass, and never a throw out of the lane.
 */
async function readRecoveryReview(
  db: D1Like,
  owned: CheckOwnership,
  publicationId: string | null,
): Promise<PublishedReview | null> {
  try {
    return await readPublishedReview(db, {
      scope: owned.identity.scope,
      headSha: owned.identity.headSha,
      ...(publicationId === null ? {} : { publicationId }),
    });
  } catch {
    return null;
  }
}

/**
 * The §7.11.2 proof-wait probe's FOUR answers: a readable journal row still
 * without proof (`pending`), a readable journal row that HAS proved itself
 * (`proven`), no journal row for this attempt (`none`), or the journal table
 * could not be read (`unknown`). "unknown" is deliberately distinct from
 * "none": swallowing a read failure into "nothing pending" would terminalize
 * the unconfirmed failure on a publication that can still land seconds later.
 * The wait is bounded by the execution deadline, so treating "unknown" as
 * "keep waiting" can never loop forever.
 *
 * Every end-of-wait answer that names a journal row carries that row's own
 * publication id, so the caller decides from that exact publication and never
 * from a head match: `proven` concludes from it, and `pending` carries it so
 * the DEADLINE can read those proof bytes itself (absent -> `unproven`,
 * present-but-corrupt -> `unreadable`) instead of reporting `unlinked` and
 * claiming the proof never landed.
 */
type PendingPublication =
  | { kind: "pending"; phase: string; publicationId: string }
  | { kind: "proven"; publicationId: string }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * The wait's terminal shape, derived once and read by both ends of the lane:
 * no journal row has been staged since this attempt was admitted, and it links
 * no publication of its own. Nothing in the wait can ever answer such an
 * attempt, so probing it again cannot change the answer. It is still NOT a
 * conclusion — only the execution deadline concludes it, and
 * `deadlineCause` reports exactly this shape as `unstaged`.
 */
function waitIsTerminal(pending: PendingPublication, publicationId: string | null): boolean {
  return pending.kind === "none" && publicationId === null;
}

async function probePendingPublication(db: D1Like, attempt: CheckAttempt): Promise<PendingPublication> {
  // The wait is bound to ONE journal row — the NEWEST row for this exact
  // scope/head whose last write is at least as new as this attempt — because
  // that is the publication whose proof is still owed. A proof on some other
  // row (an older degraded publication, or a previous generation's row that
  // nothing stamped after this attempt was admitted) proves nothing about this
  // one: letting it end the wait would freeze a degraded failure while a newer
  // normal publication was still in flight.
  try {
    const journal = await findPublicationJournal(db, {
      scope: attempt.identity.scope,
      headSha: attempt.identity.headSha,
      // The hand-off set, `confirmed` included, plus `applied`: a confirmed
      // publication whose proof is not applied yet also reads as `proof ===
      // null`, and an abandoned attempt's publication is normally found
      // already applied. Concluding on the former would freeze an unconfirmed
      // failure that the arriving proof could no longer correct; the latter is
      // the proof the attempt owes its conclusion to.
      phases: PUBLICATION_PROOF_WAIT_PHASES,
      order: "newest",
      // Attribution is the row's LAST WRITE, not its creation: the writer
      // reuses one row per scope/head/kind, so a same-head re-trigger publishes
      // on a row inserted before this attempt. A write this attempt caused
      // (stage/claim/proof) stamps `updated_ms` afterwards; reuse alone stamps
      // nothing, so a prior generation's untouched row never attributes.
      writtenAtOrAfterMs: attempt.createdAtMs,
    });
    // No journal row: nothing has been handed off for this attempt yet, so THIS
    // probe has nothing to report — the caller's own linked proof read decides
    // whether the row is concludable.
    if (journal === null) return { kind: "none" };
    // A readable proof on that row ends the wait; the caller reads it by the
    // id returned here, exactly as it always did (never a head fallback).
    return journal.hasProof
      ? { kind: "proven", publicationId: journal.id }
      : { kind: "pending", phase: journal.phase, publicationId: journal.id };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Which evidence the deadline was missing, from the wait probe's answer and
 * this attempt's own proof read. Three causes — an attribution, not a
 * taxonomy: nothing was staged for this attempt (`none` plus no link), a staged
 * row whose proof never landed, or a read that failed (the journal's or the
 * proof's). A readable proof never reaches here: it decides.
 */
function deadlineCause(
  pending: PendingPublication,
  publicationId: string | null,
  read: ProofRead,
): UnconfirmedCause {
  if (pending.kind === "unknown" || read.kind === "unreadable") return "unreadable";
  if (waitIsTerminal(pending, publicationId)) return "unstaged";
  return "unproven";
}

/**
 * The terminal conclusion for a due attempt (spec §7.9 matrix): a persisted
 * publication proof decides the conclusion against the App gate — a normal
 * publication only succeeds when the applied review meets it — regardless of
 * how the attempt expired. The no-proof branch runs only once the wait above
 * has ended: the execution deadline passed, which makes the honest unconfirmed
 * `failure` the conclusion, and `unconfirmedCause` names the evidence that was
 * missing. An intent the consumer already persisted is preserved verbatim
 * unless a proof-derived correction applies. `gate` is the App's stored gate;
 * `null` means it could not be read, so a proof-derived conclusion fails closed
 * instead of assuming a default.
 */
function terminalConclusion(
  owned: CheckOwnership,
  proof: PublicationProof | null,
  gate: ReviewGate | null,
  review: PublishedReview | null,
  unconfirmedCause?: UnconfirmedCause,
): CheckConclusion {
  if (proof !== null) return decideConclusion({ proof, outcome: "expired", gate, review });
  if (owned.desired === "in_progress") {
    return decideConclusion({
      proof: null,
      outcome: "expired",
      gate,
      review,
      ...(unconfirmedCause === undefined ? {} : { unconfirmedCause }),
    });
  }
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
