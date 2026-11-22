import { getReconcileSettings } from "../dashboard/runtime-config-store";
import { RECONCILE_REQUEST_ESTIMATES, type ReconcileValues } from "../contracts/reconcile-settings";
import type { ScheduledEnv } from "./env";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { D1Like, D1StatementLike } from "../store/types";
import { RecoveryBudgetRefused, isBudgetRefusal } from "../contracts/recovery-budget";
import {
  applyPublishedLifecycle,
  captureLineComments,
  claimDegradedTarget,
  claimPublication,
  deferPublicationRecovery,
  deferResolutionRecovery,
  getPublicationCreatedMs,
  getResolutionRecoveryRow,
  listLineBatchRecovery,
  listPublicationRecovery,
  listResolutionRecovery,
  listSuspendedLifecycleApps,
  LIFECYCLE_BACKOFF_MS,
  markPublicationFailed,
  markPublicationLocalError,
  markPublicationUnknown,
  markResolutionLocalError,
  PREPARED_SEND_MIN_AGE_MS,
  readLineBatchState,
  recordLineDiscoveryFailure,
  recordNeedsRecheck,
  resetLineDiscoveryFailures,
  recordPublicationProof,
  recordLineDispatchIntent,
  reenableLifecycleForApps,
  releaseDegradedTarget,
  releaseLineDispatch,
  releaseUnspentPublicationClaim,
  supersedePublication,
  suspendPublicationRecovery,
  suspendResolutionRecovery,
  type Lease,
  type PublicationRow,
} from "../store/finding-lifecycle";
import { createSecretbox } from "../dashboard/secretbox";
import { createReviewCommenter, PreparedSendRejected, PublicationAuthorityUnavailable, type CommenterFetch, type LineDiscoveryFailure, type PostPreparedLineCommentsInput, type PostedLineComments, type ReviewCommenter, type UpsertPlan } from "../pipeline/comment";
import { sha256Hex } from "../pipeline/review-threads";
import { settlementStatementIfDischarged } from "../store/review-route-store";


export type LifecycleReconcileSummary = {
  examined: number;
  applied: number;
  resolved: number;
  unknown: number;
  suspended: number;
  errors: number;
};

const PLAN_REQUESTS = RECONCILE_REQUEST_ESTIMATES.plan;
const SEND_REQUESTS = RECONCILE_REQUEST_ESTIMATES.send;
const DISCOVERY_REQUESTS = RECONCILE_REQUEST_ESTIMATES.discovery;
const IDENTITY_REQUESTS = RECONCILE_REQUEST_ESTIMATES.identity;

const HOLDER = "lifecycle-reconcile";


/**
 * The GitHub surface M8 needs. `resolveFindingThread` is the §7.5 adapter
 * (wired by `createReviewCommenter(env, { db })`) — the reconciler consumes
 * it; it never re-implements ownership proofs or fences.
 */
export type ReconcileReviewer = Pick<
  ReviewCommenter,
  "planReviewUpsert" | "postPreparedReview" | "postPreparedDegraded" | "postLineComments" | "recoverLineComments" | "listDiscussion"
> & {
  resolveFindingThread: NonNullable<ReviewCommenter["resolveFindingThread"]>;
};

/** Why a pair's credentials cannot be used (spec §7.6). */
export type ReviewerUnavailableReason = "missing" | "deleted" | "disabled" | "decrypt-failed" | "identity-mismatch";

export type ReviewerResolution =
  | {
      kind: "ok";
      reviewer: ReconcileReviewer;
      paused: boolean;
      botLogin: string;
    }
  | {
      kind: "unavailable";
      reason: ReviewerUnavailableReason;
      credentialFingerprint?: string;
    };

/**
 * The run's transport bound, handed to the reviewer factory so every request
 * the lane issues is aborted at `min(5s, remaining run time)`. `boundMs()`
 * is read at each request, so a request issued late in the run gets only the
 * remaining time; the run deadline is the ceiling either way.
 */
export type ReconcileTransport = {
  boundMs: () => number;
  fetchImpl: CommenterFetch;
};

/**
 * Exact `(bot_id, installation_id)` credential routing (spec §7.6): the
 * routing query binds BOTH durable ids through `bot_installations` into the
 * matching `review_bots` row. Missing mapping / soft-deleted / disabled →
 * `unavailable` (the reconciler suspends the pair durably); a decrypted PEM
 * builds THIS bot's commenter — the only credential source, never another
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
  now?: () => number;
}) => Promise<ReviewerResolution>;

type RoutingRow = {
  id: string;
  github_app_id: number;
  status: string;
  deleted_at: string | null;
  review_enabled: number;
  private_key_enc: string;
};

async function routingRow(db: D1Like, appId: string, installationId: number): Promise<RoutingRow | null> {
  return db
    // shortcut: tenant-bypass — reconciler credential routing by exact (bot_id,
    // installation_id); returns no tenant-facing field. Upgrade: tenant-filter it
    // once reconciliation itself becomes workspace-scoped.
    .prepare(
      `SELECT ga.id AS id, ga.github_app_id AS github_app_id, ga.status AS status,
              ga.deleted_at AS deleted_at, ga.review_enabled AS review_enabled,
              ga.private_key_enc AS private_key_enc
       FROM bot_installations ai
       JOIN review_bots ga ON ga.id = ai.bot_id
       WHERE ai.bot_id = ? AND ai.installation_id = ?`,
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
export const productionReviewerFactory: ReviewerFactory = async ({ db, env, appId, installationId, transport, now }) => {
  const row = await routingRow(db, appId, installationId);
  if (row === null) return { kind: "unavailable", reason: "missing" };
  if (row.deleted_at !== null) return { kind: "unavailable", reason: "deleted" };
  if (row.status !== "active") return { kind: "unavailable", reason: "disabled" };
  const credentialFingerprint = await sha256Hex(row.private_key_enc);
  try {
    const pem = await createSecretbox(env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    const commenter = createReviewCommenter({ APP_ID: String(row.github_app_id), PRIVATE_KEY: pem }, {
      db,
      ...(now === undefined ? {} : { nowMs: now }),
      ...(transport === undefined ? {} : { fetchImpl: transport.fetchImpl }),
    });
    const { resolveFindingThread, getAppIdentity } = commenter;
    if (resolveFindingThread === undefined || getAppIdentity === undefined) {
      return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
    }
    const identity = await getAppIdentity();
    if (identity === null || identity.githubAppId !== row.github_app_id) {
      return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint };
    }
    return {
      kind: "ok",
      paused: row.review_enabled === 0,
      botLogin: `${identity.slug}[bot]`,
      reviewer: {
        planReviewUpsert: (input) => commenter.planReviewUpsert(input),
        postPreparedReview: (input) => commenter.postPreparedReview(input),
        postPreparedDegraded: (input) => commenter.postPreparedDegraded(input),
        postLineComments: (input) => commenter.postLineComments(input),
        recoverLineComments: (input) => commenter.recoverLineComments(input),
        listDiscussion: (input) => commenter.listDiscussion(input),
        resolveFindingThread,
      },
    };
  } catch {
    return { kind: "unavailable", reason: "decrypt-failed", credentialFingerprint };
  }
};


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
  now?: () => number;
  reviewer?: ReviewerFactory;
  log?: ReconcileLog;
};


type RunBudget = {
  settings: ReconcileValues;
  spent: number;
  deadline: number;
  laneCap: number;
};

function canSpend(budget: RunBudget, nowMs: number, cost: number, laneScoped: boolean): boolean {
  if (budget.spent + cost > budget.settings.lifecycleMaxRequests) return false;
  if (laneScoped && budget.spent + cost > budget.settings.lifecyclePublicationLaneMaxRequests) return false;
  if (budget.spent + cost > budget.laneCap) return false;
  if (nowMs >= budget.deadline) return false;
  return true;
}

function reserve(budget: RunBudget, cost: number): void {
  budget.spent += cost;
}

function buildTransport(budget: RunBudget, now: () => number): ReconcileTransport {
  const boundMs = (): number => Math.max(1, Math.min(budget.settings.lifecyclePerRequestMs, budget.deadline - now()));
  return {
    boundMs,
    fetchImpl: (input, init) => {
      if (!canSpend(budget, now(), 1, false)) {
        return Promise.reject(
          new RecoveryBudgetRefused(
            `recovery request budget exhausted (spent=${budget.spent}/${budget.settings.lifecycleMaxRequests}, deadline=${budget.deadline}) — request not dispatched; work stays due`,
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

function backoffFor(attemptsAfter: number): number {
  const index = Math.min(Math.max(attemptsAfter - 1, 0), LIFECYCLE_BACKOFF_MS.length - 1);
  return LIFECYCLE_BACKOFF_MS[index]!;
}

function giveUpLine(scope: Scope, workId: string, attempts: number, reason: string): string {
  return `gave up after ${attempts} attempts (app=${scope.appId}, installation=${scope.installationId}, owner=${scope.owner}, repo=${scope.repo}, pr=${scope.prNumber}, work=${workId}): ${reason}`;
}


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
    const settings = await getReconcileSettings(db);
    if (settings.issue) log.warn({ event: "ops_lifecycle_reconcile_settings_degraded", detail: JSON.stringify(settings.issue) }, "lifecycle reconcile settings unavailable — using defaults");
    const now = deps.now ?? (() => Date.now());
    const budget: RunBudget = { settings: settings.values, spent: 0, deadline: now() + settings.values.lifecycleRunBudgetMs, laneCap: settings.values.lifecycleMaxRequests };
    const reviewerFactory = deps.reviewer ?? productionReviewerFactory;
    const transport = buildTransport(budget, now);
    const reviewerCache = new Map<string, Promise<ReviewerResolution>>();

    const suspendedPairs = await listSuspendedLifecycleApps(db, budget.settings.lifecycleSelectLimit);
    for (const pair of suspendedPairs) {
      try {
        const row = await routingRow(db, pair.appId, pair.installationId);
        const active = row !== null && row.deleted_at === null && row.status === "active";
        if (!active) continue;
        if (pair.requiresIdentityProof) {
          const currentFingerprint = row === null ? null : await sha256Hex(row.private_key_enc);
          if (currentFingerprint === null || currentFingerprint === pair.credentialFingerprint) {
            continue;
          }
          if (!canSpend(budget, now(), IDENTITY_REQUESTS, false)) continue;
          const proof = await reviewerFactory({
            db,
            env,
            appId: pair.appId,
            installationId: pair.installationId,
            transport,
            now,
          });
          if (proof.kind !== "ok") {
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

    budget.laneCap = budget.settings.lifecyclePublicationLaneMaxRequests;
    await reconcilePublications(env, db, now, budget, reviewerFactory, transport, reviewerCache, log, summary);

    await reconcileLineBatches(db, now, budget, reviewerFactory, env, transport, reviewerCache, log, summary);

    budget.laneCap = budget.settings.lifecycleMaxRequests;
    await reconcileResolutions(env, db, now, budget, reviewerFactory, transport, reviewerCache, log, summary);

    log.info({ event: "ops_lifecycle_reconcile", ...summary }, "lifecycle reconcile pass complete");
    return summary;
  } catch (error) {
    summary.errors += 1;
    log.warn(
      { event: "ops_lifecycle_reconcile_failed", detail: error instanceof Error ? error.message : String(error) },
      "lifecycle reconcile failed — retained rows stay due",
    );
    return summary;
  }
}

const pairKeyOf = (scope: Scope): string => `${scope.appId}:${scope.installationId}`;

async function reviewerForPair(
  db: D1Like,
  env: ScheduledEnv,
  scope: Scope,
  now: () => number,
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
      return await reviewerFactory({ db, env, appId: scope.appId, installationId: scope.installationId, transport, now });
    } catch (error) {
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
    const pubs = await suspendPublicationRecovery(db, pair, suspension, now());
    const threads = await suspendResolutionRecovery(db, pair, suspension, now());
    summary.suspended += pubs + threads;
    log.warn(
      { event: "ops_lifecycle_pair_suspended", detail: reason },
      "credential routing unavailable — pair suspended durably",
    );
  }
  return settled;
}

const UNAVAILABLE_REASON_TEXT: Record<ReviewerUnavailableReason, string> = {
  missing: "mapping missing",
  deleted: "deleted",
  disabled: "disabled",
  "decrypt-failed": "credential decrypt failed",
  "identity-mismatch": "live App identity does not match the routed github_app_id — no GitHub mutation",
};


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
  const rows = await listPublicationRecovery(db, now(), budget.settings.lifecycleSelectLimit, budget.settings.lifecycleMaxAttempts);
  for (const row of rows) {
    summary.examined += 1;
    if (row.phase === "failed" || row.phase === "applied" || row.phase === "superseded") continue;
    if (row.phase === "confirmed") {
      await applyConfirmedPublication(db, now, budget, row, summary);
      continue;
    }
    const scope = row.payload.scope;
    if (!canSpend(budget, now(), 1, true)) continue;
    const resolved = await reviewerForPair(db, env, scope, now, budget, reviewerFactory, transport, reviewerCache, log, summary);
    if (resolved.kind === "unavailable") continue;
    if (row.phase === "prepared") {
      await sendPreparedPublication(db, now, budget, resolved, row, log, summary);
    } else {
      await discoverUncertainPublication(db, now, budget, resolved, row, summary);
    }
  }
}

async function settlementTailStatements(
  db: D1Like,
  row: PublicationRow,
  nowMs: number,
): Promise<D1StatementLike[]> {
  const attemptId = row.payload.attemptId;
  if (attemptId === undefined) return [];
  const statement = await settlementStatementIfDischarged(
    db,
    {
      attemptId,
      publicationId: row.id,
      landed: ["publication"],
    },
    nowMs,
  );
  return statement === null ? [] : [statement];
}

async function applyConfirmedPublication(
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  row: PublicationRow,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const lease = await claimPublication(db, row.id, HOLDER, now(), row.phase);
  if (lease === null) return;
  try {
    const at = now();
    const tail = await settlementTailStatements(db, row, at);
    const applied = await applyPublishedLifecycle(db, row.id, lease, at, now, () => tail);
    if (applied) {
      summary.applied += 1;
      return;
    }
    await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "apply rejected (lease/proof/payload gate)", summary, false);
  } catch (error) {
    await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, error instanceof Error ? error.message : String(error), summary, false);
  }
}

async function reconcileLineBatches(
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  reviewerFactory: NonNullable<LifecycleReconcileDeps["reviewer"]>,
  env: ScheduledEnv,
  transport: ReconcileTransport,
  reviewerCache: Map<string, Promise<ReviewerResolution>>,
  log: ReconcileLog,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const handled = new Set<string>();
  for (;;) {
    const rows = await listLineBatchRecovery(db, now(), budget.settings.lifecycleSelectLimit);
    let retired = 0;
    for (const row of rows) {
      if (handled.has(row.id)) continue;
      handled.add(row.id);
      const scope = row.payload.scope;
      if (!canSpend(budget, now(), 1, true)) continue;
      const lease = await recordLineDispatchIntent(db, row.id, `recovery-lines:${row.id}`, now());
      if (lease === null) {
        const state = await readLineBatchState(db, row.id);
        if (!state.pending) continue;
        const resolved = await reviewerForPair(db, env, scope, now, budget, reviewerFactory, transport, reviewerCache, log, summary);
        if (resolved.kind === "unavailable") continue;
        let recovered: PostedLineComments;
        try {
          recovered = await resolved.reviewer.recoverLineComments(lineInputOf(row));
        } catch (error) {
          if (isBudgetRefusal(error)) {
            log.info(
              { event: "ops_lifecycle_line_discovery_deferred", detail: `publication=${row.id}: request budget exhausted` },
              "line-comment discovery deferred — nothing was read and no attempt is spent",
            );
            continue;
          }
          if (await noteLineDiscoveryFailure(db, row, "readback-scope", state.captures, now(), budget.settings.lifecycleMaxAttempts, log)) retired += 1;
          log.warn(
            { event: "ops_lifecycle_line_discovery_failed", detail: `publication=${row.id}: ${error instanceof Error ? error.message : String(error)}` },
            "line-comment discovery failed — the dispatch intent keeps the batch discovery-only",
          );
          continue;
        }
        let newlyCaptured = 0;
        try {
          newlyCaptured = await captureLineComments(db, row.id, recovered.reviewId, recovered.posted, now());
        } catch (error) {
          log.warn(
            { event: "ops_lifecycle_line_capture_failed", detail: `publication=${row.id}: ${error instanceof Error ? error.message : String(error)}` },
            "line-comment id capture failed — the intent stays, discovery owns the rest",
          );
        }
        if (newlyCaptured > 0) {
          await resetLineDiscoveryFailures(db, row.id);
        } else if (recovered.failure !== "budget-refused") {
          const reason: LineDiscoveryFailure =
            recovered.captured || recovered.failure === undefined ? "capture-failed" : recovered.failure;
          if (await noteLineDiscoveryFailure(db, row, reason, state.captures, now(), budget.settings.lifecycleMaxAttempts, log)) retired += 1;
        }
        log.info(
          { event: "ops_lifecycle_line_discovery", detail: `publication=${row.id} captured=${recovered.captured}` },
          "line-comment batch discovered without a second send",
        );
        continue;
      }
      const resolved = await reviewerForPair(db, env, scope, now, budget, reviewerFactory, transport, reviewerCache, log, summary);
      if (resolved.kind === "unavailable") {
        await releaseLineDispatch(db, row.id, lease, now(), false);
        continue;
      }
      const input = lineInputOf(row);
      const admitted = await admittedAttemptOf(db, row.payload.admittedAttemptId);
      if (admitted.kind === "unresolved") {
        await releaseLineDispatch(db, row.id, lease, now(), false);
        log.warn(
          { event: "ops_lifecycle_line_unresolved", detail: `publication=${row.id}: ${admitted.reason}` },
          "line-comment batch not sent — its admitted attempt cannot be resolved",
        );
        continue;
      }
      let outcome: "sent" | "refused" | "unknown" = "unknown";
      try {
        const posted = await resolved.reviewer.postLineComments({
          ...input,
          journalClaim: lease,
          ...(admitted.kind === "check" ? { attemptId: admitted.attemptId } : {}),
        });
        try {
          await captureLineComments(db, row.id, posted.reviewId, posted.posted, now());
        } catch (error) {
          log.warn(
            { event: "ops_lifecycle_line_capture_failed", detail: `publication=${row.id}: ${error instanceof Error ? error.message : String(error)}` },
            "line-comment id capture failed — the intent stays, discovery owns the rest",
          );
        }
        outcome = "sent";
      } catch (error) {
        if (error instanceof PreparedSendRejected) outcome = "refused";
        log.warn(
          { event: "ops_lifecycle_line_send_failed", detail: `publication=${row.id}: ${error instanceof Error ? error.message : String(error)}` },
          "line-comment batch send failed — an unresolved send stays discovery-only",
        );
      } finally {
        if (outcome !== "unknown") await releaseLineDispatch(db, row.id, lease, now(), outcome === "sent");
      }
    }
    if (retired === 0) return;
  }
}

async function noteLineDiscoveryFailure(
  db: D1Like,
  row: PublicationRow,
  reason: LineDiscoveryFailure,
  observedCaptures: number,
  nowMs: number,
  maxAttempts: number,
  log: ReconcileLog,
): Promise<boolean> {
  const settled = await recordLineDiscoveryFailure(db, row.id, reason, observedCaptures, nowMs, maxAttempts);
  if (settled === null || !settled.unresolvable) return false;
  log.warn(
    {
      event: "ops_lifecycle_line_unresolvable",
      detail: `publication=${row.id} reason=${reason} attempts=${settled.attempts}`,
    },
    "line-comment batch left the recovery set — its remote batch cannot be read back",
  );
  return true;
}

function lineInputOf(row: PublicationRow): PostPreparedLineCommentsInput {
  const scope = row.payload.scope;
  return {
    installationId: scope.installationId,
    owner: scope.owner,
    repo: scope.repo,
    prNumber: scope.prNumber,
    headSha: row.payload.headSha,
    round: row.payload.round,
    publicationId: row.id,
    intents: row.payload.lineIntents,
  };
}

type AdmittedAttempt =
  | { kind: "check"; attemptId: string }
  | { kind: "no-check" }
  | { kind: "unresolved"; reason: string };

async function admittedAttemptOf(db: D1Like, admittedAttemptId: string | undefined): Promise<AdmittedAttempt> {
  if (admittedAttemptId === undefined) {
    return { kind: "unresolved", reason: "the staged payload records no admitted attempt (pre-binding row)" };
  }
  const launch = await db
    .prepare(`SELECT attempt_key, attempt_generation FROM review_launches WHERE attempt_id = ?`)
    .bind(admittedAttemptId)
    .first<{ attempt_key: string | null; attempt_generation: number | null }>();
  if (launch === null) return { kind: "unresolved", reason: `admitted attempt ${admittedAttemptId} has no launch row` };
  if (launch.attempt_key === null || launch.attempt_generation === null) return { kind: "no-check" };
  const check = await db
    .prepare(`SELECT id FROM review_checks WHERE attempt_key = ? AND generation = ?`)
    .bind(launch.attempt_key, launch.attempt_generation)
    .first<{ id: string }>();
  if (check === null) {
    return { kind: "no-check" };
  }
  return { kind: "check", attemptId: check.id };
}

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
  if (resolved.paused) return;
  const createdMs = await getPublicationCreatedMs(db, row.id);
  if (createdMs === null || now() - createdMs < PREPARED_SEND_MIN_AGE_MS) return;
  if (!canSpend(budget, now(), PLAN_REQUESTS + SEND_REQUESTS, true)) return;
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
  const degradedTarget =
    row.payload.kind === "degraded" && row.payload.targetCommentId !== null
      ? { scope, commentId: row.payload.targetCommentId }
      : null;
  let degradedTargetLease: Lease | null = null;
  if (degradedTarget !== null) {
    degradedTargetLease = await claimDegradedTarget(db, {
      ...degradedTarget,
      holder: `recovery-degraded:${row.id}`,
      nowMs: now(),
    });
    if (degradedTargetLease === null) {
      log.warn(
        { event: "ops_lifecycle_degraded_target_busy", detail: `publication=${row.id} comment=${degradedTarget.commentId}` },
        "degraded target is held by its cleanup or unresolved — no send",
      );
      return;
    }
  }
  const lease = await claimPublication(db, row.id, HOLDER, now(), "prepared");
  if (lease === null) {
    if (degradedTarget !== null && degradedTargetLease !== null) {
      await releaseDegradedTarget(db, { ...degradedTarget, lease: degradedTargetLease, nowMs: now(), keep: false });
    }
    return;
  }
  try {
    const admitted = await admittedAttemptOf(db, row.payload.admittedAttemptId);
    if (admitted.kind === "unresolved") {
      throw new PublicationAuthorityUnavailable(`${admitted.reason} — nothing was sent`);
    }
    const target = {
      appId: scope.appId,
      installationId: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
      prNumber: scope.prNumber,
      headSha: row.payload.headSha,
      round: row.payload.round,
      targetCommentId: row.payload.targetCommentId,
      body: row.payload.body,
      publicationId: row.id,
      journalClaim: lease,
      ...(admitted.kind === "check" ? { attemptId: admitted.attemptId } : {}),
    };
    let commentId: number;
    if (row.payload.kind === "degraded") {
      const sent = await resolved.reviewer.postPreparedDegraded(target);
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
      await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "proof persistence rejected the confirmation", summary, true);
      return;
    }
    const at = now();
    const tail = await settlementTailStatements(db, row, at);
    const applied = await applyPublishedLifecycle(db, row.id, lease, at, now, () => tail);
    if (applied) {
      summary.applied += 1;
      return;
    }
    await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "post-proof apply did not complete", summary, false);
  } catch (error) {
    if (error instanceof PublicationAuthorityUnavailable) {
      const restored = await releaseUnspentPublicationClaim(db, row.id, lease, now());
      if (!restored) {
        summary.errors += 1;
        log.warn(
          { event: "ops_lifecycle_publication_claim_restore_missed", detail: `publication=${row.id}` },
          "action contended by another lane and the claim had already moved — row left to its current owner",
        );
        return;
      }
      log.info(
        { event: "ops_lifecycle_publication_authority_busy", detail: `publication=${row.id}: ${error.message}` },
        "publication action held by another lane — no send, claim returned, row stays due",
      );
      return;
    }
    if (error instanceof PreparedSendRejected) {
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
      const restored = await releaseUnspentPublicationClaim(db, row.id, lease, now());
      if (!restored) {
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
    await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, error instanceof Error ? error.message : String(error), summary, true);
  } finally {
    if (degradedTarget !== null && degradedTargetLease !== null) {
      await releaseDegradedTarget(db, { ...degradedTarget, lease: degradedTargetLease, nowMs: now(), keep: false });
    }
  }
}

async function discoverUncertainPublication(
  db: D1Like,
  now: () => number,
  budget: RunBudget,
  resolved: Extract<ReviewerResolution, { kind: "ok" }>,
  row: PublicationRow,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const scope = row.payload.scope;
  if (!canSpend(budget, now(), DISCOVERY_REQUESTS, true)) return;
  const lease = await claimPublication(db, row.id, HOLDER, now(), row.phase);
  if (lease === null) return;
  try {
    const discussion = await resolved.reviewer.listDiscussion({
      installationId: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
      prNumber: scope.prNumber,
      threads: [],
      includeOwnPublications: true,
    });
    const hit = discussion.items.find(
      (item) => item.source === "issue" && item.ownAuthor === true && item.body === row.payload.body,
    );
    if (hit === undefined) {
      await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "read-only discovery found no exact publication match", summary, true);
      return;
    }
    const commentId = Number(hit.id);
    if (!Number.isSafeInteger(commentId) || commentId <= 0) {
      await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "discovered publication carries an unusable comment id", summary, true);
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
      await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "proof persistence rejected the discovered publication", summary, true);
      return;
    }
    const at = now();
    const tail = await settlementTailStatements(db, row, at);
    const applied = await applyPublishedLifecycle(db, row.id, lease, at, now, () => tail);
    if (applied) {
      summary.applied += 1;
      return;
    }
    await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, "post-proof apply did not complete", summary, false);
  } catch (error) {
    await settleFailedPublicationAttempt(db, now, budget.settings.lifecycleMaxAttempts, row, lease, error instanceof Error ? error.message : String(error), summary, true);
  }
}

async function settleFailedPublicationAttempt(
  db: D1Like,
  now: () => number,
  maxAttempts: number,
  row: PublicationRow,
  lease: Lease,
  reason: string,
  summary: LifecycleReconcileSummary,
  uncertain: boolean,
): Promise<void> {
  const attemptsAfter = row.attempts + 1;
  if (attemptsAfter >= maxAttempts) {
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
  const rows = await listResolutionRecovery(db, now(), budget.settings.lifecycleSelectLimit, budget.settings.lifecycleMaxAttempts);
  for (const { associationId, scope } of rows) {
    if (!canSpend(budget, now(), budget.settings.lifecycleThreadOperationRequests, false)) return;
    summary.examined += 1;
    const resolved = await reviewerForPair(db, env, scope, now, budget, reviewerFactory, transport, reviewerCache, log, summary);
    if (resolved.kind === "unavailable") continue;
    const work = await getResolutionRecoveryRow(db, associationId);
    if (work === null) continue;
    let verified;
    try {
      verified = JSON.parse(work.verifiedJson);
    } catch {
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
          break;
        case "needs-recheck":
          await recordNeedsRecheck(db, associationId, `resolve deferred to the next real review: ${outcome.reason}`, now());
          summary.unknown += 1;
          break;
        case "retry":
          await settleFailedResolveAttempt(db, now, budget.settings.lifecycleMaxAttempts, associationId, work, outcome.reason, summary);
          break;
      }
    } catch (error) {
      await settleFailedResolveAttempt(db, now, budget.settings.lifecycleMaxAttempts, associationId, work, error instanceof Error ? error.message : String(error), summary);
    }
  }
}

async function settleFailedResolveAttempt(
  db: D1Like,
  now: () => number,
  maxAttempts: number,
  associationId: string,
  work: { scope: Scope; attempts: number },
  reason: string,
  summary: LifecycleReconcileSummary,
): Promise<void> {
  const attemptsAfter = work.attempts + 1;
  if (attemptsAfter >= maxAttempts) {
    await markResolutionLocalError(db, associationId, giveUpLine(work.scope, associationId, attemptsAfter, reason), now());
    summary.errors += 1;
    return;
  }
  const nextAttemptMs = now() + backoffFor(attemptsAfter);
  const deferred = await deferResolutionRecovery(db, associationId, nextAttemptMs, reason, now());
  if (deferred) summary.errors += 1;
}
