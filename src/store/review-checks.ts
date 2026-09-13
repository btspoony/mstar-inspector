/**
 * Review Check attempt registry (plan 68 Task 1, spec review-lifecycle §7.1
 * second block + §7.9). One row per Check ATTEMPT; this module is the only
 * place attempt identity, lease fencing and the desired/observed split live.
 *
 * Identity (spec §7.9): `attempt_key` is the canonical JSON array of the
 * authenticated scope plus head SHA, triggeredBy and action. A fresh attempt on
 * the same key is a new GENERATION with a fresh UUID and a fresh
 * `external_id = mstar-check:v1:<uuid>:<gen>`; generations, external ids and
 * once-attached remote run ids are never recycled or cleared.
 *
 * Claim protocol (spec §7.9): ONE serialized `db.batch` inserts the next
 * generation only when no NONTERMINAL row exists for the key. The partial
 * unique index `idx_check_one_open` (migration 0021) is what actually
 * serialises concurrent claims — `(attempt_key, generation)` alone cannot,
 * because two racers each compute a different MAX+1. A racer whose insert is
 * rejected by that index REREADS the active row and returns `busy`, never its
 * own generation. The batch is a LOCAL fence, not external exactly-once (RL-12).
 *
 * Fencing (spec §7.9/§7.0): the claim INSERT carries holder, `lease_epoch = 1`
 * and `lease_until_ms` equal to the immutable execution deadline, so no
 * unowned row ever exists. Every later mutation is a conditional statement
 * requiring `(id, holder, lease_epoch, lease_until_ms)` — the exact lease
 * triple it was handed — and reports true only on `meta.changes === 1`; false
 * means the lease was lost, taken over, or the row already ended, and nothing
 * was written. Because every lease change increments the epoch, matching the
 * triple implies the caller's lease is still the live one; an optional
 * transaction clock additionally enforces `lease_until_ms > nowMs`. Recovery
 * reacquires an EXPIRED or released lease with a single epoch-incrementing
 * UPDATE and never takes a live one. The recovery lease (120s) never moves
 * `execution_deadline_ms`, and expiry always means the execution deadline.
 *
 * Desired versus observed: `setCheckDesired` freezes the terminal intent
 * (conclusion, bounded title/summary, publication proof link) BEFORE any remote
 * update, and is monotonic except for the one documented correction;
 * `recordCheckObservation` advances `observed` only from a remote payload whose
 * persisted identity already matches. An `unavailable` outcome flows through
 * `deferCheckRecovery`, which touches recovery status/error/backoff only —
 * never `desired`, never `observed`.
 *
 * Storage layer: no `src/pipeline/**` or `src/worker/**` imports, no GitHub
 * call, no clock of its own (one supplied `nowMs` per transaction, §7.0).
 */

import type { Scope } from "../contracts/recheck";
import type { Lease } from "./finding-lifecycle";
import type { D1Like, ReviewCheckRow } from "./types";

/** The authenticated routing scope (spec §7.0) — same vocabulary as the store. */
export type { Scope } from "../contracts/recheck";
export type { Lease, PublicationProof } from "./finding-lifecycle";

// ---------------------------------------------------------------------------
// §7.9 domain shapes (single CODE copy; spec §7.9 is the normative copy)
// ---------------------------------------------------------------------------

export type CheckDesired = "in_progress" | "success" | "neutral" | "failure";
export type CheckObserved = "unknown" | CheckDesired;
export type CheckCreateState = "not-sent" | "sending" | "known" | "unknown";
export type CheckRecoveryState = "pending" | "done" | "remote-unconfirmed" | "local-error" | "suspended";

/** The immutable identity of one attempt generation (spec §7.9). */
export type CheckIdentity = {
  attemptId: string;
  generation: number;
  externalId: string;
  scope: Scope;
  githubAppId: number;
  headSha: string;
};

/** The registry row in domain shape (spec §7.9). */
export type CheckAttempt = {
  identity: CheckIdentity;
  lease: Lease | null;
  checkRunId: number | null;
  createState: CheckCreateState;
  desired: CheckDesired;
  observed: CheckObserved;
  recoveryState: CheckRecoveryState;
  executionDeadlineMs: number;
  attempts: number;
  terminalMs: number | null;
};

/** The remote facts an adapter read from GitHub (spec §7.9) — evidence, not opinion. */
export type CheckRemote = {
  id: number;
  name: string;
  head_sha: string;
  external_id: string | null;
  app: { id: number } | null;
  status: string;
  conclusion: string | null;
};

/** A terminal intent: `in_progress` is structurally excluded (spec §7.11.2). */
export type CheckConclusion = {
  desired: Exclude<CheckDesired, "in_progress">;
  title: string;
  summary: string;
};

/** The §7.9 claim outcome union. */
export type ClaimAttemptResult =
  | { kind: "claimed"; attempt: CheckAttempt; lease: Lease }
  | { kind: "busy" | "terminal"; attempt: CheckAttempt };

/**
 * The transaction clock (spec §7.0). Every §7.9/§7.11.2 signature the contract
 * pins WITHOUT a clock argument fences on the exact lease triple; passing
 * `nowMs` additionally enforces `lease_until_ms > nowMs` and stamps
 * `updated_ms`. Callers that already hold a transaction clock pass it.
 */
export type CheckClock = number;

// ---------------------------------------------------------------------------
// Constants (spec §7.9 / §7.11.2)
// ---------------------------------------------------------------------------

/** GitHub run name (spec §7.9: exactly this string; never per-attempt unique). */
export const CHECK_NAME = "mstar-inspector review";
/** Immutability anchor for `external_id` (spec §7.9's `mstar-check:v1:` prefix). */
export const CHECK_EXTERNAL_ID_PREFIX = "mstar-check:v1:";
/** Claim lease == immutable execution deadline (spec §7.9: claim time + 900,000ms). */
export const CHECK_LEASE_MS = 900_000;
/** Recovery lease (spec §7.9: "Recovery lease is 120,000ms"). */
export const CHECK_RECOVERY_LEASE_MS = 120_000;
/** Recovery attempt cap (spec §7.11.2: maxAttempts = 5). */
export const CHECK_MAX_ATTEMPTS = 5;
/** Reconcile batch size (spec §7.11.2: limit = 25). */
export const CHECK_RECONCILE_LIMIT = 25;
/**
 * Backoff after the Nth failed recovery attempt (spec §7.11.1's ladder, which
 * §7.11.2's bounded Check recovery inherits); indexed by `attempts - 1`.
 */
export const CHECK_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000];
/** Durable reason cap (spec §7.9: "error ≤300"). */
export const CHECK_ERROR_MAX_CHARS = 300;
/** Frozen summary cap (spec §7.9: "summary ≤2000 chars"). */
export const CHECK_SUMMARY_MAX_CHARS = 2_000;

/** Canonical lowercase UUID syntax — the only Worker-generated ids (spec §7.0). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A nonterminal attempt is one that has not locally completed or given up. */
const NONTERMINAL_WHERE = "terminal_ms IS NULL";

// ---------------------------------------------------------------------------
// Identity helpers (spec §7.9)
// ---------------------------------------------------------------------------

/**
 * Canonical `attempt_key`: `JSON.stringify` of the flat attempt tuple in the
 * fixed spec order (plan 68 §T1 pins this shape — callers pass the scope
 * fields directly, never a nested `Scope`). Owner/repo arrive canonicalised
 * from authenticated repository metadata (§7.0) — never from model text, and
 * never re-cased here, so a case-mismatched scope fails closed as a different
 * key.
 */
export function attemptKey(input: {
  appId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  triggeredBy: string;
  action: string;
}): string {
  return JSON.stringify([
    input.appId,
    input.installationId,
    input.owner,
    input.repo,
    input.prNumber,
    input.headSha,
    input.triggeredBy,
    input.action,
  ]);
}

/** The `MAX(generation)+1` subquery for a key (bound once per use). */
const NEXT_GENERATION_SQL = `(SELECT COALESCE(MAX(generation), 0) + 1 FROM review_checks m WHERE m.attempt_key = ?)`;

/**
 * The SQL spelling of `externalIdFor` for the row being inserted, so the
 * immutable handle is stamped by the SAME statement as the insert and no
 * untagged window opens between claim and reread. The generation subquery is
 * evaluated twice inside one statement, so both see the identical MAX+1.
 * Bound values in order: attempt id, then the attempt key.
 */
const EXTERNAL_ID_SQL =
  `'${CHECK_EXTERNAL_ID_PREFIX}' || ? || ':' || (SELECT COALESCE(MAX(generation), 0) + 1 FROM review_checks x WHERE x.attempt_key = ?)`;

/**
 * The immutable correlation handle: `mstar-check:v1:<uuid>:<gen>` (spec §7.9).
 * Rejects a non-canonical attempt id or a non-positive generation rather than
 * minting a handle adoption could never match. The claim INSERT computes the
 * same string in SQL (`EXTERNAL_ID_SQL`); a test pins the two spellings against
 * each other so the pair cannot drift.
 */
export function externalIdFor(attemptId: string, generation: number): string {
  if (!UUID_RE.test(attemptId)) {
    throw new Error("review-checks: attemptId must be a canonical lowercase UUID (Worker-generated, spec §7.0)");
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`review-checks: generation must be a positive integer, got ${String(generation)}`);
  }
  return `${CHECK_EXTERNAL_ID_PREFIX}${attemptId}:${generation}`;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function attemptOf(row: ReviewCheckRow): CheckAttempt {
  return {
    identity: {
      attemptId: row.id,
      generation: row.generation,
      externalId: row.external_id,
      scope: {
        appId: row.app_id,
        installationId: row.installation_id,
        owner: row.owner,
        repo: row.repo,
        prNumber: row.pr_number,
      },
      githubAppId: row.github_app_id,
      headSha: row.head_sha,
    },
    lease: row.holder === null || row.lease_until_ms === null
      ? null
      : { holder: row.holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms },
    checkRunId: row.check_run_id,
    createState: row.create_state as CheckCreateState,
    desired: row.desired as CheckDesired,
    observed: row.observed as CheckObserved,
    recoveryState: row.recovery_state as CheckRecoveryState,
    executionDeadlineMs: row.execution_deadline_ms,
    attempts: row.attempts,
    terminalMs: row.terminal_ms,
  };
}

/** Bound a durable reason (spec §7.9: error ≤300). Never payload content. */
export function checkReason(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return flat.length <= CHECK_ERROR_MAX_CHARS ? flat : flat.slice(0, CHECK_ERROR_MAX_CHARS);
}

/**
 * The one fenced-mutation executor behind every post-claim write: the exact
 * lease triple from the caller's `Lease`, plus `terminal_ms IS NULL` so
 * finished history is never rewritten. An optional transaction clock adds the
 * §7.9 `lease_until_ms > now` condition and stamps `updated_ms`.
 *
 * `meta.changes === 1` is the ONLY success signal; false means the lease was
 * lost, someone else took over (epoch moved), or the row is terminal — and the
 * statement wrote nothing.
 */
async function runFenced(
  db: D1Like,
  id: string,
  lease: Lease,
  sets: string,
  values: unknown[],
  nowMs?: CheckClock,
): Promise<boolean> {
  const clocked = nowMs !== undefined;
  // A clocked write ALSO proves the lease is still live: `lease_until_ms` is
  // bound twice — once as the exact triple match, once as the `> now`
  // liveness test — so an expired-but-not-yet-reassigned lease cannot write.
  const sql =
    `UPDATE review_checks SET ${clocked ? "updated_ms = ?, " : ""}${sets} ` +
    `WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?` +
    `${clocked ? " AND lease_until_ms > ?" : ""} AND ${NONTERMINAL_WHERE}`;
  const bound = [
    ...(clocked ? [nowMs] : []),
    ...values,
    id,
    lease.holder,
    lease.epoch,
    lease.untilMs,
    ...(clocked ? [nowMs] : []),
  ];
  const result = await db.prepare(sql).bind(...bound).run();
  return result.meta.changes === 1;
}

/**
 * The persisted ownership + frozen intent a remote send must agree with
 * (spec §7.9: an adapter "never mutates a caller-supplied run without its
 * persisted ownership record"). Named so consumers import the contract instead
 * of reconstructing it from the reader's signature.
 */
export type CheckOwnership = {
  identity: CheckIdentity;
  checkRunId: number | null;
  createState: CheckCreateState;
  desired: CheckDesired;
  observed: CheckObserved;
  desiredTitle: string | null;
  desiredSummary: string | null;
  publicationId: string | null;
};

/** Null when the row is gone, the fence is not the caller's live lease, or the attempt already ended. */
export async function getCheckOwnership(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs?: CheckClock,
): Promise<CheckOwnership | null> {
  const clocked = nowMs !== undefined;
  const row = await db
    .prepare(
      `SELECT * FROM review_checks
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?` +
        `${clocked ? " AND lease_until_ms > ?" : ""} AND ${NONTERMINAL_WHERE}`,
    )
    .bind(id, lease.holder, lease.epoch, lease.untilMs, ...(clocked ? [nowMs] : []))
    .first<ReviewCheckRow>();
  if (row === null) return null;
  const attempt = attemptOf(row);
  return {
    identity: attempt.identity,
    checkRunId: row.check_run_id,
    createState: attempt.createState,
    desired: attempt.desired,
    observed: attempt.observed,
    desiredTitle: row.desired_title,
    desiredSummary: row.desired_summary,
    publicationId: row.publication_id,
  };
}

// ---------------------------------------------------------------------------
// Claim (spec §7.9)
// ---------------------------------------------------------------------------

/**
 * Fenced attempt claim. In ONE serialized batch, insert the next generation
 * only when no nonterminal row exists for `attempt_key` AND no generation of
 * that key already ENDED with a proven publication, carrying holder +
 * `lease_epoch = 1` + `lease_until_ms = execution_deadline_ms`, then read the
 * result back.
 *
 * Outcomes (spec §7.9):
 *   - `claimed`  — this holder owns the live lease on a fresh generation.
 *   - `busy`     — a NONTERMINAL attempt exists, whatever its generation. An
 *                  expired one still belongs to recovery, never to a concurrent
 *                  paid-review claim, so expiry never turns busy into claimed.
 *   - `terminal` — a generation for this key already ended WITH a proven
 *                  publication (observed success/neutral): the dedup answer,
 *                  and no second Check is created for the same head.
 *
 * A generation that ended WITHOUT a proven publication (observed failure or
 * unknown) is legitimately retryable: the next claim inserts generation N+1
 * with a fresh UUID and external id (spec §7.9's queue-retry rule). Terminal
 * history is never rewritten, and a losing concurrent insert REREADS the
 * active row rather than assuming its own MAX+1.
 *
 * Honesty bound (RL-12): the partial unique index serialises LOCAL claims. It
 * says nothing about GitHub create idempotency — `external_id` is correlation,
 * not a server-side idempotency key.
 */
export async function claimAttempt(
  db: D1Like,
  input: {
    scope: Scope;
    githubAppId: number;
    headSha: string;
    triggeredBy: string;
    action: string;
    holder: string;
    nowMs: number;
    executionDeadlineMs: number;
  },
): Promise<ClaimAttemptResult> {
  if (input.holder.length === 0) {
    throw new Error("review-checks: claim requires a nonblank holder identity");
  }
  const { nowMs, scope } = input;
  if (input.executionDeadlineMs <= nowMs) {
    throw new Error("review-checks: execution deadline must be after the claim time");
  }
  const key = attemptKey({
    appId: scope.appId,
    installationId: scope.installationId,
    owner: scope.owner,
    repo: scope.repo,
    prNumber: scope.prNumber,
    headSha: input.headSha,
    triggeredBy: input.triggeredBy,
    action: input.action,
  });
  const attemptId = crypto.randomUUID();

  // The claim is the whole race. `INSERT … SELECT` is gated on TWO facts about
  // `attempt_key`: no NONTERMINAL row exists (a live or expired-but-open
  // attempt belongs to its holder and to recovery, never to a new claim), and
  // no generation of this key ended WITH a proven publication (spec §7.9's
  // terminal/dedup rule — a successfully published head is never Check-created
  // a second time). If two claims pass the gates in the same instant, the
  // partial unique index rejects exactly one, and because a failed statement
  // rolls back the batch, the loser owns nothing: it surfaces through the
  // reread below as `busy`, never as its own generation.
  const noPublishedTerminal = `(SELECT COUNT(*) FROM review_checks p WHERE p.attempt_key = ? AND p.observed IN ('success','neutral')) = 0`;
  const insert = db
    .prepare(
      `INSERT INTO review_checks
         (id, app_id, github_app_id, installation_id, owner, repo, pr_number,
          head_sha, triggered_by, action, attempt_key, generation, external_id,
          check_run_id, create_state, holder, lease_epoch, lease_until_ms,
          execution_deadline_ms, desired, desired_title, desired_summary, observed,
          recovery_state, publication_id, attempts, next_attempt_ms, last_error,
          terminal_ms, created_ms, updated_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ${NEXT_GENERATION_SQL},
              ${EXTERNAL_ID_SQL},
              NULL, 'not-sent', ?, 1, ?, ?,
              'in_progress', NULL, NULL, 'unknown',
              'pending', NULL, 0, NULL, NULL, NULL, ?, ?
         FROM (SELECT 1) AS seed
        WHERE NOT EXISTS (SELECT 1 FROM review_checks o WHERE o.attempt_key = ? AND ${NONTERMINAL_WHERE})
          AND ${noPublishedTerminal}`,
    )
    .bind(
      attemptId, scope.appId, input.githubAppId, scope.installationId,
      scope.owner, scope.repo, scope.prNumber,
      input.headSha, input.triggeredBy, input.action, key,
      key,
      attemptId, key,
      input.holder, input.executionDeadlineMs, input.executionDeadlineMs,
      nowMs, nowMs,
      key,
      key,
    );

  try {
    await db.batch([insert]);
  } catch (error) {
    // The designed loser path — another claimer took the key or the generation.
    if (!isUniqueViolation(error)) throw error;
  }

  const mine = await getCheckAttempt(db, attemptId);
  if (mine !== null) {
    if (mine.lease === null) {
      throw new Error("review-checks: claimed row carries no lease (the claim insert is wrong)");
    }
    if (mine.identity.externalId !== externalIdFor(attemptId, mine.identity.generation)) {
      throw new Error("review-checks: stamped external_id disagrees with externalIdFor (SQL/TS drift)");
    }
    return { kind: "claimed", attempt: mine, lease: mine.lease };
  }

  const active = await db
    .prepare(`SELECT * FROM review_checks WHERE attempt_key = ? AND ${NONTERMINAL_WHERE} ORDER BY generation DESC LIMIT 1`)
    .bind(key)
    .first<ReviewCheckRow>();
  if (active !== null) return { kind: "busy", attempt: attemptOf(active) };

  const latest = await db
    .prepare(`SELECT * FROM review_checks WHERE attempt_key = ? ORDER BY generation DESC LIMIT 1`)
    .bind(key)
    .first<ReviewCheckRow>();
  if (latest === null) {
    throw new Error("review-checks: claim inserted nothing and no row exists for the key (unexpected D1 state)");
  }
  return { kind: "terminal", attempt: attemptOf(latest) };
}

/** Read one attempt by row id (null = no such row). */
export async function getCheckAttempt(db: D1Like, id: string): Promise<CheckAttempt | null> {
  const row = await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(id).first<ReviewCheckRow>();
  return row === null ? null : attemptOf(row);
}
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

// ---------------------------------------------------------------------------
// Recovery claim (spec §7.9 / §7.11.2 step 1)
// ---------------------------------------------------------------------------

/**
 * Recovery reacquire: ONE conditional UPDATE that repeats eligibility and
 * increments the epoch. A live lease — another holder's or this holder's
 * unexpired one — is never taken. `execution_deadline_ms` is untouched and the
 * recovery lease runs `CHECK_RECOVERY_LEASE_MS` from `nowMs`, so expiry always
 * still means the execution deadline (spec §7.9/§7.11.2).
 *
 * Deliberately spends NO attempt: selection alone grants no ownership and a
 * budget deferral must not burn a retry (§7.11.2 step 5).
 */
export async function claimCheckRecovery(
  db: D1Like,
  id: string,
  holder: string,
  nowMs: number,
): Promise<Lease | null> {
  const claim = await db
    .prepare(
      `UPDATE review_checks
          SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?, updated_ms = ?
        WHERE id = ? AND ${NONTERMINAL_WHERE}
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
    )
    .bind(holder, nowMs + CHECK_RECOVERY_LEASE_MS, nowMs, id, nowMs)
    .run();
  if (claim.meta.changes !== 1) return null;
  const row = await db
    .prepare(`SELECT holder, lease_epoch, lease_until_ms FROM review_checks WHERE id = ?`)
    .bind(id)
    .first<Pick<ReviewCheckRow, "holder" | "lease_epoch" | "lease_until_ms">>();
  if (row === null || row.holder !== holder || row.lease_until_ms === null) return null;
  return { holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms };
}

// ---------------------------------------------------------------------------
// Fenced mutations (spec §7.9)
// ---------------------------------------------------------------------------

/**
 * Attach the proven remote run id under the live lease and move
 * `create_state` to `known`. A previously attached id is NEVER replaced
 * (spec §7.9: "A known terminal remote ID is retained, never cleared to create
 * a lookalike"); re-attaching the identical id is the idempotent success case.
 * `false` means the lease was lost or a different remote id is already recorded.
 */
export async function attachCheckRunId(
  db: D1Like,
  id: string,
  lease: Lease,
  checkRunId: number,
  nowMs?: CheckClock,
): Promise<boolean> {
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
    throw new Error(`review-checks: check_run_id must be a positive integer, got ${String(checkRunId)}`);
  }
  return runFenced(
    db,
    id,
    lease,
    `check_run_id = COALESCE(check_run_id, ?), create_state = 'known', last_error = NULL`,
    [checkRunId],
    nowMs,
  );
}

/**
 * Move `create_state` under the live lease (spec §7.9: "persist
 * create_state=sending before create"; a lost response sets `unknown`; a
 * definitive pre-send rejection reverts to `not-sent`). `known` is reachable
 * only through `attachCheckRunId`, and no path here clears a known remote id.
 */
export async function setCheckCreateState(
  db: D1Like,
  id: string,
  lease: Lease,
  state: Exclude<CheckCreateState, "known">,
  reason?: string,
  nowMs?: CheckClock,
): Promise<boolean> {
  const sets =
    state === "not-sent"
      ? `create_state = 'not-sent', last_error = NULL`
      : `create_state = ?, last_error = ?`;
  const values: unknown[] = state === "not-sent" ? [] : [state, checkReason(reason ?? `create_state=${state}`)];
  return runFenced(db, id, lease, sets, values, nowMs);
}

/**
 * Freeze the terminal intent BEFORE any remote update (spec §7.9 "Desired
 * versus observed"): conclusion, bounded title/summary and the publication
 * proof link. The type excludes `in_progress`.
 *
 * Monotonic with exactly one documented exception: a `failure` decided while
 * publication was unknown may be corrected to `success`/`neutral` when positive
 * proof turns up, and the correction is honored ONLY when the caller supplies
 * that proof link (spec §7.9: "newly discovered positive publication proof may
 * correct a previously unknown failure into success/neutral on the same owned
 * run; record that correction, do not create another run"). Re-writing the SAME
 * intent is the idempotent replay case and still links the proof. Any other
 * change — a downgrade, a lateral swap, or a correction with no proof — returns
 * false and writes nothing.
 */
export async function setCheckDesired(
  db: D1Like,
  id: string,
  lease: Lease,
  conclusion: CheckConclusion,
  publicationId: string | null,
  nowMs?: CheckClock,
): Promise<boolean> {
  const current = await getCheckOwnership(db, id, lease);
  if (current === null) return false;
  const was = current.desired;
  if (was !== "in_progress" && was !== conclusion.desired) {
    const correction = was === "failure" && (conclusion.desired === "success" || conclusion.desired === "neutral");
    if (!correction || publicationId === null) return false;
  }
  const summary =
    conclusion.summary.length > CHECK_SUMMARY_MAX_CHARS
      ? conclusion.summary.slice(0, CHECK_SUMMARY_MAX_CHARS)
      : conclusion.summary;
  return runFenced(
    db,
    id,
    lease,
    `desired = ?, desired_title = ?, desired_summary = ?,
            publication_id = COALESCE(?, publication_id),
            recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
    [conclusion.desired, conclusion.title, summary, publicationId],
    nowMs,
  );
}

/**
 * Advance `observed` from a remote payload whose identity ALREADY matches the
 * persisted row (spec §7.9: "Mark observed only when the response (or a
 * subsequent GET) has matching identity, status=completed and the intended
 * conclusion"). Identity = the run's `external_id`, `head_sha`, `name`, owning
 * `app.id`, and — once attached — the persisted `check_run_id`.
 *
 * A completed run whose conclusion is not the locally persisted intent is
 * evidence of something else (a manual close, another writer), never an
 * observation of this attempt. An in-progress payload is recorded only while
 * nothing terminal is observed yet. `false` means nothing was written; the
 * caller then records `remote-unconfirmed` through `deferCheckRecovery`.
 */
export async function recordCheckObservation(
  db: D1Like,
  id: string,
  lease: Lease,
  remote: CheckRemote,
  nowMs?: CheckClock,
): Promise<boolean> {
  const owned = await getCheckOwnership(db, id, lease);
  if (owned === null) return false;
  const { identity } = owned;
  if (remote.external_id !== identity.externalId) return false;
  if (remote.head_sha !== identity.headSha) return false;
  if (remote.name !== CHECK_NAME) return false;
  if (remote.app === null || remote.app.id !== identity.githubAppId) return false;
  if (owned.checkRunId !== null && owned.checkRunId !== remote.id) return false;

  const agrees = remote.status === "completed" && owned.desired !== "in_progress" && remote.conclusion === owned.desired;
  const running = remote.status === "queued" || remote.status === "in_progress" || remote.status === "pending";
  if (!agrees && !running) return false;
  if (running && owned.observed !== "unknown") return false;

  const observed: CheckObserved = agrees ? (owned.desired as Exclude<CheckDesired, "in_progress">) : "in_progress";
  return runFenced(
    db,
    id,
    lease,
    `observed = ?,
            check_run_id = COALESCE(check_run_id, ?),
            create_state = CASE WHEN check_run_id IS NULL THEN 'known' ELSE create_state END,
            recovery_state = CASE WHEN ? THEN 'done' ELSE recovery_state END,
            terminal_ms = CASE WHEN ? THEN ? ELSE terminal_ms END,
            next_attempt_ms = CASE WHEN ? THEN NULL ELSE next_attempt_ms END,
            last_error = CASE WHEN ? THEN NULL ELSE last_error END`,
    [
      observed,
      remote.id,
      agrees ? 1 : 0,
      agrees ? 1 : 0,
      nowMs ?? lease.untilMs,
      agrees ? 1 : 0,
      agrees ? 1 : 0,
    ],
    nowMs,
  );
}

// ---------------------------------------------------------------------------
// Recovery bookkeeping (spec §7.9 / §7.11.2 — consumed by T3)
// ---------------------------------------------------------------------------

/**
 * Release the live lease and schedule the next attempt after an `unavailable`
 * or unconfirmed outcome (spec §7.9: such a result "changes recovery
 * status/error/backoff only, never observed or desired"). The attempt is spent
 * HERE — at the point a real recovery action failed — never at reacquire.
 */
export async function deferCheckRecovery(
  db: D1Like,
  id: string,
  lease: Lease,
  input: { state: Extract<CheckRecoveryState, "pending" | "remote-unconfirmed">; nextAttemptMs: number; reason: string },
  nowMs: number,
): Promise<boolean> {
  return runFenced(
    db,
    id,
    lease,
    `holder = NULL, lease_until_ms = NULL, attempts = attempts + 1,
            recovery_state = ?, next_attempt_ms = ?, last_error = ?`,
    [input.state, input.nextAttemptMs, checkReason(input.reason)],
    nowMs,
  );
}

/**
 * Give up honestly at the attempt cap (spec §7.11.2 step 4): `local-error` plus
 * `terminal_ms` under the current fence. The row, its external id and any known
 * remote run id are RETAINED — nothing here deletes work or claims the remote
 * finished.
 */
export async function markCheckLocalError(
  db: D1Like,
  id: string,
  lease: Lease,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  return runFenced(
    db,
    id,
    lease,
    `recovery_state = 'local-error', terminal_ms = ?, last_error = ?,
            attempts = attempts + 1`,
    [nowMs, checkReason(reason)],
    nowMs,
  );
}

/**
 * Durable App-lifecycle suspension for the Check lane (spec §7.6): rows keep
 * their identities while suspended and return to `pending` on re-enable. The
 * pair binds BOTH durable App ids through the registry's own columns — never a
 * repository-wide scan.
 */
export async function suspendCheckRecovery(
  db: D1Like,
  pair: { appId: string; installationId: number },
  reason: string,
  nowMs: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET recovery_state = 'suspended', holder = NULL, lease_until_ms = NULL,
              next_attempt_ms = NULL, last_error = ?, updated_ms = ?
        WHERE app_id = ? AND installation_id = ? AND ${NONTERMINAL_WHERE}
          AND recovery_state IN ('pending','remote-unconfirmed')`,
    )
    .bind(checkReason(reason), nowMs, pair.appId, pair.installationId)
    .run();
  return result.meta.changes;
}

/** The Check-lane re-enable (spec §7.6: suspended rows resume with the same IDs). */
export async function reenableChecksForApps(
  db: D1Like,
  pairs: { appId: string; installationId: number }[],
  nowMs: number,
): Promise<void> {
  for (const pair of pairs) {
    await db
      .prepare(
        `UPDATE review_checks
            SET recovery_state = 'pending', updated_ms = ?
          WHERE app_id = ? AND installation_id = ? AND recovery_state = 'suspended'`,
      )
      .bind(nowMs, pair.appId, pair.installationId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Reconcile selection (spec §7.11.2 predicate, verbatim)
// ---------------------------------------------------------------------------

/**
 * Due Check-reconcile batch (spec §7.11.2): ONE bound `nowMs` at every
 * predicate position, `attempts < maxAttempts`, ORDER BY
 * `COALESCE(next_attempt_ms, created_ms), id`, LIMIT. A row still wanting
 * `in_progress` becomes eligible only after its EXECUTION deadline — neither
 * bookkeeping nor a renewed recovery lease makes an attempt due.
 */
export async function listCheckReconcileBatch(
  db: D1Like,
  nowMs: number,
  maxAttempts: number = CHECK_MAX_ATTEMPTS,
  limit: number = CHECK_RECONCILE_LIMIT,
): Promise<CheckAttempt[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM review_checks
        WHERE ${NONTERMINAL_WHERE}
          AND recovery_state IN ('pending','remote-unconfirmed')
          AND attempts < ?
          AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
          AND (desired <> 'in_progress' OR execution_deadline_ms <= ?)
        ORDER BY COALESCE(next_attempt_ms,created_ms),id
        LIMIT ?`,
    )
    .bind(maxAttempts, nowMs, nowMs, nowMs, limit)
    .all<ReviewCheckRow>();
  return results.map(attemptOf);
}

/**
 * Operator retry (spec §7.11.2 step 6): reopens RECOVERY of the SAME historical
 * identity. Generation, external id, remote run id, desired/observed and the
 * proof link are all retained; nothing restarts model work. Refuses a live
 * lease and refuses a row a newer active generation has superseded, so the old
 * row stays put for inspection until it is safe.
 */
export async function retryCheckRecovery(
  db: D1Like,
  input: { scope: Scope; attemptId: string; nowMs: number },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT * FROM review_checks
        WHERE id = ? AND app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
    )
    .bind(
      input.attemptId, input.scope.appId, input.scope.installationId,
      input.scope.owner, input.scope.repo, input.scope.prNumber,
    )
    .first<ReviewCheckRow>();
  if (row === null) return false;
  // A row whose remote run already proved the intended conclusion has nothing
  // left to recover: reopening it would re-drive a completed attempt. Only
  // UNPROVEN rows (unknown observation) are retryable.
  if (row.observed === "success" || row.observed === "neutral") return false;
  if (row.lease_until_ms !== null && row.lease_until_ms > input.nowMs) return false;
  const newerActive = await db
    .prepare(
      `SELECT 1 AS hit FROM review_checks
        WHERE attempt_key = ? AND ${NONTERMINAL_WHERE} AND generation > ? LIMIT 1`,
    )
    .bind(row.attempt_key, row.generation)
    .first();
  if (newerActive !== null) return false;
  // Reopening ALSO clears the local give-up mark: the selector only ever
  // considers `terminal_ms IS NULL` rows, so a `local-error` row that kept its
  // terminal mark could never be reconciled — the operator retry would be a
  // silent no-op. Nothing else moves: generation, external id, check run id,
  // desired, observed and the proof link are all retained, and `observed` is
  // NOT rewritten, so this never pretends the remote run completed.
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET recovery_state = 'pending', attempts = 0, next_attempt_ms = NULL,
              last_error = NULL, holder = NULL, lease_until_ms = NULL,
              terminal_ms = NULL, updated_ms = ?
        WHERE id = ?`,
    )
    .bind(input.nowMs, input.attemptId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Proof reader for the Check lane (spec §7.9: "Read proof by exact App/scope/SHA,
 * preferring this attempt's publication ID"). The journal stays in
 * `src/store/finding-lifecycle.ts`, so exactly one reader exists; this
 * re-export is plan 68's integration point. `null` means UNPROVEN — never
 * "not published".
 */
export { readPublicationProof } from "./finding-lifecycle";
