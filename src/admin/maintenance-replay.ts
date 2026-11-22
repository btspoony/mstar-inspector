/**
 * Operator replay of a maintenance-deferred delivery.
 *
 * A delivery the maintenance window outlived records a
 * `stage = 'maintenance_deferred'` `review_failures` row and nothing ever
 * replays it. Replay is a FRESH recovery of that PR's current head, not a
 * re-delivery of the old webhook: the carrier holds failure identity only
 * (`src/store/failure-store.ts`), so the operator names ONE failure id and this
 * module rebuilds the job from the live target.
 *
 * The request is a small outbox. In ONE batch this module appends the audit row
 * and stamps `maintenance_replay_requested_at` under a `requested IS NULL`
 * guard, so exactly one caller wins (`meta.changes = 1`) and only the winner
 * sends. A loser returns the state already on the row: no second audit, no
 * second send. `maintenance_replay_sent_at` is stamped only after the send
 * resolves, so a crash between request and send leaves durable pending state
 * the sweep retries while the window is open.
 *
 * shortcut: queue send and D1 sent-stamp cannot commit atomically; recovery can
 * resend after a crash or concurrent sweep, with existing D1/PR guards
 * preventing a second completed review. upgrade: only if exactly-once enqueue
 * becomes a confirmed requirement.
 */
import type { Queue } from "@cloudflare/workers-types";
import { MAINTENANCE_DEFERRED_STAGE } from "../contracts/failure-stages";
import type { ReviewJobPayload } from "../contracts/review-job";
import { getMaintenanceMode } from "../dashboard/runtime-config-store";
import type { DashboardD1 } from "../dashboard/users";
import { redactSecrets } from "../pipeline/redact";

/** The columns replay reads from one failure row (migration 0010 + 0071). */
export type MaintenanceReplayFailureRow = {
  id: string;
  target_id: string | null;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  stage: string;
  maintenance_replay_requested_at: string | null;
  maintenance_replay_sent_at: string | null;
};

/** A live target, bot and workspace the replay job must resolve to. */
export type MaintenanceReplayTarget = { targetId: string; botId: string };

/** Where a replay request stands on its failure row. */
export type MaintenanceReplayState = "requested" | "sent";

/**
 * What one request did. `refused` covers every precondition the operator
 * cannot bypass; `ok` is the winner's send outcome, `repeat` an already
 * requested row.
 */
export type MaintenanceReplayOutcome =
  | { kind: "ok"; state: MaintenanceReplayState }
  | { kind: "repeat"; state: MaintenanceReplayState }
  | { kind: "refused"; error: MaintenanceReplayRefusal; status: 404 | 409 | 503 };

/** The frozen refusal vocabulary of the replay route. */
export type MaintenanceReplayRefusal =
  | "unknown_failure"
  | "not_maintenance_deferred"
  | "maintenance_active"
  | "maintenance_unreadable"
  | "target_unavailable"
  | "queue_unavailable";

export const MAINTENANCE_REPLAY_AUDIT_ACTION = "maintenance.deferred.replay";

/**
 * The queue payload of a replay: the failure's delivery identity, the target's
 * live bot, and no `head_sha` / `head_at` / `comment_id` / `attachDeliveryId` /
 * credentials — the consumer resolves the authoritative head and every
 * admission itself, so a force-pushed PR reviews the head it now has.
 */
export function maintenanceReplayPayload(
  failure: MaintenanceReplayFailureRow,
  target: MaintenanceReplayTarget,
): ReviewJobPayload {
  return {
    installation_id: failure.installation_id,
    owner: failure.owner,
    repo: failure.repo,
    pr_number: failure.pr_number,
    head_sha: null,
    action: "maintenance_replay",
    triggered_by: "pull_request",
    botRef: { appId: target.botId },
    targetId: target.targetId,
  };
}

async function readFailure(db: DashboardD1, id: string): Promise<MaintenanceReplayFailureRow | null> {
  return db
    .prepare(
      `SELECT id, target_id, installation_id, owner, repo, pr_number, stage,
              maintenance_replay_requested_at, maintenance_replay_sent_at
         FROM review_failures WHERE id = ?`,
    )
    .bind(id)
    .first<MaintenanceReplayFailureRow>();
}

async function readLiveTarget(db: DashboardD1, failureId: string): Promise<MaintenanceReplayTarget | null> {
  const row = await db
    // shortcut: tenant-bypass — internal maintenance read (operator route and sweep
    // retry); it returns no identity or ownership column, and the workspace join is
    // the tenant gate. upgrade: tenant-filter it once the maintenance replay becomes
    // workspace-scoped.
    .prepare(
      `SELECT t.id AS target_id, t.bot_id AS bot_id
         FROM review_failures f
         JOIN review_targets t ON t.id = f.target_id AND t.deleted_at IS NULL
         JOIN review_bots b ON b.id = t.bot_id AND b.deleted_at IS NULL AND b.status = 'active'
         JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
        WHERE f.id = ?`,
    )
    .bind(failureId)
    .first<{ target_id: string; bot_id: string }>();
  return row === null ? null : { targetId: row.target_id, botId: row.bot_id };
}

async function stampAttempt(db: DashboardD1, id: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE review_failures SET maintenance_replay_last_attempt_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

async function stampSent(db: DashboardD1, id: string, now: string): Promise<void> {
  await db
    .prepare(
      `UPDATE review_failures SET maintenance_replay_sent_at = ?
        WHERE id = ? AND maintenance_replay_sent_at IS NULL`,
    )
    .bind(now, id)
    .run();
}

/**
 * Request (or observe) one replay. The caller has already authorized the
 * operator; this function owns the state machine and the one send.
 *
 * Ordering is the contract: an already-requested row is answered from its own
 * stamps before any window gate, because a recorded request is operator-visible
 * durable state, not a new send; an unreadable or closed window then refuses a
 * NEW request before any state is written, and a target or queue that cannot
 * carry the job refuses before the batch writes anything.
 */
export async function requestMaintenanceReplay(
  db: DashboardD1,
  queue: Queue<ReviewJobPayload> | undefined,
  input: { failureId: string; actor: string; now: string },
): Promise<MaintenanceReplayOutcome> {
  const failure = await readFailure(db, input.failureId);
  if (failure === null) return { kind: "refused", error: "unknown_failure", status: 404 };
  if (failure.stage !== MAINTENANCE_DEFERRED_STAGE) {
    return { kind: "refused", error: "not_maintenance_deferred", status: 409 };
  }
  if (failure.maintenance_replay_requested_at !== null) {
    return {
      kind: "repeat",
      state: failure.maintenance_replay_sent_at === null ? "requested" : "sent",
    };
  }
  const maintenance = await getMaintenanceMode(db);
  if (maintenance.unreadable) return { kind: "refused", error: "maintenance_unreadable", status: 503 };
  if (maintenance.enabled) return { kind: "refused", error: "maintenance_active", status: 409 };
  const target = await readLiveTarget(db, failure.id);
  if (target === null) return { kind: "refused", error: "target_unavailable", status: 409 };
  if (queue === undefined) return { kind: "refused", error: "queue_unavailable", status: 503 };

  const [, request] = await db.batch([
    db
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         SELECT ?, ?, ?, 'review_failure', ?, json_object('target_id', ?), ?
          WHERE EXISTS (SELECT 1 FROM review_failures
                         WHERE id = ? AND stage = ? AND maintenance_replay_requested_at IS NULL)`,
      )
      .bind(
        crypto.randomUUID(),
        input.actor,
        MAINTENANCE_REPLAY_AUDIT_ACTION,
        failure.id,
        target.targetId,
        input.now,
        failure.id,
        MAINTENANCE_DEFERRED_STAGE,
      ),
    db
      .prepare(
        `UPDATE review_failures SET maintenance_replay_requested_at = ?
          WHERE id = ? AND stage = ? AND maintenance_replay_requested_at IS NULL`,
      )
      .bind(input.now, failure.id, MAINTENANCE_DEFERRED_STAGE),
  ]);
  if ((request?.meta.changes ?? 0) === 0) {
    const current = await readFailure(db, failure.id);
    if (current === null) return { kind: "refused", error: "unknown_failure", status: 404 };
    return {
      kind: "repeat",
      state: current.maintenance_replay_sent_at === null ? "requested" : "sent",
    };
  }

  try {
    await stampAttempt(db, failure.id, input.now);
    await queue.send(maintenanceReplayPayload(failure, target));
    await stampSent(db, failure.id, input.now);
    return { kind: "ok", state: "sent" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        event: "maintenance_replay_send_failed",
        failure_id: failure.id,
        detail: redactSecrets(detail),
      }),
    );
    return { kind: "ok", state: "requested" };
  }
}

/** What one sweep retry did: the send resolved, or there is no live target left. */
export type MaintenanceReplayRetry = "sent" | "target_unavailable";

/**
 * Retry ONE pending replay from the sweep's outbox scan: rebuild the frozen
 * payload from the row's CURRENT live target, send, and stamp sent only once the
 * send resolves. A send or stamp failure throws, so the caller warns and the row
 * stays pending for the next sweep. The row is never deleted.
 *
 * The attempt is stamped BEFORE the target is resolved — dead target included.
 * The scan orders never-tried and least-recently-tried first and every row it
 * touches spends one unit of the shared budget, so an unstamped dead row would
 * be handed the whole budget on every sweep and the requests behind it would
 * never be attempted.
 */
export async function retryMaintenanceReplay(
  db: DashboardD1,
  queue: Queue<ReviewJobPayload>,
  failureId: string,
  now: string,
): Promise<MaintenanceReplayRetry> {
  const failure = await readFailure(db, failureId);
  if (failure === null) return "target_unavailable";
  await stampAttempt(db, failure.id, now);
  const target = await readLiveTarget(db, failure.id);
  if (target === null) return "target_unavailable";
  await queue.send(maintenanceReplayPayload(failure, target));
  await stampSent(db, failure.id, now);
  return "sent";
}
