/**
 * Operator data upgrades (spec operator-data-upgrade § Upgrade registry and
 * state machine, D8).
 *
 * A data upgrade is NOT a schema migration: it moves rows that already exist
 * (the repository backfill repoints ledger rows between targets), so its
 * progress must survive a worker that dies mid-batch. The state row
 * (`operator_data_upgrades`, migration 0069) carries the resume point; this
 * module is the only writer of that row, and it never touches item data — an
 * item owns its own SQL and its own single transaction per batch.
 *
 * Crash safety is IDEMPOTENT REPLAY, not a two-phase commit: the batch commits
 * on its own, the cursor commits after it, and a worker that dies between the
 * two re-runs one batch. Item worklist predicates exclude migrated rows, so
 * that replay moves nothing (spec § Invariants). The `operator_data_upgrades`
 * row is started BEFORE the first batch runs, so a batch that throws still
 * leaves an honest `running` row with its ownership recorded.
 *
 * Maintenance is read and written through `getMaintenanceMode` /
 * `setMaintenanceMode` only — one writer path, the same one the operator
 * console uses.
 */
import { getMaintenanceMode, setMaintenanceMode } from "../dashboard/runtime-config-store";
import type { DashboardD1, DashboardD1Statement } from "../dashboard/users";
import { repoBackfill } from "./data-upgrades/repo-backfill";

/** Where an item resumes. Opaque to the runner; the item owns its shape. */
export type UpgradeCursor = Record<string, unknown>;

/** Counts an item reports. `verify` fails on any NON-ZERO entry. */
export type UpgradeCounts = Record<string, number>;

/** What one batch did: the resume point, the rows it moved, and whether it finished. */
export type UpgradeBatch = {
  /** The cursor the NEXT batch starts from; `null` when nothing is left. */
  cursor: UpgradeCursor | null;
  /** Rows this batch moved. `0` on a replay over finished work. */
  processed: number;
  /** The walk is finished — the next step processes nothing. */
  done: boolean;
  /** One JSON object describing the batch (counts, discarded work), appended to `log_json`. */
  log?: UpgradeCursor;
};

/**
 * One registered upgrade. Frozen contract (spec § Upgrade registry and state
 * machine): `preflight` and `verify` are read-only, `runBatch` performs ONE
 * transaction and is replayable.
 */
export type DataUpgradeItem = {
  /** Stable slug; the state row's primary key. */
  id: string;
  title: string;
  /** Refuses `step` while the maintenance window is off (after its first step). */
  requiresDowntime: boolean;
  /** Run order in the console's list. */
  order: number;
  /** Counts the operator sees before starting. No writes. */
  preflight(db: DashboardD1): Promise<UpgradeCounts>;
  /** Move one batch of rows. ONE transaction; a replay over migrated rows moves nothing. */
  runBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<UpgradeBatch>;
  /**
   * Read-only checks; every entry must read `0` for the item to complete,
   * except the ones named here — those are REPORTED (in `checks`, and so on the
   * console) and never fail the item.
   */
  advisoryChecks?: readonly string[];
  /**
   * Read-only checks; every entry must read `0` for the item to complete.
   * `runStartedAt` is when the current run began (`run_started_at`), so an item
   * can tell the rows it could have stranded from deletions that predate it.
   */
  verify(db: DashboardD1, context: UpgradeVerifyContext): Promise<UpgradeCounts>;
};

/** The run the item's `verify` is judging: one run, stamped by its first step. */
export type UpgradeVerifyContext = { runStartedAt: string | null };

/** The state machine's states; the table's CHECK is the runtime authority. */
export type DataUpgradeStatus = "pending" | "running" | "verifying" | "completed" | "failed";

/** One upgrade's row, as the console states it. */
export type DataUpgradeState = {
  id: string;
  status: DataUpgradeStatus;
  cursor: UpgradeCursor | null;
  processed: number;
  /** The runner opened the maintenance window, so only it may close it. */
  maintenanceOwned: boolean;
  /** The per-phase in-flight claim; NULL between phases. */
  startedAt: string | null;
  /** When the current run began retiring rows; NULL before its first step and after a reset. */
  runStartedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** One entry per batch: what it moved and what it discarded. */
  log: UpgradeCursor[];
};

/**
 * Every registered upgrade, in run order — the registry's single source.
 * `repo-backfill` is the historical-identity item (plan 373 task 3); the
 * runner, the table and the routes are item-agnostic, so registering an item
 * is the only change a new upgrade needs.
 */
export const DATA_UPGRADES: DataUpgradeItem[] = [repoBackfill];

/** Resolve a registered item; `null` is the route layer's 404. */
export function findDataUpgrade(id: string): DataUpgradeItem | null {
  return DATA_UPGRADES.find((item) => item.id === id) ?? null;
}

/** One state-row read. */
type DataUpgradeRow = {
  id: string;
  status: string;
  cursor_json: string | null;
  processed: number;
  maintenance_owned: number;
  started_at: string | null;
  run_started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  log_json: string | null;
};

const STATE_COLUMNS =
  "id, status, cursor_json, processed, maintenance_owned, started_at, run_started_at, finished_at, last_error, log_json";

/** An absent row is the documented `pending` state — nothing was ever started. */
function pendingState(id: string): DataUpgradeState {
  return {
    id,
    status: "pending",
    cursor: null,
    processed: 0,
    maintenanceOwned: false,
    startedAt: null,
    runStartedAt: null,
    finishedAt: null,
    lastError: null,
    log: [],
  };
}

/**
 * A stored cursor that no longer parses is treated as ABSENT: the item is
 * idempotent, so restarting the walk moves nothing that is already migrated.
 */
function parseCursor(value: string | null): UpgradeCursor | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as UpgradeCursor)
      : null;
  } catch {
    return null;
  }
}

/** A stored log that no longer parses is absent evidence, never a failed read. */
function parseLog(value: string | null): UpgradeCursor[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as UpgradeCursor[]) : [];
  } catch {
    return [];
  }
}

function stateFromRow(row: DataUpgradeRow): DataUpgradeState {
  return {
    id: row.id,
    status: row.status as DataUpgradeStatus,
    cursor: parseCursor(row.cursor_json),
    processed: row.processed,
    maintenanceOwned: row.maintenance_owned === 1,
    startedAt: row.started_at,
    runStartedAt: row.run_started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    log: parseLog(row.log_json),
  };
}

/** One upgrade's state, `pending` when it was never started. */
async function readDataUpgradeState(db: DashboardD1, id: string): Promise<DataUpgradeState> {
  const row = await db
    .prepare(`SELECT ${STATE_COLUMNS} FROM operator_data_upgrades WHERE id = ?1`)
    .bind(id)
    .first<DataUpgradeRow>();
  return row === null ? pendingState(id) : stateFromRow(row);
}

/** One console row: the item's declaration, its state and its preflight counts. */
export type DataUpgradeListing = {
  id: string;
  title: string;
  requiresDowntime: boolean;
  order: number;
  state: DataUpgradeState;
  preflight: UpgradeCounts;
};

/**
 * Every registered upgrade with its state and preflight counts, in `order`.
 * States come from ONE read of the state table (`log_json` included in the row
 * shape only), never one statement per item.
 */
export async function listDataUpgrades(db: DashboardD1): Promise<DataUpgradeListing[]> {
  const rows = await db
    .prepare(`SELECT ${STATE_COLUMNS} FROM operator_data_upgrades`)
    .all<DataUpgradeRow>();
  const stored = new Map(rows.results.map((row) => [row.id, stateFromRow(row)]));
  return Promise.all(
    [...DATA_UPGRADES]
      .sort((a, b) => a.order - b.order)
      .map(async (item) => ({
        id: item.id,
        title: item.title,
        requiresDowntime: item.requiresDowntime,
        order: item.order,
        state: stored.get(item.id) ?? pendingState(item.id),
        preflight: await item.preflight(db),
      })),
  );
}

/** Clears the in-flight claim after a phase that threw (the stored status stays). */
const CLAIM_RELEASE_SQL = "UPDATE operator_data_upgrades SET started_at = NULL WHERE id = ?1";

/** Drop the claim a phase took, keeping the error that is about to surface. */
async function releaseClaim(db: DashboardD1, id: string): Promise<void> {
  // A release that fails must not mask the real error: the lease self-heals.
  await db.prepare(CLAIM_RELEASE_SQL).bind(id).run().catch(() => {});
}

/**
 * A claim stamp older than this is presumed dead: the worker that took it never
 * released it (a phase is bounded — one worklist page, chunked binds). The stale
 * window IS the lease expiry, so a crashed phase never wedges the item.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Claim the item for ONE phase — the compare-and-set `step`, `verify` and
 * `reset` all take, so two phases never interleave on one item.
 *
 * `started_at` is the CLAIM STAMP: non-NULL only while a phase is in flight, so
 * the row itself is the single-flight lock and no extra column is needed. A row
 * with no claim held (or one absent, which the INSERT creates) is claimable at
 * once; a held claim only once it went stale. `meta.changes === 0` means
 * somebody else holds the lease — the caller refuses with `upgrade_running`
 * instead of acting on a row another phase is about to rewrite.
 *
 * `allowed` is the status set the phase may take the item from, so a phase that
 * lost a read-then-claim race against a DIFFERENT phase also refuses instead of
 * resurrecting a state that phase already wrote.
 */
function claimSql(allowed: readonly DataUpgradeStatus[], stampsRunStart: boolean): string {
  const list = allowed.map((status) => `'${status}'`).join(", ");
  // Only `step` retires rows, so only its claim stamps the run: the first step
  // of a run sets it and every later one keeps it (`?4` is the claim stamp).
  const runColumn = stampsRunStart ? ", run_started_at" : "";
  const runValue = stampsRunStart ? ", ?4" : "";
  const runSet = stampsRunStart
    ? ",\n    run_started_at = COALESCE(operator_data_upgrades.run_started_at, ?4)"
    : "";
  return `
  INSERT INTO operator_data_upgrades (id, status, maintenance_owned, started_at${runColumn})
  VALUES (?1, ?2, ?3, ?4${runValue})
  ON CONFLICT (id) DO UPDATE SET
    status = ?2,
    maintenance_owned = ?3,
    started_at = ?4${runSet}
  WHERE operator_data_upgrades.status IN (${list})
    AND (operator_data_upgrades.started_at IS NULL
         OR operator_data_upgrades.started_at < ?5)`;
}

/** `verifying` is included so a verify interrupted mid-flight can be retried. */
const VERIFIABLE_STATUSES: readonly DataUpgradeStatus[] = ["running", "verifying", "failed"];

const STEP_CLAIM_SQL = claimSql(["pending", "running"], true);
const VERIFY_CLAIM_SQL = claimSql(VERIFIABLE_STATUSES, false);
const RESET_CLAIM_SQL = claimSql(["pending", "running", "verifying", "completed", "failed"], false);

/** Take the phase's claim; `false` means another phase holds the item. */
async function claimUpgrade(
  db: DashboardD1,
  sql: string,
  id: string,
  status: DataUpgradeStatus,
  maintenanceOwned: 0 | 1,
  now: string,
): Promise<boolean> {
  const claim = await db
    .prepare(sql)
    .bind(id, status, maintenanceOwned, now, new Date(Date.parse(now) - CLAIM_LEASE_MS).toISOString())
    .run();
  return claim.meta.changes !== 0;
}

/** One claim-guarded write's verdict: `refused` means the row no longer carries our stamp. */
type ClaimStep = "ok" | "refused";

/** Run one claim-guarded UPDATE; `refused` when no row matched the stamp. */
async function guardedWrite(db: DashboardD1, sql: string, ...binds: unknown[]): Promise<ClaimStep> {
  const result = await db.prepare(sql).bind(...binds).run();
  return result.meta.changes === 0 ? "refused" : "ok";
}

/**
 * Step 1 of a verify: settle the status while OUR stamp still guards the row.
 * `started_at` stays set — the claim is released by step 3, so no later phase
 * can claim the row while this one still has maintenance side effects to run.
 * `finished_at` is written only on completion: a failed item never finished.
 */
export async function settleVerifyState(
  db: DashboardD1,
  id: string,
  status: "completed" | "failed",
  lastError: string | null,
  now: string,
): Promise<ClaimStep> {
  return status === "completed"
    ? guardedWrite(
        db,
        `UPDATE operator_data_upgrades
            SET status = 'completed', finished_at = ?2, last_error = NULL
          WHERE id = ?1 AND status = 'verifying' AND started_at = ?3`,
        id,
        now,
        now,
      )
    : guardedWrite(
        db,
        `UPDATE operator_data_upgrades
            SET status = 'failed', last_error = ?2
          WHERE id = ?1 AND status = 'verifying' AND started_at = ?3`,
        id,
        lastError,
        now,
      );
}

/**
 * Step 2: close the window this item owns, then drop its ownership flag — both
 * under our stamp, so a reset that claimed the row in between cannot have its
 * window closed by a phase that already finished. An operator-closed window is
 * left alone: re-stating "off" would append an audit row for a change nobody
 * made.
 */
export async function settleUpgradeMaintenance(
  db: DashboardD1,
  id: string,
  status: DataUpgradeStatus,
  actor: string,
  now: string,
): Promise<ClaimStep> {
  if ((await getMaintenanceMode(db)).enabled) {
    await setMaintenanceMode(db, { enabled: false, actor }, now);
  }
  return guardedWrite(
    db,
    `UPDATE operator_data_upgrades
        SET maintenance_owned = 0
      WHERE id = ?1 AND status = ?2 AND maintenance_owned = 1 AND started_at = ?3`,
    id,
    status,
    now,
  );
}

/** Last step of every phase: clearing the stamp is what re-opens the row to another phase. */
export async function releaseUpgradeClaim(
  db: DashboardD1,
  id: string,
  status: DataUpgradeStatus,
  now: string,
): Promise<ClaimStep> {
  return guardedWrite(
    db,
    "UPDATE operator_data_upgrades SET started_at = NULL WHERE id = ?1 AND status = ?2 AND started_at = ?3",
    id,
    status,
    now,
  );
}

/**
 * The batch's outcome: cursor, counter, log entry AND the lease release commit
 * together, after the data move. The log is append-only JSON so the operator
 * keeps the counts of every batch a later reset would otherwise erase; clearing
 * `started_at` is what lets the next step claim again.
 */
const STEP_PROGRESS_SQL = `
  UPDATE operator_data_upgrades
     SET cursor_json = ?2,
         processed = processed + ?3,
         started_at = NULL,
         log_json = CASE WHEN ?4 IS NULL THEN log_json
                         WHEN log_json IS NULL THEN json_array(json(?4))
                         ELSE json_insert(log_json, '$[#]', json(?4)) END
   WHERE id = ?1`;

/** The phases the operator console can run, as the ledger names them. */
type UpgradePhase = "step" | "verify" | "reset";

/**
 * One ledger row per phase that ACTED (a refusal writes none, the rule every
 * console write follows). `platform_audit_events` is the platform-scope ledger:
 * `audit_events` cannot hold this row because its `workspace_id` is NOT NULL and
 * an upgrade is not workspace-scoped (migration 0033).
 */
const UPGRADE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, ?3, 'data_upgrade', ?4, json_object('phase', ?5, 'outcome', ?6), ?7)`;

/** The audit statement for one phase, so it rides the same batch as its write. */
function upgradeAudit(
  db: DashboardD1,
  phase: UpgradePhase,
  actor: string,
  itemId: string,
  outcome: string,
  now: string,
): DashboardD1Statement {
  return db
    .prepare(UPGRADE_AUDIT_SQL)
    .bind(crypto.randomUUID(), actor, `upgrade.${phase}`, itemId, phase, outcome, now);
}

export type UpgradeStepOutcome =
  | { kind: "ok"; state: DataUpgradeState; batch: UpgradeBatch }
  | { kind: "refused"; reason: string; state: DataUpgradeState };

/**
 * Run ONE batch: `pending|running → running`.
 *
 * A downtime item is refused while the window is off, EXCEPT its first step
 * (`pending`), which opens the window itself and records ownership — unless
 * the window was already open, in which case it belongs to the operator and the
 * runner must not close it later.
 *
 * Every refusal is decided BEFORE the claim, so a refused step leaves the row
 * untouched (and never opens a window it would not own); the claim then precedes
 * all planning, so a second concurrent caller observes `upgrade_running`
 * instead of planning the same worklist twice.
 */
export async function stepDataUpgrade(
  db: DashboardD1,
  item: DataUpgradeItem,
  actor: string,
  now: string,
): Promise<UpgradeStepOutcome> {
  const before = await readDataUpgradeState(db, item.id);
  if (before.status !== "pending" && before.status !== "running") {
    return { kind: "refused", reason: `cannot step a ${before.status} upgrade; reset it first`, state: before };
  }
  let opensWindow = false;
  if (item.requiresDowntime) {
    const maintenance = await getMaintenanceMode(db);
    if (!maintenance.enabled) {
      if (before.status !== "pending") {
        return {
          kind: "refused",
          reason: "maintenance mode must be on to step this upgrade",
          state: before,
        };
      }
      opensWindow = true;
    }
  }
  const owned = item.requiresDowntime && (opensWindow || before.maintenanceOwned);
  const claim = await claimUpgrade(db, STEP_CLAIM_SQL, item.id, "running", owned ? 1 : 0, now);
  if (!claim) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if (opensWindow) {
    await setMaintenanceMode(db, { enabled: true, reason: `data upgrade: ${item.title}`, actor }, now);
  }
  const batch = await item.runBatch(db, before.cursor).catch(async (err: unknown) => {
    // The batch is ONE transaction, so a throw moved nothing: release the claim
    // (a hard process death leaves it to expire instead) and surface the real error.
    await releaseClaim(db, item.id);
    throw err;
  });
  await db.batch([
    db
      .prepare(STEP_PROGRESS_SQL)
      .bind(
        item.id,
        JSON.stringify(batch.cursor),
        batch.processed,
        batch.log === undefined ? null : JSON.stringify(batch.log),
      ),
    upgradeAudit(db, "step", actor, item.id, "running", now),
  ]);
  return { kind: "ok", state: await readDataUpgradeState(db, item.id), batch };
}

export type UpgradeVerifyOutcome =
  | { kind: "ok"; state: DataUpgradeState; checks: UpgradeCounts }
  | { kind: "refused"; reason: string; state: DataUpgradeState };

/**
 * Read-only verification: `running|failed|verifying → completed | failed`.
 *
 * Any non-zero BLOCKING check fails the item with `last_error` naming the
 * checks that were not zero; all blocking zero completes it. The item's
 * `advisoryChecks` are reported in `checks` but never fail it — they describe
 * history the item cannot repair.
 * A window the runner opened is closed only now AND only when it owns one — an
 * operator-enabled window stays open until the operator clears it (spec §
 * Invariants).
 *
 * The claim makes verify refuse while another phase is in flight: a verify that
 * interleaved with a step would read data the step is still moving.
 */
export async function verifyDataUpgrade(
  db: DashboardD1,
  item: DataUpgradeItem,
  actor: string,
  now: string,
): Promise<UpgradeVerifyOutcome> {
  const before = await readDataUpgradeState(db, item.id);
  if (!VERIFIABLE_STATUSES.includes(before.status)) {
    return { kind: "refused", reason: `cannot verify a ${before.status} upgrade`, state: before };
  }
  const claimed = await claimUpgrade(
    db,
    VERIFY_CLAIM_SQL,
    item.id,
    "verifying",
    before.maintenanceOwned ? 1 : 0,
    now,
  );
  if (!claimed) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  // A throw is NOT caught: the claim stays and its 5-minute lease expiry is the
  // recovery, so a half-run phase never looks claimable to a later one.
  // The run start is read AFTER the claim: a step that finished between the read
  // above and this claim may have stamped the run, and the boundary the item
  // judges must be the one it holds now.
  const claimedState = await readDataUpgradeState(db, item.id);
  const checks = await item.verify(db, { runStartedAt: claimedState.runStartedAt });
  const advisory = new Set(item.advisoryChecks ?? []);
  const failing = Object.entries(checks).filter(([name, count]) => count !== 0 && !advisory.has(name));
  const status = failing.length > 0 ? "failed" : "completed";
  const lastError =
    failing.length > 0 ? `verify failed: ${failing.map(([name, count]) => `${name}=${count}`).join(", ")}` : null;
  // The claim outlives the status write: cleanup below runs under the same
  // stamp, so a reset cannot claim the row and have its window closed by us.
  if ((await settleVerifyState(db, item.id, status, lastError, now)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  await upgradeAudit(db, "verify", actor, item.id, status, now).run();
  if (before.maintenanceOwned && (await settleUpgradeMaintenance(db, item.id, status, actor, now)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if ((await releaseUpgradeClaim(db, item.id, status, now)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  return { kind: "ok", state: await readDataUpgradeState(db, item.id), checks };
}

/**
 * The reset's state write: `pending` with no cursor, counter, finish or run
 * start — but `started_at` stays, because the window close and ownership clear
 * below run under the same stamp, and only the last step re-opens the row.
 * Clearing `run_started_at` is what makes the next run's retirements its own:
 * with no run start, every deleted target is history.
 */
const RESET_SQL = `
  UPDATE operator_data_upgrades
     SET status = 'pending',
         cursor_json = NULL,
         processed = 0,
         run_started_at = NULL,
         finished_at = NULL,
         last_error = NULL
   WHERE id = ?1 AND started_at = ?2 AND maintenance_owned = ?3`;

export type UpgradeResetOutcome =
  | { kind: "ok"; state: DataUpgradeState }
  | { kind: "refused"; reason: string; state: DataUpgradeState };

/**
 * Return the item to `pending` from ANY state. Migrated rows are never undone —
 * a re-run is a no-op pass over work the worklist already excludes. A window
 * the RUNNER opened is closed here: `reset` clears ownership, so leaving it
 * open would strand a maintenance mode no later step or verify can close. An
 * operator-enabled window stays on. The batch log stays: it is the only
 * evidence of what the batches already discarded, and it describes work reset
 * cannot undo.
 */
export async function resetDataUpgrade(
  db: DashboardD1,
  item: DataUpgradeItem,
  actor: string,
  now: string,
): Promise<UpgradeResetOutcome> {
  const before = await readDataUpgradeState(db, item.id);
  // The claim keeps a reset from clearing the row a step or verify is writing.
  // The bind states the row as it already is, so a refused or failed reset
  // leaves the status where it was.
  const claimed = await claimUpgrade(
    db,
    RESET_CLAIM_SQL,
    item.id,
    before.status,
    before.maintenanceOwned ? 1 : 0,
    now,
  );
  if (!claimed) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  // State first, window second: a reset that died between the two leaves the
  // row `pending` still holding its claim and ownership, which the next claim's
  // stale window adopts and its own cleanup closes. A throw is NOT caught here:
  // the claim stays and its lease expires, so no half-cleaned row is claimable.
  if ((await guardedWrite(db, RESET_SQL, item.id, now, before.maintenanceOwned ? 1 : 0)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  await upgradeAudit(db, "reset", actor, item.id, "pending", now).run();
  if (before.maintenanceOwned && (await settleUpgradeMaintenance(db, item.id, "pending", actor, now)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if ((await releaseUpgradeClaim(db, item.id, "pending", now)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  return { kind: "ok", state: await readDataUpgradeState(db, item.id) };
}
