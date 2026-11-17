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
import type { DashboardD1 } from "../dashboard/users";

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
  /** Read-only checks; every entry must read `0` for the item to complete. */
  verify(db: DashboardD1): Promise<UpgradeCounts>;
};

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
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** One entry per batch: what it moved and what it discarded. */
  log: UpgradeCursor[];
};

/**
 * Every registered upgrade, in run order — the registry's single source. Empty
 * until the repository backfill item ships (plan 373 task 3): the runner, the
 * table and the routes are item-agnostic, so registering an item is the only
 * change a new upgrade needs.
 */
export const DATA_UPGRADES: DataUpgradeItem[] = [];

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
  finished_at: string | null;
  last_error: string | null;
  log_json: string | null;
};

const STATE_COLUMNS =
  "id, status, cursor_json, processed, maintenance_owned, started_at, finished_at, last_error, log_json";

/** An absent row is the documented `pending` state — nothing was ever started. */
function pendingState(id: string): DataUpgradeState {
  return {
    id,
    status: "pending",
    cursor: null,
    processed: 0,
    maintenanceOwned: false,
    startedAt: null,
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

/**
 * Record the item as STARTED before its first batch runs: `started_at` is the
 * honest start, and `maintenance_owned` survives a batch that throws (so a
 * window the runner opened is still closed after a later successful verify).
 */
const STEP_BEGIN_SQL = `
  INSERT INTO operator_data_upgrades (id, status, maintenance_owned, started_at)
  VALUES (?1, 'running', ?2, ?3)
  ON CONFLICT (id) DO UPDATE SET
    status = 'running',
    maintenance_owned = ?2,
    started_at = COALESCE(operator_data_upgrades.started_at, ?3)`;

/**
 * The batch's outcome: cursor, counter and log entry commit together, after the
 * data move. The log is append-only JSON so the operator keeps the counts of
 * every batch a later reset would otherwise erase.
 */
const STEP_PROGRESS_SQL = `
  UPDATE operator_data_upgrades
     SET cursor_json = ?2,
         processed = processed + ?3,
         log_json = CASE WHEN ?4 IS NULL THEN log_json
                         WHEN log_json IS NULL THEN json_array(json(?4))
                         ELSE json_insert(log_json, '$[#]', json(?4)) END
   WHERE id = ?1`;

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
  let claimed = false;
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
      await setMaintenanceMode(db, { enabled: true, reason: `data upgrade: ${item.title}`, actor }, now);
      claimed = true;
    }
  }
  const owned = item.requiresDowntime && (claimed || before.maintenanceOwned);
  await db.prepare(STEP_BEGIN_SQL).bind(item.id, owned ? 1 : 0, now).run();
  const batch = await item.runBatch(db, before.cursor);
  await db
    .prepare(STEP_PROGRESS_SQL)
    .bind(
      item.id,
      JSON.stringify(batch.cursor),
      batch.processed,
      batch.log === undefined ? null : JSON.stringify(batch.log),
    )
    .run();
  return { kind: "ok", state: await readDataUpgradeState(db, item.id), batch };
}

/** `verifying` is included so a verify interrupted mid-flight can be retried. */
const VERIFIABLE: readonly DataUpgradeStatus[] = ["running", "verifying", "failed"];

export type UpgradeVerifyOutcome =
  | { kind: "ok"; state: DataUpgradeState; checks: UpgradeCounts }
  | { kind: "refused"; reason: string; state: DataUpgradeState };

/**
 * Read-only verification: `running|failed|verifying → completed | failed`.
 *
 * Any non-zero check fails the item with `last_error` naming the checks that
 * were not zero; all zero completes it. A window the runner opened is closed
 * only now AND only when it owns one — an operator-enabled window stays open
 * until the operator clears it (spec § Invariants).
 */
export async function verifyDataUpgrade(
  db: DashboardD1,
  item: DataUpgradeItem,
  actor: string,
  now: string,
): Promise<UpgradeVerifyOutcome> {
  const before = await readDataUpgradeState(db, item.id);
  if (!VERIFIABLE.includes(before.status)) {
    return { kind: "refused", reason: `cannot verify a ${before.status} upgrade`, state: before };
  }
  await db
    .prepare("UPDATE operator_data_upgrades SET status = 'verifying' WHERE id = ?1")
    .bind(item.id)
    .run();
  const checks = await item.verify(db);
  const failing = Object.entries(checks).filter(([, count]) => count !== 0);
  if (failing.length > 0) {
    const lastError = `verify failed: ${failing.map(([name, count]) => `${name}=${count}`).join(", ")}`;
    await db
      .prepare("UPDATE operator_data_upgrades SET status = 'failed', last_error = ?2 WHERE id = ?1")
      .bind(item.id, lastError)
      .run();
    return { kind: "ok", state: await readDataUpgradeState(db, item.id), checks };
  }
  await db
    .prepare(
      "UPDATE operator_data_upgrades SET status = 'completed', finished_at = ?2, last_error = NULL WHERE id = ?1",
    )
    .bind(item.id, now)
    .run();
  if (before.maintenanceOwned) {
    // A window the operator already closed is left alone: re-stating "off"
    // would append an audit row for a change nobody made.
    if ((await getMaintenanceMode(db)).enabled) {
      await setMaintenanceMode(db, { enabled: false, actor }, now);
    }
    await db
      .prepare("UPDATE operator_data_upgrades SET maintenance_owned = 0 WHERE id = ?1")
      .bind(item.id)
      .run();
  }
  return { kind: "ok", state: await readDataUpgradeState(db, item.id), checks };
}

/**
 * Return the item to `pending` from ANY state. Migrated rows are never undone —
 * a re-run is a no-op pass over work the worklist already excludes — and the
 * maintenance window is left exactly as it is: reset never closes it. The batch
 * log stays: it is the only evidence of what the batches already discarded, and
 * it describes work reset cannot undo.
 */
const RESET_SQL = `
  UPDATE operator_data_upgrades
     SET status = 'pending',
         cursor_json = NULL,
         processed = 0,
         maintenance_owned = 0,
         started_at = NULL,
         finished_at = NULL,
         last_error = NULL
   WHERE id = ?1`;

export async function resetDataUpgrade(
  db: DashboardD1,
  item: DataUpgradeItem,
): Promise<DataUpgradeState> {
  await db.prepare(RESET_SQL).bind(item.id).run();
  return readDataUpgradeState(db, item.id);
}
