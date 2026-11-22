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


export type CheckReconcileSummary = {
  examined: number;
  completed: number;
  unconfirmed: number;
  suspended: number;
  gaveUp: number;
  errors: number;
  deferred: number;
};

const CREDENTIAL_REQUESTS = RECONCILE_REQUEST_ESTIMATES.credentials;

const HOLDER = "check-reconcile";


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
      paused: boolean;
    }
  | {
      kind: "unavailable";
      reason: CheckCredentialReason;
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
  updateBudgetMs?: number;
}) => Promise<CheckCredentialResolution>;

export type CheckReconcileDeps = {
  now?: () => number;
  credentials?: CheckCredentialFactory;
  log?: CheckReconcileLog;
  fetchImpl?: typeof fetch;
};


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
  const credentialFingerprint = await sha256Hex(row.private_key_enc);
  try {
    const pem = await createSecretbox(env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
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
    return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
  }
};

const UNAVAILABLE_REASON_TEXT: Record<CheckCredentialReason, string> = {
  missing: "mapping missing",
  deleted: "deleted",
  disabled: "disabled",
  "decrypt-failed": "credential decrypt failed",
  "identity-mismatch": "live App identity does not match the routed github_app_id",
};


type RunBudget = {
  settings: ReconcileValues;
  spent: number;
  deadline: number;
  rowSpent: number;
  rowActive: boolean;
  refused: boolean;
};

function canSpend(budget: RunBudget, nowMs: number, cost: number, rowScoped: boolean): boolean {
  if (budget.spent + cost > budget.settings.checkMaxRequests) return false;
  if (nowMs >= budget.deadline) return false;
  if (rowScoped && budget.rowActive && budget.rowSpent + cost > budget.settings.checkRowMaxRequests) return false;
  return true;
}

function reserve(budget: RunBudget, cost: number): void {
  budget.spent += cost;
  if (budget.rowActive) budget.rowSpent += cost;
}

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

function backoffFor(attemptsAfter: number): number {
  const index = Math.min(Math.max(attemptsAfter - 1, 0), CHECK_BACKOFF_MS.length - 1);
  return CHECK_BACKOFF_MS[index]!;
}

function giveUpLine(scope: Scope, workId: string, attempts: number, reason: string): string {
  return `gave up after ${attempts} attempts (app=${scope.appId}, installation=${scope.installationId}, owner=${scope.owner}, repo=${scope.repo}, pr=${scope.prNumber}, work=${workId}): ${reason}`;
}


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
    const credentialCache = new Map<string, Promise<CheckCredentialResolution>>();

    await reenableHealthyAppChecks(env, db, now, budget, credentials, transport, log, checkBudgets.updateMs);

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
    summary.errors += 1;
    log.warn(
      { event: "ops_check_reconcile_failed", detail: error instanceof Error ? error.message : String(error) },
      "check reconcile failed — retained rows stay due",
    );
    return summary;
  }
}

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

  const last = suspended[suspended.length - 1]!;
  await db
    .prepare(
      `INSERT INTO check_reenable_cursor (id, installation_id, bot_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, bot_id = excluded.bot_id`,
    )
    .bind(last.installation_id, last.bot_id)
    .run();

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
      log.warn(
        { event: "ops_check_reconcile_reenable_probe_deferred", detail: `pair=(${pair.appId}, ${pair.installationId})` },
        "re-enable probe deferred — budget refused before dispatch, prior state retained",
      );
    }
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
  const kinds = rows.results.map((row) => checkSuspensionKindOf(row.last_error));
  if (rows.results.some((row, index) => kinds[index] === "paused" && row.review_enabled === 0)) {
    return { kind: "unchanged" };
  }
  if (kinds.length > 0 && kinds.every((kind) => kind === "disabled" || kind === "paused")) {
    return { kind: "resume" };
  }
  if (!canSpend(budget, now(), CREDENTIAL_REQUESTS, false)) return { kind: "refused" };
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
    if (budget.refused) return { kind: "refused" };
    if (settled.kind === "ok") return { kind: "resume" };
    return {
      kind: "resuspend",
      reason: settled.reason,
      ...(settled.credentialFingerprint === undefined ? {} : { credentialFingerprint: settled.credentialFingerprint }),
    };
  } catch (error) {
    if (budget.refused || isRequestNotDispatched(error)) return { kind: "refused" };
    return { kind: "resuspend", reason: "decrypt-failed" };
  }
}

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
  const publicationId = row.publicationId;
  if (publicationId === null) return;
  const proofRead = await readProof(db, row.identity, publicationId);
  if (proofRead.kind !== "read") return;
  if ((await pairUnusableReason(db, scope)) !== null) return;
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
  correction = false,
): Promise<void> {
  const attemptId = row.identity.attemptId;
  const scope = row.identity.scope;

  if (row.terminalMs !== null) {
    await reopenTerminalCheck(env, db, now, budget, transport, credentials, credentialCache, row, log, summary, updateBudgetMs);
    return;
  }

  let isCorrection =
    correction ||
    (row.correctionGeneration === row.identity.generation && row.correctionDesired !== null);

  let proofPublicationId: string | null = row.publicationId;
  const beforeDeadline = now() < row.executionDeadlineMs;
  const pending = await probePendingPublication(db, row);
  if (pending.kind === "proven") proofPublicationId = pending.publicationId;
  else if (pending.kind === "pending" && proofPublicationId === null) {
    proofPublicationId = pending.publicationId;
  }
  if (!isCorrection && beforeDeadline && row.desired !== "neutral") {
    const unusable = await pairUnusableReason(db, scope);
    if (unusable !== null) {
      await suspendUnusablePair(db, scope, unusable, undefined, now, log, summary);
      return;
    }
    const waiting =
      waitIsTerminal(pending, proofPublicationId) ||
      pending.kind === "pending" ||
      pending.kind === "unknown" ||
      (await readProof(db, row.identity, proofPublicationId)).kind !== "read";
    if (waiting) {
      const waitingLease = await claimCheckRecovery(db, attemptId, HOLDER, now(), budget.settings.checkMaxAttempts);
      if (waitingLease === null) return;
      const nextAttemptMs = Math.min(now() + CHECK_BACKOFF_MS[0]!, row.executionDeadlineMs);
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
          probe_state: pending.kind,
          ...(pending.kind === "pending" ? { phase: pending.phase } : {}),
          next_attempt_ms: nextAttemptMs,
        },
        "check recovery waiting for the publication proof — claim given back, no attempt spent",
      );
      return;
    }
  }

  const resolved = await credentialsForPair(db, env, scope, now, budget, transport, credentials, credentialCache, log, summary, updateBudgetMs);
  if (resolved.kind !== "ok") return;

  const claimed = await claimCheckRecovery(db, attemptId, HOLDER, now(), budget.settings.checkMaxAttempts);
  if (claimed === null) return;
  const lease: Lease = claimed;

  const owned = await getCheckOwnership(db, attemptId, lease, now());
  if (owned === null) return;

  const current = await getCheckAttempt(db, attemptId);
  if (current === null) return;
  const attemptsBefore = current.attempts;

  const owedDesired =
    current.correctionGeneration === current.identity.generation ? current.correctionDesired : null;
  isCorrection = correction || owedDesired !== null;
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

  const proofSourceId = proofPublicationId ?? owned.publicationId;
  const proofRead = await readProof(db, owned.identity, proofSourceId);
  const proof = proofRead.kind === "read" ? proofRead.proof : null;
  const [gateRead, reviewRead] = await Promise.all([
    readRecoveryGate(db, scope),
    readRecoveryReview(db, owned.identity, proof?.publicationId ?? null),
  ]);
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

  const intentFrozen = await setCheckDesired(db, attemptId, lease, conclusion, proof?.publicationId ?? null, now());
  const intent = await getCheckOwnership(db, attemptId, lease, now());
  if (intent === null) return;
  if (intent.desired === "in_progress") {
    await releaseCheckClaim(db, attemptId, lease, now());
    return;
  }
  if (intent.desiredTitle === null || intent.desiredSummary === null) return;

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

  let checkRunId = intent.checkRunId;
  if (checkRunId === null) {
    const adopted = await resolved.adapter.adoptCheckRun({ identity: intent.identity });
    if (budget.refused) {
      await releaseCheckClaim(db, attemptId, lease, now());
      return;
    }
    if (adopted.kind === "found") {
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
      if (intent.createState !== "not-sent") {
        await settleFailedAttempt(
          db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
          "a create may already have been sent and no run is observable — read-only adoption only",
          log, summary,
        );
        return;
      }
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
        if (ready.requests === 0) {
          const released = await releaseExpiredCheckClaim(db, attemptId, lease, now());
          if (!released) {
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
        await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, ready.reason, log, summary);
        return;
      }
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
      await settleFailedAttempt(
        db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
        `adoption is ${adopted.kind} — absence unproven, no create`,
        log, summary,
      );
      return;
    }
  }

  const fetched = await resolved.adapter.fetchCheckRun({ identity: intent.identity, checkRunId });
  if (budget.refused) {
    await releaseCheckClaim(db, attemptId, lease, now());
    return;
  }
  if (fetched.kind === "unavailable") {
    if (fetched.requests === 0) {
      await releaseUndispatchedClaim(db, attemptId, lease, now, log, "fetch", fetched.reason);
      return;
    }
    await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, fetched.reason, log, summary);
    return;
  }
  if (fetched.kind === "absent") {
    await settleFailedAttempt(db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease, "the recorded check run is absent remotely", log, summary);
    return;
  }
  if (fetched.remote.status === "completed") {
    if (fetched.remote.conclusion !== frozen.desired) {
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
  }

  if ((await readTerminalDispatch(db, attemptId)) !== null) {
    if (beforeDeadline) {
      await releaseCheckClaim(db, attemptId, lease, now());
      log.info(
        { event: "ops_check_reconcile_dispatch_pending", detail: `attempt=${attemptId}` },
        "a terminal update was already dispatched — readback only, no second send",
      );
      return;
    }
    await settleFailedAttempt(
      db, now, budget.settings.checkMaxAttempts, attemptsBefore, row, lease,
      "a terminal update was dispatched and could not be confirmed by readback — never re-sent",
      log, summary,
    );
    return;
  }

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
    if (completed.requests === 0) {
      await releaseUndispatchedClaim(db, attemptId, lease, now, log, "complete", completed.reason);
      return;
    }
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
  const agrees =
    remote.status === "completed" &&
    remote.conclusion === frozen.desired &&
    remote.summary === frozen.summary;
  if (!agrees) return "mismatch";
  const written = await recordCheckObservation(db, attemptId, lease, remote, now(), { conclusionUnproven });
  if (!written) return "lost";
  await clearCheckOwed(db, attemptId).catch(() => {});
  summary.completed += 1;
  return "recorded";
}

async function releaseUndispatchedClaim(
  db: D1Like,
  attemptId: string,
  lease: Lease,
  now: () => number,
  log: CheckReconcileLog,
  op: string,
  reason: string,
): Promise<void> {
  const detail = `attempt=${attemptId} op=${op} reason=${reason}`;
  const released = await releaseExpiredCheckClaim(db, attemptId, lease, now());
  if (!released) {
    log.warn({ event: "ops_check_reconcile_zero_dispatch_release_missed", detail }, "zero-dispatch refusal hit a claim that had already moved");
    return;
  }
  log.info({ event: "ops_check_reconcile_zero_dispatch_deferral", detail }, "no-request refusal — row released, no attempt spent");
}

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
  const attemptsAfter = attemptsBefore + 1;
  if (attemptsAfter >= maxAttempts) {
    const line = giveUpLine(row.identity.scope, attemptId, attemptsAfter, reason);
    const marked = await markCheckLocalError(db, attemptId, lease, line, now());
    if (marked) {
      await clearCheckOwed(db, attemptId).catch(() => {});
      summary.gaveUp += 1;
      log.warn({ event: "ops_check_reconcile_gave_up", detail: line }, "check recovery gave up at the attempt cap");
    } else {
      summary.errors += 1;
    }
    return;
  }
  const nextAttemptMs = now() + backoffFor(attemptsAfter);
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
    cache.delete(key);
    return { kind: "unavailable", reason: "decrypt-failed" };
  }
  if (settled.kind === "unavailable") {
    await suspendUnusablePair(db, scope, settled.reason, settled.credentialFingerprint, now, log, summary);
  }
  return settled;
}

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

async function pairUnusableReason(db: D1Like, scope: Scope): Promise<CheckCredentialReason | null> {
  const routing = await checkRoutingRow(db, scope.appId, scope.installationId);
  if (routing === null) return "missing";
  if (routing.deleted_at !== null) return "deleted";
  if (routing.status !== "active") return "disabled";
  return null;
}

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
    return proof !== null && proof.publicationId === publicationId
      ? { kind: "read", proof }
      : { kind: "unproven" };
  } catch {
    return { kind: "unreadable" };
  }
}

type EvidenceRead<T> = { kind: "read"; value: T } | { kind: "unavailable" };

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
    return { kind: "read", value: checkGateOf(await readEffectiveTargetSettings(db, row)) };
  } catch {
    return { kind: "unavailable" };
  }
}

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

type PendingPublication =
  | { kind: "pending"; phase: string; publicationId: string }
  | { kind: "proven"; publicationId: string }
  | { kind: "none" }
  | { kind: "unknown" };

function waitIsTerminal(pending: PendingPublication, publicationId: string | null): boolean {
  return pending.kind === "none" && publicationId === null;
}

async function probePendingPublication(db: D1Like, attempt: CheckAttempt): Promise<PendingPublication> {
  try {
    const journal = await findPublicationJournal(db, {
      scope: attempt.identity.scope,
      headSha: attempt.identity.headSha,
      phases: PUBLICATION_PROOF_WAIT_PHASES,
      order: "newest",
      writtenAtOrAfterMs: attempt.createdAtMs,
    });
    if (journal === null) return { kind: "none" };
    return journal.hasProof
      ? { kind: "proven", publicationId: journal.id }
      : { kind: "pending", phase: journal.phase, publicationId: journal.id };
  } catch {
    return { kind: "unknown" };
  }
}

function deadlineCause(
  pending: PendingPublication,
  publicationId: string | null,
  read: ProofRead,
): "unstaged" | "unproven" | "unreadable" {
  if (pending.kind === "unknown" || read.kind === "unreadable") return "unreadable";
  if (waitIsTerminal(pending, publicationId)) return "unstaged";
  return "unproven";
}

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
