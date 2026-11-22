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
import { getReconcileSettings } from "../dashboard/runtime-config-store";
import { RECONCILE_REQUEST_ESTIMATES, type ReconcileValues } from "../contracts/reconcile-settings";
import type { ScheduledEnv } from "./env";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import { clearCheckOwed, clearConcludedCheckOwed, deferCheckWithOwed } from "../pipeline/review-attempt";
import type { D1Like } from "../store/types";
import {
  attachCheckRunId,
  CHECK_NAME,
  CHECK_BACKOFF_MS,
  checkSuspensionKindOf,
  checkSuspensionReason,
  claimCheckRecovery,
  dropCheckCorrection,
  type CheckAttempt,
  type CheckConclusion,
  type CheckRemote,
  getCheckAttempt,
  getCheckOwnership,
  listCheckReconcileBatch,
  listReenableableCheckPairs,
  markCheckLocalError,
  parkCheckCorrection,
  readPublicationProof,
  readPublishedReview,
  readTerminalDispatch,
  recordCheckObservation,
  reenableChecksForApps,
  releaseCheckClaim,
  releaseExpiredCheckClaim,
  replaceCheckCorrection,
  reopenTerminalCorrection,
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
} from "../pipeline/checks";
import type { ReviewCommenter } from "../pipeline/comment";
import { createReviewCommenter } from "../pipeline/comment";
import { createReviewBotsStore } from "../dashboard/apps-store";
import {
  checkGateOf,
  createTargetsStore,
  readEffectiveTargetSettings,
  type ReviewTargetRow,
} from "../dashboard/targets-store";
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

/**
 * Preflight estimate for the credential lane (spec §7.11.2 "the App is
 * enabled"): the §7.5 live App-identity proof (`GET /app`) plus the
 * installation-token mint. Both are REAL requests metered at the transport;
 * this constant is only the admission estimate consulted before a pair is
 * built, and is never charged (charging an estimate on top of the metered
 * requests would double-count).
 */
const CREDENTIAL_REQUESTS = RECONCILE_REQUEST_ESTIMATES.credentials;

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
       * `review_bots.review_enabled = 0` (spec §7.6 pause / kill switch). A
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
 * Exact `(bot_id, installation_id)` credential routing for the Check lane.
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
  /**
   * Injectable fetch for the run's bounded transport; defaults to the global
   * one. Tests inject this so a reconciler pass cannot reach the network — the
   * per-request bound is a real 5 s timeout, so a live request makes a test's
   * runtime depend on GitHub's latency.
   */
  fetchImpl?: typeof fetch;
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
    // shortcut: tenant-bypass — check credential routing by exact (bot_id,
    // installation_id); returns no tenant-facing field. Upgrade: tenant-filter it
    // once check reconciliation becomes workspace-scoped.
    .prepare(
      `SELECT ga.id AS id, ga.github_app_id AS github_app_id, ga.status AS status,
              ga.deleted_at AS deleted_at, ga.review_enabled AS review_enabled,
              ga.private_key_enc AS private_key_enc
       FROM bot_installations ai
       JOIN review_bots ga ON ga.id = ai.bot_id
       WHERE ai.bot_id = ? AND ai.installation_id = ?`,
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
  settings: ReconcileValues;
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
  if (budget.spent + cost > budget.settings.checkMaxRequests) return false;
  if (nowMs >= budget.deadline) return false;
  if (rowScoped && budget.rowActive && budget.rowSpent + cost > budget.settings.checkRowMaxRequests) return false;
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
function buildTransport(budget: RunBudget, now: () => number, fetchImpl: typeof fetch = fetch): CheckTransport {
  const boundMs = (): number => Math.max(1, Math.min(budget.settings.checkPerRequestMs, budget.deadline - now()));
  return {
    boundMs,
    fetchImpl: (input, init) => {
      if (!canSpend(budget, now(), 1, true)) {
        budget.refused = true;
        return Promise.reject(
          new CheckRequestNotDispatched(
            `check recovery request budget exhausted (spent=${budget.spent}/${budget.settings.checkMaxRequests}, row=${budget.rowSpent}/${budget.settings.checkRowMaxRequests}) — request not dispatched; work stays due`,
          ),
        );
      }
      reserve(budget, 1);
      const timeout = AbortSignal.timeout(boundMs());
      const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout]);
      return fetchImpl(input, { ...init, signal });
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
    const settings = await getReconcileSettings(db);
    if (settings.issue) log.warn({ event: "ops_check_reconcile_settings_degraded", detail: JSON.stringify(settings.issue) }, "check reconcile settings unavailable — using defaults");
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
      settings: settings.values,
      spent: 0,
      deadline: now() + settings.values.checkRunBudgetMs,
      rowSpent: 0,
      rowActive: false,
      refused: false,
    };
    const transport = buildTransport(budget, now, deps.fetchImpl);
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
    // Retry path for the owed-Check marks: a clear that faulted, or a holder
    // that concluded the Check itself, leaves a mark whose Check is terminal.
    // One idempotent statement per pass, so the obligation cannot stay set.
    await clearConcludedCheckOwed(db).catch(() => {});
    const rows = await listCheckReconcileBatch(db, now(), budget.settings.checkMaxAttempts, budget.settings.checkSelectLimit);
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
 *     the CURRENT digest is re-derived from `review_bots.private_key_enc`.
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
      `SELECT DISTINCT rc.bot_id AS bot_id, rc.installation_id AS installation_id,
              CASE WHEN cur.id IS NULL OR (rc.installation_id, rc.bot_id) > (cur.installation_id, cur.bot_id)
                   THEN 0 ELSE 1 END AS wrapped
         FROM review_checks rc
         JOIN review_bots ga ON ga.id = rc.bot_id
         LEFT JOIN check_reenable_cursor cur ON cur.id = 1
        WHERE rc.recovery_state = 'suspended'
          AND ga.status = 'active' AND ga.deleted_at IS NULL
        ORDER BY wrapped, rc.installation_id, rc.bot_id
        LIMIT ?`,
    )
    .bind(budget.settings.checkSelectLimit)
    .all<{ bot_id: string; installation_id: number }>();
  if (suspended.length === 0) return;

  // Advance before any pair is judged, so a batch the filter rejects in full
  // (or a failing read below) still moves the next pass on; the scan wraps.
  // Trade-off: a pair deferred by the budget, or caught in a
  // `listReenableableCheckPairs` failure, is retried only after a full rotation.
  const last = suspended[suspended.length - 1]!;
  await db
    .prepare(
      `INSERT INTO check_reenable_cursor (id, installation_id, bot_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, bot_id = excluded.bot_id`,
    )
    .bind(last.installation_id, last.bot_id)
    .run();

  // The current credential digest per pair, so an unchanged envelope is
  // detectable WITHOUT touching the network. A pair whose digest cannot be read
  // yields a null the store's rule handles (F-005).
  const candidates: { appId: string; installationId: number; currentFingerprint: string | null }[] = [];
  for (const pair of suspended) {
    const routing = await checkRoutingRow(db, pair.bot_id, pair.installation_id);
    const currentFingerprint = routing === null ? null : await sha256Hex(routing.private_key_enc);
    candidates.push({
      appId: pair.bot_id,
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
         JOIN review_bots ga ON ga.id = rc.bot_id
        WHERE rc.bot_id = ? AND rc.installation_id = ? AND rc.recovery_state = 'suspended'`,
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
 * §7.9a late correction: a Check that was already published as an unconfirmed
 * failure is revised once when ITS OWN publication later confirms.
 *
 * The ordinary publish path freezes the unconfirmed fallback and links the
 * staged publication, so the Check reaches GitHub saying the outcome is
 * unknown. When that publication confirms moments later, the record asserts an
 * outcome the evidence now contradicts — so the record is not proof and must be
 * correctable. `reopenTerminalCorrection` is the guarded transition: it only
 * matches a terminal row still marked as an unconfirmed failure and linked to
 * THIS publication, and it clears that mark in the same statement, so the
 * revision happens exactly once.
 *
 * The proof is read through the row's OWN link first — a confirmation of any
 * other publication is not evidence about this row — and a pair that D1 cannot
 * use never reopens a terminal record (the record waits, unmutated, until the
 * App is healthy again). The reopened row then takes the ordinary path, which
 * re-decides the conclusion from the proof and sends it on the same owned run.
 */
async function reopenTerminalCheck(
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
  // A marked row always carries its link; without one no publication could ever
  // confirm what this record asserts.
  const publicationId = row.publicationId;
  if (publicationId === null) return;
  const proofRead = await readProof(db, row.identity, publicationId);
  // Not confirmed yet: the terminal record stands exactly as published, and
  // this pass writes nothing at all.
  if (proofRead.kind !== "read") return;
  if ((await pairUnusableReason(db, scope)) !== null) return;
  // The conclusion the revision owes, decided ONCE from the proof this row
  // linked — the same decision the ordinary attempt makes, so the deferred pass
  // has a durable conclusion to deliver instead of re-deriving one from
  // evidence that may have moved by then. An UNAVAILABLE read is not evidence:
  // writing a conclusion decided without the gate/review would record an owed
  // revision the row never deserved, so the terminal record stands untouched
  // and the next pass reads again.
  const [gateRead, reviewRead] = await Promise.all([
    readRecoveryGate(db, scope),
    readRecoveryReview(db, row.identity, publicationId),
  ]);
  if (gateRead.kind !== "read" || reviewRead.kind !== "read") return;
  const owed = decideConclusion({
    proof: proofRead.proof,
    outcome: "expired",
    gate: gateRead.value,
    review: reviewRead.value,
  });
  if (!(await reopenTerminalCorrection(db, attemptId, publicationId, owed.desired, now()))) return;
  log.info(
    { event: "ops_check_terminal_correction_reopened", attempt_id: attemptId, publication_id: publicationId },
    "terminal Check reopened for its own publication's confirmed outcome — one revision",
  );
  const reopened = await getCheckAttempt(db, attemptId);
  if (reopened === null) return;
  await reconcileCheckAttempt(
    env, db, now, budget, transport, credentials, credentialCache, reopened, log, summary, updateBudgetMs,
    true,
  );
}

/**
 * One due attempt, §7.11.2 steps 1–5 in order. Ownership is only ever granted
 * by `claimCheckRecovery`; everything after it is fenced on that lease, and
 * every exit leaves the row in a state its next run can continue from.
 *
 * A TERMINAL row takes the §7.9a late-correction path instead (see
 * `reopenTerminalCheck`); every other row is nonterminal by construction.
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
  /**
   * This call is the second half of a §7.9a late correction: the terminal row
   * was just reopened from its OWN confirmed publication, so the proof wait is
   * skipped. The proof exists, and a newer same-head publication's pending
   * proof must not defer the revision of this row.
   */
  correction = false,
): Promise<void> {
  const attemptId = row.identity.attemptId;
  const scope = row.identity.scope;

  if (row.terminalMs !== null) {
    await reopenTerminalCheck(env, db, now, budget, transport, credentials, credentialCache, row, log, summary, updateBudgetMs);
    return;
  }

  // §7.9a carried across passes: a reopened correction the request budget
  // deferred before dispatch is still OWED on the row. It is this pass's
  // correction only while the generation it targets still holds; a superseded
  // target is dropped under the claim below, never resurrected.
  let isCorrection =
    correction ||
    (row.correctionGeneration === row.identity.generation && row.correctionDesired !== null);

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
  // The wait belongs to a row that still OWES a conclusion — including a frozen
  // `failure` the arriving proof may still correct. The ONE exception is a skip
  // settlement's `neutral` (§7.9): that conclusion is final, nothing can
  // correct it and it owes no publication, so waiting for a proof that will
  // never exist would leave the run open for the whole window.
  if (!isCorrection && beforeDeadline && row.desired !== "neutral") {
    // The D1 half of the pair gate runs BEFORE the wait (spec §7.6, §7.11.2
    // step 2): a row whose App is disabled/deleted or whose installation
    // mapping vanished must take the durable suspension path, never loop with
    // its Check never converging. The gate leads the wait for EVERY row,
    // including the wait-terminal one below.
    const unusable = await pairUnusableReason(db, scope);
    if (unusable !== null) {
      await suspendUnusablePair(db, scope, unusable, undefined, now, log, summary);
      return;
    }
    // The wait is one shape: this attempt owes a conclusion to a publication it
    // has NO readable proof of. The terminal shape — nothing staged since
    // admission and no link of its own — is part of it, so it takes the SAME
    // claim-and-give-back path below (spec §7.11.2 step 2). `waitIsTerminal`
    // stays a predicate: it names the deadline cause (`unstaged`) and must never
    // skip the claim, which is what moves the row's due time off the head of
    // the bounded due batch.
    const waiting =
      waitIsTerminal(pending, proofPublicationId) ||
      pending.kind === "pending" ||
      pending.kind === "unknown" ||
      (await readProof(db, row.identity, proofPublicationId)).kind !== "read";
    if (waiting) {
      const waitingLease = await claimCheckRecovery(db, attemptId, HOLDER, now(), budget.settings.checkMaxAttempts);
      if (waitingLease === null) return;
      // Spec §7.11.2 step 2 pins the claim's given-back due time to the FIRST
      // rung: the publication may prove itself at any moment, so a widened rung
      // would only delay a proof that already exists. The deadline clamps it:
      // the wait never outlives the attempt's own hard stop.
      const nextAttemptMs = Math.min(now() + CHECK_BACKOFF_MS[0]!, row.executionDeadlineMs);
      // One call owns BOTH writes: the Check's next_attempt_ms and the owed
      // obligation's due instant move together or not at all.
      const rearmed = await deferCheckWithOwed(db, {
        checkAttemptId: attemptId,
        lease: waitingLease,
        nextAttemptMs,
        nowMs: now(),
        kind: "proof-wait",
      });
      if (!rearmed) return;
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
  const claimed = await claimCheckRecovery(db, attemptId, HOLDER, now(), budget.settings.checkMaxAttempts);
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

  // The owed correction, authoritative under the claim (the selection row may
  // predate another pass that settled it).
  const owedDesired =
    current.correctionGeneration === current.identity.generation ? current.correctionDesired : null;
  isCorrection = correction || owedDesired !== null;
  // A generation that moved means this row is not the subject of the owed
  // revision any more, and it never will be. ONE transition drops the debt,
  // unfreezes the intent it wrote, and parks the row: leaving it non-terminal
  // (or splitting these writes) would let a later pass — even after a crash
  // between two statements — send a conclusion this generation does not own.
  if (!correction && current.correctionGeneration !== null && owedDesired === null) {
    await parkCheckCorrection(
      db,
      attemptId,
      lease,
      `a correction owed for generation ${current.correctionGeneration} no longer targets this row (generation ${current.identity.generation}) — cannot conclude`,
      now(),
    );
    log.info(
      {
        event: "ops_check_terminal_correction_dropped",
        attempt_id: attemptId,
        detail: `generation ${current.identity.generation} no longer matches the owed correction`,
      },
      "owed correction dropped — its target generation moved, row parked, nothing sent",
    );
    return;
  }

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
  const [gateRead, reviewRead] = await Promise.all([
    readRecoveryGate(db, scope),
    readRecoveryReview(db, owned.identity, proof?.publicationId ?? null),
  ]);
  // An UNAVAILABLE read is not changed evidence. A correction pass that cannot
  // read the gate, the review or the proof bytes this time keeps the owed
  // outcome and retries next pass; deciding from a failed read would replace
  // (or self-deliver) a conclusion the evidence never stated.
  if (
    isCorrection &&
    (gateRead.kind !== "read" || reviewRead.kind !== "read" || proofRead.kind === "unreadable")
  ) {
    await releaseCheckClaim(db, attemptId, lease, now());
    log.info(
      { event: "ops_check_terminal_correction_held", attempt_id: attemptId },
      "correction held — evidence unreadable this pass; the owed conclusion is retried",
    );
    return;
  }
  const gate = gateRead.kind === "read" ? gateRead.value : null;
  const review = reviewRead.kind === "read" ? reviewRead.value : null;
  const conclusion = terminalConclusion(owned, proof, gate, review);
  // The evidence now decides a DIFFERENT conclusion than the contract's debt.
  // Two situations look the same here and must not be conflated:
  //   - the revision was never sent: the AUTHORIZATION to replace GitHub's
  //     original failure is still valid, only the conclusion it owes moved (an
  //     operator lowered/raised the score floor). Re-decide it in place and
  //     deliver it this pass — dropping it here is what stranded the Check.
  //   - the revision may already be on GitHub: it can only be read back, so the
  //     authorization is dropped and the pass stops; the existing dispatch
  //     intent keeps any later pass on readback.
  let authorizedReplacement = false;
  if (!correction && owedDesired !== null && conclusion.desired !== owedDesired) {
    if (current.correctionDispatchedMs !== null) {
      await dropCheckCorrection(db, attemptId, lease, now());
      await releaseCheckClaim(db, attemptId, lease, now());
      log.info(
        {
          event: "ops_check_terminal_correction_dropped",
          attempt_id: attemptId,
          detail: `evidence now concludes ${conclusion.desired}, owed ${owedDesired}, revision may be dispatched`,
        },
        "owed correction dropped — the sent revision is read back, never rewritten",
      );
      return;
    }
    if (!(await replaceCheckCorrection(db, attemptId, lease, conclusion, now()))) {
      await releaseCheckClaim(db, attemptId, lease, now());
      return;
    }
    authorizedReplacement = true;
    log.info(
      {
        event: "ops_check_terminal_correction_replaced",
        attempt_id: attemptId,
        detail: `owed ${owedDesired} → ${conclusion.desired}`,
      },
      "owed correction re-decided in place — the evidence changed before anything was sent",
    );
  }
  // The approved wording no longer names which evidence the deadline could not
  // read, so that attribution lands where the operator reads diagnosis: one log
  // line per unconfirmed conclusion, never a user-visible field.
  if (proof === null && !beforeDeadline) {
    log.info(
      {
        event: "check_recovery_unconfirmed",
        attempt_id: attemptId,
        cause: deadlineCause(pending, proofSourceId, proofRead),
      },
      "check recovery concluding unconfirmed — the evidence the deadline could not read",
    );
  }

  // Intent BEFORE any remote update: the persisted row is the only source the
  // send reads, so the frozen text cannot be swapped after this point. The wait
  // attribution is NOT pinned as this attempt's link (an abandoned attempt
  // keeps its own `publication_id` NULL); a row that already links its own
  // publication keeps that link, which is what a proof-free conclusion must
  // stay correctable from (§7.9a).
  const intentFrozen = await setCheckDesired(db, attemptId, lease, conclusion, proof?.publicationId ?? null, now());
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

  // The intent write was REFUSED, so the persisted conclusion is not the one
  // this evidence produced. A positive intent the evidence now denies must
  // never be sent on its own authority (only the documented known-stop refusal
  // keeps today's behaviour: a cap/budget stop is never rewritten, and its
  // frozen text is still the honest record). The attempt settles instead. A
  // replacement this pass just authorized pre-froze the new intent, so it can
  // never be undone by this guard.
  const supersededPositive =
    !authorizedReplacement &&
    !intentFrozen &&
    intent.desired !== "failure" &&
    conclusion.desired === "failure";

  const frozen: CheckConclusion = {
    desired: intent.desired,
    title: intent.desiredTitle,
    summary: intent.desiredSummary,
    ...(intent.terminalFailureStatus === null ? {} : { failureStatus: intent.terminalFailureStatus }),
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
          db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
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
          db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
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
        await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, ready.reason, log, summary);
        return;
      }
      // Attach immediately, before any further request: if a later step is
      // deferred, the id is already durable and the next run adopts it.
      const attached = await attachCheckRunId(db, attemptId, lease, ready.remote.id, now());
      if (!attached) {
        await settleFailedAttempt(
          db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
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
        db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
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
    // §7.11.2 step 5: a refusal proven zero-dispatched (no client, no
    // callable, a pre-send fence) ran no remote work, so it must not spend an
    // attempt. Charging it is what let five token-mint failures turn a live
    // run into a terminal `local-error` while GitHub still showed the Check
    // `in_progress` — an outcome nothing would ever revisit.
    if (fetched.requests === 0) {
      await releaseUndispatchedClaim(db, attemptId, lease, now, log, "fetch", fetched.reason);
      return;
    }
    await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, fetched.reason, log, summary);
    return;
  }
  if (fetched.kind === "absent") {
    // The recorded remote id is RETAINED (never cleared to create a lookalike);
    // a vanished run is reported honestly and retried under the same identity.
    await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, "the recorded check run is absent remotely", log, summary);
    return;
  }
  if (fetched.remote.status === "completed") {
    if (fetched.remote.conclusion !== frozen.desired) {
      // A different CONCLUSION is not a wording gap: overwriting it here would
      // replace an outcome this lane never recorded. Reported honestly and
      // left to the attempt ladder, exactly as before — EXCEPT on the §7.9a
      // correction path, where that published conclusion IS this row's own
      // unconfirmed record (`reopenTerminalCorrection` matched exactly that
      // row and cleared its mark once, in the same statement), and this row's
      // own publication now contradicts it. There the new conclusion must
      // reach THAT run — refusing GitHub's existing failure would leave the
      // correction local, which is the same defect one layer later.
      if (!isCorrection) {
        await settleFailedAttempt(
          db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
          `remote run concluded ${fetched.remote.conclusion ?? "null"}, persisted intent is ${frozen.desired}`,
          log, summary,
        );
        return;
      }
      log.info(
        { event: "ops_check_terminal_correction_replaces", attempt_id: attemptId, publication_id: proof?.publicationId ?? null },
        `terminal Check run carries the unconfirmed ${fetched.remote.conclusion ?? "null"} this row published — replacing it with the proof's ${frozen.desired}`,
      );
    } else if (fetched.remote.summary === frozen.summary) {
      // The conclusion AND the approved text already match this attempt's
      // frozen intent: an earlier send LANDED and only its reply was lost.
      // Reading it back is reconciliation — re-sending the same text would
      // spend a request to prove what this read already proved.
      const recorded = await recordTerminal(db, attemptId, lease, fetched.remote, frozen, now, summary, proof === null);
      if (recorded === "mismatch") {
        await settleFailedAttempt(
          db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
          "the reread run is not the persisted terminal intent",
          log, summary,
        );
      }
      return;
    }
    // A conclusion-only match is NOT delivery: the run carries the right
    // conclusion but no — or different — approved text, so this handoff's
    // wording never reached the user.
    //
    // An ALREADY-CONCLUDED run is nevertheless never rewritten (plan global
    // constraint: "a Check that already has a conclusion is left alone"). The
    // new persisted-launch selection can reach rows whose run another lane
    // concluded, and re-updating a finished run is a write this lane may not
    // make. The honest local end is the attempt ladder with the fact recorded;
    // the §7.9a CORRECTION path is the one exception — there the concluded run
    // carries this row's OWN unconfirmed record and the proof's conclusion must
    // reach it.
    if (!isCorrection) {
      // A terminal update this lane already dispatched is READ BACK, never re-sent
      // and never charged while its reply may still arrive: the concluded run keeps
      // its own text, and the row waits without spending an attempt.
      if ((await readTerminalDispatch(db, attemptId)) !== null && beforeDeadline) {
        await releaseCheckClaim(db, attemptId, lease, now());
        log.info(
          { event: "ops_check_reconcile_dispatch_pending", detail: `attempt=${attemptId}` },
          "a terminal update was already dispatched — concluded-run readback only, no second send",
        );
        return;
      }
      await settleFailedAttempt(
        db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
        `remote run is already concluded ${fetched.remote.conclusion ?? "null"} with different text — an already-concluded Check is never rewritten`,
        log, summary,
      );
      return;
    }
    // The correction's own text: fall through and send the frozen intent to THAT run.
  }

  // §7.9a: an already-DISPATCHED terminal update is discovery, never permission
  // to send again. The fetch above is the readback; a run that has not reached
  // the intended state yet does not prove the earlier request failed to land,
  // and sending the same update twice is exactly the double it would cause.
  if ((await readTerminalDispatch(db, attemptId)) !== null) {
    if (beforeDeadline) {
      // Its outcome may still arrive: wait without spending an attempt.
      await releaseCheckClaim(db, attemptId, lease, now());
      log.info(
        { event: "ops_check_reconcile_dispatch_pending", detail: `attempt=${attemptId}` },
        "a terminal update was already dispatched — readback only, no second send",
      );
      return;
    }
    // Past the deadline nothing more can prove it: charge the attempt so the
    // ladder ends honestly (local-error with the remote id retained) instead of
    // re-reading forever.
    await settleFailedAttempt(
      db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
      "a terminal update was dispatched and could not be confirmed by readback — never re-sent",
      log, summary,
    );
    return;
  }

  // The persisted positive intent could not be replaced by the conclusion this
  // evidence produced: sending it would publish a pass nothing supports. The
  // readback above already resolved the "it landed earlier" shape; past it,
  // the honest end is the attempt ladder, never a send.
  if (supersededPositive) {
    await settleFailedAttempt(
      db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
      `the persisted ${intent.desired} intent could not be replaced by ${conclusion.desired} — not sent`,
      log, summary,
    );
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
    // Same §7.11.2 step 5 rule as the fetch path: an undispatched update owes
    // no attempt — the row stays due and the next pass retries the SAME
    // terminal intent instead of giving up on work that never ran.
    if (completed.requests === 0) {
      await releaseUndispatchedClaim(db, attemptId, lease, now, log, "complete", completed.reason);
      return;
    }
    // §7.11.2 step 4: preserve desired and actual observed, stay
    // `remote-unconfirmed`, back off, release the lease.
    await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, completed.reason, log, summary);
    return;
  }
  const recorded = await recordTerminal(db, attemptId, lease, completed.remote, frozen, now, summary, proof === null);
  if (recorded === "mismatch") {
    await settleFailedAttempt(
      db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
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
 *
 * `conclusionUnproven` says this send carried a conclusion decided WITHOUT a
 * publication proof: the record is then published-but-unconfirmed and stays
 * correctable once by its own publication's confirmation (§7.9a) — the same
 * mark the consumer's terminalize records.
 */
async function recordTerminal(
  db: D1Like,
  attemptId: string,
  lease: Lease,
  remote: CheckRemote,
  frozen: CheckConclusion,
  now: () => number,
  summary: CheckReconcileSummary,
  conclusionUnproven: boolean,
): Promise<"recorded" | "mismatch" | "lost"> {
  // Delivery needs the frozen conclusion AND the frozen text (spec §7.9): a
  // reply whose output is absent or different proves nothing about what the
  // user reads, so it is a miss and the same run is sent again next pass.
  const agrees =
    remote.status === "completed" &&
    remote.conclusion === frozen.desired &&
    remote.summary === frozen.summary;
  if (!agrees) return "mismatch";
  const written = await recordCheckObservation(db, attemptId, lease, remote, now(), { conclusionUnproven });
  if (!written) return "lost";
  // The Check is concluded: clear the attempt row's owed flag so this lane
  // stops selecting it. Bookkeeping only — the conclusion is already durable,
  // so a fault here is a warn, never a failed pass.
  await clearCheckOwed(db, attemptId).catch(() => {});
  summary.completed += 1;
  return "recorded";
}

/**
 * Hand a claim back after a refusal PROVEN zero-dispatched (§7.11.2 step 5):
 * nothing reached GitHub, so no attempt is spent and the row is selector-due
 * again at the SAME instant rather than after the 120-second lapse.
 *
 * The fence is identity, not liveness: a client-resolution refusal is often
 * the live-time fence itself (the mint outlived `lease.untilMs`), so a
 * liveness-fenced release would write nothing on exactly the path that needs
 * it. A lost race leaves the row to its new owner and mutates nothing.
 */
async function releaseUndispatchedClaim(
  db: D1Like,
  attemptId: string,
  lease: Lease,
  now: () => number,
  log: CheckReconcileLog,
  op: string,
  reason: string,
): Promise<void> {
  // The reason rides the log, never the row: the refusal is un-proven by
  // definition, so nothing is written except the claim release. Without it a
  // lane that keeps refusing zero-dispatched is indistinguishable from one that
  // never ran — the exact blind spot that hid a permanent 404 mint.
  const detail = `attempt=${attemptId} op=${op} reason=${reason}`;
  const released = await releaseExpiredCheckClaim(db, attemptId, lease, now());
  if (!released) {
    log.warn({ event: "ops_check_reconcile_zero_dispatch_release_missed", detail }, "zero-dispatch refusal hit a claim that had already moved");
    return;
  }
  log.info({ event: "ops_check_reconcile_zero_dispatch_deferral", detail }, "no-request refusal — row released, no attempt spent");
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
  maxAttempts: number,
  attemptsBefore: number,
  row: CheckAttempt,
  lease: Lease,
  reason: string,
  log: CheckReconcileLog,
  summary: CheckReconcileSummary,
): Promise<void> {
  const attemptId = row.identity.attemptId;
  const attemptsAfter = attemptsBefore + 1; // this recovery claimed exactly one
  if (attemptsAfter >= maxAttempts) {
    const line = giveUpLine(row.identity.scope, attemptId, attemptsAfter, reason);
    const marked = await markCheckLocalError(db, attemptId, lease, line, now());
    if (marked) {
      // Settled as `local-error`: the attempt no longer owes a settlement.
      await clearCheckOwed(db, attemptId).catch(() => {});
      summary.gaveUp += 1;
      log.warn({ event: "ops_check_reconcile_gave_up", detail: line }, "check recovery gave up at the attempt cap");
    } else {
      // The fence moved before the give-up could be written: the row belongs
      // to whoever holds it now, and nothing was marked.
      summary.errors += 1;
    }
    return;
  }
  const nextAttemptMs = now() + backoffFor(attemptsAfter);
  // One call owns BOTH writes: the Check's backoff and the obligation's due
  // instant move together, so a repeatedly failing row backs off instead of
  // cycling.
  const deferred = await deferCheckWithOwed(db, {
    checkAttemptId: attemptId,
    lease,
    nextAttemptMs,
    nowMs: now(),
    kind: "recovery",
    state: "remote-unconfirmed",
    reason,
  });
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
 * not a proof so the deadline path can LOG which evidence was missing:
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
 * A guarded evidence read. `null` is a REAL answer (no target row, no review
 * recorded); a failed read is not — treating the two alike is what lets a D1
 * hiccup masquerade as changed evidence and drop an owed correction.
 */
type EvidenceRead<T> = { kind: "read"; value: T } | { kind: "unavailable" };

/**
 * The target's gate for a Check row — the same gate the consumer lane decides
 * against, so a review proof concludes from it. `read` with a `null` value
 * means the gate itself is unreadable or absent (no target, corrupt stored
 * verdicts), which `decideConclusion` already treats as a failure; an
 * `unavailable` answer means the READ failed and says nothing about the gate.
 * A read failure is never a reason to abandon the row: the conclusion still
 * gets persisted.
 *
 * A target IS a repository (migration 0067), and a Check's stored scope names
 * the bot with the delivery's owner/name — the exact pair the target caches, so
 * the lookup is one index seek on `idx_review_targets_bot_owner_name` and no
 * second resolution (the delivery already refreshed those caches).
 */
async function readRecoveryGate(db: D1Like, scope: Scope): Promise<EvidenceRead<ReviewGate | null>> {
  try {
    const row = await db
      .prepare(
        `SELECT * FROM review_targets
          WHERE bot_id = ? AND repo_owner = ? COLLATE NOCASE AND repo_name = ? COLLATE NOCASE
            AND deleted_at IS NULL
          ORDER BY created_at, id LIMIT 1`,
      )
      .bind(scope.appId, scope.owner, scope.repo)
      .first<ReviewTargetRow>();
    if (row === null) return { kind: "read", value: null };
    // The EFFECTIVE gate (migration 0067): an inheriting target is judged by
    // the workspace floor it actually runs on, not by the inert placeholder
    // columns its row still carries.
    return { kind: "read", value: checkGateOf(await readEffectiveTargetSettings(db, row)) };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * The review THIS proof publication carried — the same preference the proof
 * read makes, so the Check is judged by the envelope the attempt published
 * rather than by the scope/SHA `reviews` projection, which can lag the apply
 * or belong to an earlier attempt for the same head SHA. A failed read is
 * `unavailable`, never a `null` that `decideConclusion` would read as "no
 * review": that would lower an owed correction's conclusion for a reason D1
 * never stated.
 */
async function readRecoveryReview(
  db: D1Like,
  identity: CheckIdentity,
  publicationId: string | null,
): Promise<EvidenceRead<PublishedReview | null>> {
  try {
    return {
      kind: "read",
      value: await readPublishedReview(db, {
        scope: identity.scope,
        headSha: identity.headSha,
        ...(publicationId === null ? {} : { publicationId }),
      }),
    };
  } catch {
    return { kind: "unavailable" };
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
 * no publication of its own. Nothing THIS pass can read answers such an
 * attempt, so it is not concludable — only the execution deadline concludes it,
 * and `deadlineCause` reports exactly this shape as `unstaged`.
 *
 * A predicate, never a gate: the shape is not proof the wait can never
 * progress, because a journal row that lands later lifts it. The row therefore
 * takes the same claim-and-give-back wait as any unproven row (spec §7.11.2
 * step 2) and is re-probed on the first rung — the claim is also what keeps a
 * dead row off the head of the bounded due batch.
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
 * this attempt's own proof read. Three causes — an attribution for the LOG, not
 * a taxonomy the user sees: nothing was staged for this attempt (`none` plus no
 * link), a staged row whose proof never landed, or a read that failed (the
 * journal's or the proof's). A readable proof never reaches here: it decides.
 */
function deadlineCause(
  pending: PendingPublication,
  publicationId: string | null,
  read: ProofRead,
): "unstaged" | "unproven" | "unreadable" {
  if (pending.kind === "unknown" || read.kind === "unreadable") return "unreadable";
  if (waitIsTerminal(pending, publicationId)) return "unstaged";
  return "unproven";
}

/**
 * The terminal conclusion for a due attempt (spec §7.9 matrix): a persisted
 * publication proof decides the conclusion against the App gate — a normal
 * publication only succeeds when the applied review meets it — regardless of
 * how the attempt expired. The no-proof branch runs only once the wait above
 * has ended: the execution deadline passed, which makes the unconfirmed
 * `failure` the conclusion. An intent the consumer already persisted is
 * preserved verbatim — including its approved failure category — unless a
 * proof-derived correction applies. `gate` is the App's stored gate; `null`
 * means it could not be read, so a proof-derived conclusion fails closed
 * instead of assuming a default.
 */
function terminalConclusion(
  owned: CheckOwnership,
  proof: PublicationProof | null,
  gate: ReviewGate | null,
  review: PublishedReview | null,
): CheckConclusion {
  if (proof !== null) return decideConclusion({ proof, outcome: "expired", gate, review });
  if (owned.desired === "in_progress") {
    return decideConclusion({ proof: null, outcome: "expired", gate, review });
  }
  return {
    desired: owned.desired,
    title: owned.desiredTitle ?? CHECK_NAME,
    summary: owned.desiredSummary ?? CHECK_SUMMARIES.unconfirmed,
    ...(owned.terminalFailureStatus === null ? {} : { failureStatus: owned.terminalFailureStatus }),
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
