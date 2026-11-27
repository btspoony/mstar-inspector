import { getMaintenanceMode, setMaintenanceMode } from "../dashboard/runtime-config-store";
import type { DashboardD1, DashboardD1Statement } from "../dashboard/users";
import { ledgerTargetAlignment } from "./data-upgrades/ledger-target-alignment";
import { orphanLedgerAttribution } from "./data-upgrades/orphan-ledger-attribution";
import { repoBackfill } from "./data-upgrades/repo-backfill";
import { repoIdClaim } from "./data-upgrades/repo-id-claim";
import { orphanLedgerAttributionBot } from "./data-upgrades/usage-bot-attribution";
import { splitIntegrity } from "./data-upgrades/split-integrity";


/** Where an item resumes. Opaque to the runner; the item owns its shape. */
export type UpgradeCursor = Record<string, unknown>;

/** What asking GitHub for a repository's numeric id answered. */
export type RepoLookupOutcome =
  | { kind: "found"; repoId: number }
  | { kind: "absent" }
  | { kind: "failed" };

/** One installation's repository lookup; the caller caches per installation, not per group. */
export type RepoLookup = (
  botId: string,
  installationId: number,
  owner: string,
  repo: string,
) => Promise<RepoLookupOutcome>;

/**
 * What a running step knows that an item does not: the GitHub face a batch may
 * ask. Omitted (tests, a deployment with no key), an item that binds `repo_id`
 * reports the affected groups instead of calling.
 */
export type UpgradeRunContext = { repoLookup?: RepoLookup };

/** Counts an item reports. `verify` fails on any NON-ZERO entry. */
export type UpgradeCounts = Record<string, number>;

/** What one batch did: the resume point, the rows it moved, and whether it finished. */
export type UpgradeBatch = {
  cursor: UpgradeCursor | null;
  processed: number;
  done: boolean;
  log?: UpgradeCursor;
};

/**
 * One registered upgrade. Frozen contract (spec § Upgrade registry and state
 * machine): `preflight` and `verify` are read-only, `runBatch` performs ONE
 * transaction and is replayable.
 */
export type DataUpgradeItem = {
  id: string;
  title: string;
  impact: string;
  requiresDowntime: boolean;
  order: number;
  preflight(db: DashboardD1): Promise<UpgradeCounts>;
  runBatch(
    db: DashboardD1,
    cursor: UpgradeCursor | null,
    actor?: string,
    context?: UpgradeRunContext,
  ): Promise<UpgradeBatch>;
  advisoryChecks?: readonly string[];
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
  maintenanceOwned: boolean;
  startedAt: string | null;
  runStartedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  log: UpgradeCursor[];
};

/**
 * Every registered upgrade, in run order — the registry's single source.
 * `repo-backfill` is the historical-identity item, and
 * `orphan-ledger-attribution` follows it: it gives rows written before
 * `review_targets` existed the target its `(owner, repo)` group resolves to,
 * which the backfill cannot see. The
 * runner, the table and the routes are item-agnostic, so registering an item
 * is the only change a new upgrade needs.
 */
export const DATA_UPGRADES: DataUpgradeItem[] = [
  repoBackfill,
  orphanLedgerAttribution,
  ledgerTargetAlignment,
  repoIdClaim,
  orphanLedgerAttributionBot,
  splitIntegrity,
];

/** Resolve a registered item; `null` is the route layer's 404. */
export function findDataUpgrade(id: string): DataUpgradeItem | null {
  return DATA_UPGRADES.find((item) => item.id === id) ?? null;
}

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
  impact: string;
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
        impact: item.impact,
        requiresDowntime: item.requiresDowntime,
        order: item.order,
        state: stored.get(item.id) ?? pendingState(item.id),
        preflight: await item.preflight(db),
      })),
  );
}

const CLAIM_RELEASE_SQL = `
  UPDATE operator_data_upgrades
     SET started_at = NULL, claim_token = NULL
   WHERE id = ?1 AND claim_token = ?2 AND started_at = ?3`;

async function releaseClaim(db: DashboardD1, id: string, now: string, token: string): Promise<void> {
  await db.prepare(CLAIM_RELEASE_SQL).bind(id, token, now).run().catch(() => {});
}

const CLAIM_LEASE_MS = 5 * 60_000;

function claimSql(allowed: readonly DataUpgradeStatus[], stampsRunStart: boolean): string {
  const list = allowed.map((status) => `'${status}'`).join(", ");
  const runColumn = stampsRunStart ? ", run_started_at" : "";
  const runValue = stampsRunStart ? ", ?4" : "";
  const runSet = stampsRunStart
    ? ",\n    run_started_at = COALESCE(operator_data_upgrades.run_started_at, ?4)"
    : "";
  return `
  INSERT INTO operator_data_upgrades (id, status, maintenance_owned, started_at, claim_token${runColumn})
  VALUES (?1, ?2, ?3, ?4, ?6${runValue})
  ON CONFLICT (id) DO UPDATE SET
    status = ?2,
    maintenance_owned = ?3,
    started_at = ?4,
    claim_token = ?6${runSet}
  WHERE operator_data_upgrades.status IN (${list})
    AND (operator_data_upgrades.started_at IS NULL
         OR operator_data_upgrades.started_at < ?5)`;
}

const VERIFIABLE_STATUSES: readonly DataUpgradeStatus[] = ["running", "verifying", "failed"];

const STEP_CLAIM_SQL = claimSql(["pending", "running"], true);
const VERIFY_CLAIM_SQL = claimSql(VERIFIABLE_STATUSES, false);
const RESET_CLAIM_SQL = claimSql(["pending", "running", "verifying", "completed", "failed"], false);

async function claimUpgrade(
  db: DashboardD1,
  sql: string,
  id: string,
  status: DataUpgradeStatus,
  maintenanceOwned: 0 | 1,
  now: string,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const claim = await db
    .prepare(sql)
    .bind(
      id,
      status,
      maintenanceOwned,
      now,
      new Date(Date.parse(now) - CLAIM_LEASE_MS).toISOString(),
      token,
    )
    .run();
  return claim.meta.changes === 0 ? null : token;
}

type ClaimStep = "ok" | "refused";

async function guardedWrite(db: DashboardD1, sql: string, ...binds: unknown[]): Promise<ClaimStep> {
  const result = await db.prepare(sql).bind(...binds).run();
  return result.meta.changes === 0 ? "refused" : "ok";
}

/**
 * Step 1 of a verify: settle the status while OUR claim (token) still guards the
 * row. `started_at` stays set — the claim is released by step 3, so no later
 * phase can claim the row while this one still has maintenance side effects to
 * run. `finished_at` is written only on completion: a failed item never finished.
 */
export async function settleVerifyState(
  db: DashboardD1,
  id: string,
  status: "completed" | "failed",
  lastError: string | null,
  now: string,
  token: string,
): Promise<ClaimStep> {
  return status === "completed"
    ? guardedWrite(
        db,
        `UPDATE operator_data_upgrades
            SET status = 'completed', finished_at = ?2, last_error = NULL
          WHERE id = ?1 AND status = 'verifying' AND started_at = ?3 AND claim_token = ?4`,
        id,
        now,
        now,
        token,
      )
    : guardedWrite(
        db,
        `UPDATE operator_data_upgrades
            SET status = 'failed', last_error = ?2
          WHERE id = ?1 AND status = 'verifying' AND started_at = ?3 AND claim_token = ?4`,
        id,
        lastError,
        now,
        token,
      );
}

const MAINTENANCE_RELEASE_SQL = `
  UPDATE operator_data_upgrades
     SET maintenance_owned = 0
   WHERE id = ?1 AND claim_token = ?2 AND started_at = ?3 AND maintenance_owned = 1`;

const MAINTENANCE_CLOSE_GUARD = `
  EXISTS (SELECT 1 FROM operator_data_upgrades
           WHERE id = ?1 AND claim_token = ?2 AND maintenance_owned = 0)
  AND EXISTS (SELECT 1 FROM review_runtime_settings
               WHERE key = 'platform.maintenance.enabled' AND value = '1')`;

const MAINTENANCE_CLOSE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?3, ?4, 'platform.maintenance.set', 'runtime', 'platform.maintenance',
         json_object('before', json_object(
                     'enabled', json(CASE WHEN (SELECT value FROM review_runtime_settings
                                                 WHERE key = 'platform.maintenance.enabled') = '1'
                                         THEN 'true' ELSE 'false' END),
                     'reason', (SELECT value FROM review_runtime_settings
                                 WHERE key = 'platform.maintenance.reason'),
                     'since', (SELECT value FROM review_runtime_settings
                                WHERE key = 'platform.maintenance.since')),
                     'after', json_object('enabled', json('false'), 'reason', NULL, 'since', NULL)),
         ?5
   WHERE ${MAINTENANCE_CLOSE_GUARD}`;

const MAINTENANCE_CLOSE_FLAG_SQL = `
  UPDATE review_runtime_settings
     SET value = '0', updated_at = ?3, updated_by = ?4
   WHERE key = 'platform.maintenance.enabled' AND ${MAINTENANCE_CLOSE_GUARD}`;

const MAINTENANCE_CLOSE_WINDOW_SQL = `
  DELETE FROM review_runtime_settings
   WHERE key = ?3 AND ${MAINTENANCE_CLOSE_GUARD}`;

/**
 * Step 2: close the window this claim owns and drop its ownership flag in ONE
 * batch, so a claim taken over between the read and the write cannot have its
 * window closed by a phase that no longer holds the row. The flag write comes
 * first and every window statement is guarded by it, so a takeover makes the
 * whole close a no-op instead of a stale side effect. An operator-closed window
 * is left alone: re-stating "off" would append an audit row for a change
 * nobody made.
 *
 * The guard is the TOKEN, not the stamp: a replacement claim can carry the same
 * `started_at` (the runner stamps phases from the request clock), and only its
 * token proves which claim holds the row. A row we no longer hold (or whose
 * status moved) is `refused` with no side effect at all; a row we hold that no
 * longer owns the window has nothing to close and is `ok`, so the caller still
 * releases the claim.
 */
export async function settleUpgradeMaintenance(
  db: DashboardD1,
  id: string,
  status: DataUpgradeStatus,
  actor: string,
  now: string,
  token: string,
): Promise<ClaimStep> {
  const row = await db
    .prepare("SELECT status, maintenance_owned, started_at, claim_token FROM operator_data_upgrades WHERE id = ?1")
    .bind(id)
    .first<{ status: string; maintenance_owned: number; started_at: string | null; claim_token: string | null }>();
  if (row === null || row.started_at !== now || row.claim_token !== token || row.status !== status) {
    return "refused";
  }
  if (row.maintenance_owned !== 1) {
    return "ok";
  }
  const released = (await db.batch([
    db.prepare(MAINTENANCE_RELEASE_SQL).bind(id, token, now),
    db.prepare(MAINTENANCE_CLOSE_AUDIT_SQL).bind(id, token, crypto.randomUUID(), actor, now),
    db.prepare(MAINTENANCE_CLOSE_WINDOW_SQL).bind(id, token, "platform.maintenance.since"),
    db.prepare(MAINTENANCE_CLOSE_WINDOW_SQL).bind(id, token, "platform.maintenance.reason"),
    db.prepare(MAINTENANCE_CLOSE_FLAG_SQL).bind(id, token, now, actor),
  ]))[0];
  return released === undefined || released.meta.changes === 0 ? "refused" : "ok";
}

/**
 * Last step of every phase: clearing the claim is what re-opens the row to
 * another phase. Both columns go, so no stale token outlives its claim.
 */
export async function releaseUpgradeClaim(
  db: DashboardD1,
  id: string,
  status: DataUpgradeStatus,
  now: string,
  token: string,
): Promise<ClaimStep> {
  return guardedWrite(
    db,
    `UPDATE operator_data_upgrades
        SET started_at = NULL, claim_token = NULL
      WHERE id = ?1 AND status = ?2 AND started_at = ?3 AND claim_token = ?4`,
    id,
    status,
    now,
    token,
  );
}

const STEP_PROGRESS_SQL = `
  UPDATE operator_data_upgrades
     SET cursor_json = ?2,
         processed = processed + ?3,
         started_at = NULL,
         claim_token = NULL,
         log_json = CASE WHEN ?4 IS NULL THEN log_json
                         WHEN log_json IS NULL THEN json_array(json(?4))
                         ELSE json_insert(log_json, '$[#]', json(?4)) END
   WHERE id = ?1 AND status = 'running' AND claim_token = ?5`;

type UpgradePhase = "step" | "verify" | "reset";

const UPGRADE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, ?3, 'data_upgrade', ?4, json_object('phase', ?5, 'outcome', ?6), ?7)`;

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
  context?: UpgradeRunContext,
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
  const token = await claimUpgrade(db, STEP_CLAIM_SQL, item.id, "running", owned ? 1 : 0, now);
  if (token === null) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if (opensWindow) {
    await setMaintenanceMode(db, { enabled: true, reason: `data upgrade: ${item.title}`, actor }, now);
  }
  const batch = await item.runBatch(db, before.cursor, actor, context).catch(async (err: unknown) => {
    await releaseClaim(db, item.id, now, token);
    throw err;
  });
  const progressed = await guardedWrite(
    db,
    STEP_PROGRESS_SQL,
    item.id,
    JSON.stringify(batch.cursor),
    batch.processed,
    batch.log === undefined ? null : JSON.stringify(batch.log),
    token,
  );
  if (progressed === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  await upgradeAudit(db, "step", actor, item.id, "running", now).run();
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
  const token = await claimUpgrade(
    db,
    VERIFY_CLAIM_SQL,
    item.id,
    "verifying",
    before.maintenanceOwned ? 1 : 0,
    now,
  );
  if (token === null) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  const claimedState = await readDataUpgradeState(db, item.id);
  const checks = await item.verify(db, { runStartedAt: claimedState.runStartedAt });
  const advisory = new Set(item.advisoryChecks ?? []);
  const failing = Object.entries(checks).filter(([name, count]) => count !== 0 && !advisory.has(name));
  const status = failing.length > 0 ? "failed" : "completed";
  const lastError =
    failing.length > 0 ? `verify failed: ${failing.map(([name, count]) => `${name}=${count}`).join(", ")}` : null;
  if ((await settleVerifyState(db, item.id, status, lastError, now, token)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  await upgradeAudit(db, "verify", actor, item.id, status, now).run();
  if (
    before.maintenanceOwned &&
    (await settleUpgradeMaintenance(db, item.id, status, actor, now, token)) === "refused"
  ) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if ((await releaseUpgradeClaim(db, item.id, status, now, token)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  return { kind: "ok", state: await readDataUpgradeState(db, item.id), checks };
}

const RESET_SQL = `
  UPDATE operator_data_upgrades
     SET status = 'pending',
         cursor_json = NULL,
         processed = 0,
         finished_at = NULL,
         last_error = NULL
   WHERE id = ?1 AND claim_token = ?2 AND maintenance_owned = ?3`;

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
  const token = await claimUpgrade(
    db,
    RESET_CLAIM_SQL,
    item.id,
    before.status,
    before.maintenanceOwned ? 1 : 0,
    now,
  );
  if (token === null) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if ((await guardedWrite(db, RESET_SQL, item.id, token, before.maintenanceOwned ? 1 : 0)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  await upgradeAudit(db, "reset", actor, item.id, "pending", now).run();
  if (
    before.maintenanceOwned &&
    (await settleUpgradeMaintenance(db, item.id, "pending", actor, now, token)) === "refused"
  ) {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  if ((await releaseUpgradeClaim(db, item.id, "pending", now, token)) === "refused") {
    return { kind: "refused", reason: "upgrade_running", state: await readDataUpgradeState(db, item.id) };
  }
  return { kind: "ok", state: await readDataUpgradeState(db, item.id) };
}
