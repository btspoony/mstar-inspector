
import type { CustomProviderDeclaration, ReviewLevel } from "../../packages/shared/src/runtime";
import { APPLIED_MODEL_MAX_CHARS, APPLIED_MODEL_PATH, APPLIED_MODEL_PATTERN } from "../../packages/shared/src/runtime";
import type { FailureCode } from "../contracts/failure-codes";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  type CustomProviderConsumerConfig,
  type CustomProviderModelMeta,
  type CustomProviderModelsMeta,
} from "../dashboard/app-config-store";
// The credential encryption leaf (AES-256-GCM envelope): the paid session's
// exact gate set is sealed at rest, never stored in the clear.
import { createSecretbox } from "../dashboard/secretbox";
import type { GitOpsCommands } from "./gitops";
import { catalogLimitsFor } from "../contracts/provider-catalog-limits";
import { resolveModelSize } from "../contracts/provider-models";
import { encodeCredentialPayload, type CredentialPools } from "../../packages/shared/src/credential-payload";
import { providerEnvName } from "./provider-catalog";
import { redactDocument, redactExactSecrets, redactSecrets } from "./redact";
import { EXEC_TIMEOUT_GIT_MS, POST_RUNNER_READ_TIMEOUT_MS, type RunnerBudgetAnchor } from "../review-budget";
import type { FailureStage } from "../store/failure-store";
import type { D1Like, D1StatementLike } from "../store/types";
import {
  attemptKey,
  deferCheckForPendingPublication,
  deferCheckRecovery,
  type Lease as CheckLease,
} from "../store/review-checks";
import { parseBudgetExhaustedSignal, type BudgetExhaustedOutcome } from "../review/schema";
import {
  isRecheckStatusReason,
  RECHECK_OUTPUT_PATH,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  validateRecheckDoc,
  type RecheckDoc,
  type RecheckInput,
  type RecheckStatus,
} from "../../packages/shared/src/recheck-wire";
import {
  REPORT_OUTPUT_PATH,
  validateReportDoc,
  type PrContext,
  type ReportDoc,
} from "../../packages/shared/src/report-wire";
import { assertSandboxGrant, type ReviewCommenter } from "./comment";
import {
  BOUNDED_READ_ABSENT_FLAG,
  buildGitOpsCommands,
  CLONE_DIR,
  DIFF_PATH,
  gitTransportEnv,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
  RUNNER_INPUT_PATH,
  RUNNER_PATH,
  runnerCommand,
  writeJsonCommand,
} from "./gitops";
import type { DestroyOutcome, MarkedRun, RetentionProof, ReviewSandbox } from "./sandbox";
import { ContainerNotRunningError, execCause, execSensitiveValues } from "./sandbox-errors";
import { shellCommand, type ShellCommand } from "./shell-command";

/**
 * The attempt token's exact bytes: literal prefix, lowercase attempt id, one
 * LF. It identifies the attempt and nothing else — no credential, no host, no
 * checkout fact — so it can be read back from the container and compared
 * verbatim.
 *
 * It proves "this container is the one this attempt wrote" and nothing more: it
 * cannot stop a REPLAYED prepare from stamping a replacement container, because
 * an exclusive create protects an existing file, not an absent one. That half
 * is the durable first-provisioning claim in the attempt's own row; until that
 * row exists, no recovery path may be enabled, and none is wired here.
 *
 * An unproven container is never destroyed: no counter, elapsed time or lost
 * reply proves a paid child stopped, so it is left to the platform. Its
 * absolute lifetime is UNVERIFIED — the configured inactivity timeout is not
 * evidence of a hard reclamation bound (a still-active process or a stalled
 * destroy RPC is not shown to be bounded by idleness). The leftover is accepted
 * on that unverified footing, and nothing may "clean up" an unproven attempt —
 * not a recovery path, not a reconciler, not a later same-name call.
 */
export function attemptMarker(attemptId: string): string {
  return `mstar.review-attempt/v1:${attemptId.toLowerCase()}\n`;
}

/**
 * The container one attempt owns. The id derives only from the attempt, so two
 * attempts can never address the same container and a later step (or a
 * recovery run) can address the one that holds the prepared checkout.
 */
export function attemptSandboxId(attemptId: string): string {
  return `review-${attemptId.toLowerCase()}`;
}

/**
 * THE container handle. It exists only after the attempt's provisioning row
 * does (migration 0090): `claimReviewAttempt` is the one writer that mints the
 * id and this is the one reader a caller may use, so a start path cannot reach
 * `ensureRunning` for an attempt the database has not heard of. A caller that
 * asks for a handle without that row is told so instead of being handed one
 * (this is the enforcement behind "no row means no container", not a note).
 */
export async function reviewAttemptSandbox(
  deps: {
    env: { SANDBOX: unknown; DB: D1Like };
    getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  },
  attemptId: string,
): Promise<ReviewSandbox> {
  const activation = await readAttemptActivation(deps.env.DB, attemptId);
  if (activation === null || !activation.activated) {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: it has not won the activation transition, so no container may be addressed for it`,
      "review.container.unavailable",
    );
  }
  if (activation.revoked) {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: a successor revoked it, so nothing may start for it again`,
      "review.container.retired",
    );
  }
  if (activation.sandboxId === null) {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: its provisioning row carries no minted container id`,
      "review.container.unavailable",
    );
  }
  try {
    return await deps.getSandbox(deps.env.SANDBOX, activation.sandboxId);
  } catch (err) {
    const detail = redactSecrets(err instanceof Error ? err.message : String(err));
    throw new AttemptUnknownError(
      `attempt ${attemptId}: its container handle could not be resolved (${detail}) — the container's state is unknown`,
      "review.container.unavailable",
    );
  }
}

/** One attempt's activation state, as the provisioning row records it. */
export type AttemptActivation = {
  sandboxId: string | null;
  activated: boolean;
  revoked: boolean;
};

/**
 * The attempt's activation state, or null when it never claimed a provisioning
 * row. A REJECTED read is not a state: it throws `AttemptUnknownError` at this
 * one reader, so no caller can mistake a read fault for "not activated" — that
 * mistake would conclude the Check, destroy the container and release capacity
 * on evidence nobody observed.
 */
export async function readAttemptActivation(db: D1Like, attemptId: string): Promise<AttemptActivation | null> {
  let row: { sandbox_id: string | null; activated_ms: number | null; revoked_ms: number | null } | null;
  try {
    row = await db
      .prepare(`SELECT sandbox_id, activated_ms, revoked_ms FROM review_launches WHERE attempt_id = ?`)
      .bind(attemptId)
      .first<{ sandbox_id: string | null; activated_ms: number | null; revoked_ms: number | null }>();
  } catch (err) {
    const detail = redactSecrets(err instanceof Error ? err.message : String(err));
    throw new AttemptUnknownError(
      `attempt ${attemptId}: its activation could not be read (${detail}) — nothing may be concluded about its container`,
      "review.container.unavailable",
    );
  }
  if (row === null) return null;
  return { sandboxId: row.sandbox_id, activated: row.activated_ms !== null, revoked: row.revoked_ms !== null };
}

/**
 * The successor's claim over an attempt that never activated. ONE guarded
 * write: it INSERTS the row (which is the claim when there is none) or revokes
 * one that was never activated, and it refuses a row that activated — that is
 * the case where only the container itself can say whether anything runs.
 *
 * `true` means this caller now holds the fact "no container could ever have
 * been created for that attempt", which is the ONLY way capacity and the PR
 * move without observing the container.
 */
export async function claimUnactivatedAttempt(db: D1Like, attemptId: string, nowMs: number): Promise<boolean> {
  const written = await db
    .prepare(
      `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, abandoned_at_ms, sandbox_id, revoked_ms)
       VALUES (?, 'abandoned', ?, ?, ?, ?)
       ON CONFLICT (attempt_id) DO UPDATE
          SET revoked_ms = excluded.revoked_ms
        WHERE review_launches.activated_ms IS NULL AND review_launches.revoked_ms IS NULL`,
    )
    .bind(attemptId, nowMs, nowMs, attemptSandboxId(attemptId), nowMs)
    .run();
  return written.meta.changes === 1;
}

/**
 * Record a revocation that the attempt's OWN container already proved
 * (`revoke()` answered not-running). The write is not assumed: the caller gets
 * `true` only when the row now reads revoked, so a failed or lost write keeps
 * the takeover from proceeding.
 */
export async function markAttemptRevoked(db: D1Like, attemptId: string, nowMs: number): Promise<boolean> {
  await db
    .prepare(`UPDATE review_launches SET revoked_ms = ? WHERE attempt_id = ? AND revoked_ms IS NULL`)
    .bind(nowMs, attemptId)
    .run();
  return (await readAttemptActivation(db, attemptId))?.revoked === true;
}

/**
 * The attempt's container could not be proven to be the one this attempt
 * prepared, or its state could not be read at all. Nothing paid ran on that
 * evidence; the outcome is `unknown` — neither a failure nor a success.
 */
export class AttemptUnknownError extends Error {
  /**
   * The operator-facing code the throw site knows to be true — never inferred
   * from the phase or the message later.
   *
   * `cause` is the bounded evidence the sandbox boundary handed back for an
   * unobservable paid step (error name, message, elapsed time). It is evidence
   * only: nothing classifies on it, and the settlement branch never reads it.
   */
  constructor(
    message: string,
    readonly code: FailureCode,
    readonly cause?: string,
  ) {
    super(message);
    this.name = "AttemptUnknownError";
  }
}

/**
 * The slot could not be provisioned inside the caller's absolute deadline
 * (start, inactivity setting or marker write did not answer). TRANSIENT: the
 * next entry re-provisions from scratch, because the D1 row still proves no
 * paid step was sent.
 */
export class ContainerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerUnavailableError";
  }
}

/**
 * The slot is not running. TRANSIENT: only `provision` may start a container,
 * so the retry re-provisions rather than reviving this handle. Declared in the
 * dependency-free `./sandbox-errors` leaf and re-exported here, so a consumer
 * that only classifies outcomes never links the container binding.
 */
export { ContainerNotRunningError } from "./sandbox-errors";

/**
 * This repository's per-App review configuration could not be resolved, so the
 * attempt cannot pay. TERMINAL and operator-actionable: a retry changes
 * nothing until someone fixes the App.
 */
export class ConfigUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigUnresolvedError";
  }
}

/**
 * The slot is retired: the durable fence says nothing may ever start here
 * again. TERMINAL — retrying it only burns the step's retry budget.
 */
export class AttemptRetiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptRetiredError";
  }
}

/**
 * The slot stopped or was replaced BEFORE the paid step was sent. TERMINAL but
 * free: the D1 row still proves no paid work, so nothing was charged and a new
 * attempt may run.
 */
export class ContainerLostBeforePaidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerLostBeforePaidError";
  }
}

/**
 * The slot stopped or was replaced AFTER the launch row moved to `launched`.
 * The paid exec was never issued (the marker proof precedes it), so this is a
 * confirmed no-result — never a lost reply. The row is moved to `failed` before
 * this is thrown.
 */
export class ContainerLostAfterClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerLostAfterClaimError";
  }
}

/**
 * The container refused to start a process because the attempt's absolute
 * deadline (less the kill grace) was already gone when the request reached it.
 * NOTHING ran, so this is a CONFIRMED cap stop — never `unknown` (which would
 * hold the container and capacity) and never a lost reply.
 */
export class ExecDeadlineRefusedError extends Error {
  constructor(readonly remainingMs: number) {
    super(`the exec deadline was spent before the process started (${remainingMs}ms left)`);
    this.name = "ExecDeadlineRefusedError";
  }
}

/**
 * Destroy the attempt's container ONLY after proving it is still the one this
 * attempt prepared AND that the caller may destroy it (the result is durable,
 * or no paid work started). `destroyed` and `stopped` both end the slot (both
 * fence it); `unknown` destroys nothing, so a replacement incarnation is never
 * torn down and a running paid command never loses its only copy.
 */
export async function discardReviewAttempt(
  sandbox: ReviewSandbox,
  attemptId: string,
  retention: RetentionProof,
): Promise<DestroyOutcome> {
  return sandbox.destroyMarked(attemptMarker(attemptId), retention);
}

const CLAIM_ATTEMPT_SQL = `
INSERT INTO review_launches (attempt_id, state, claimed_at_ms, attempt_key, attempt_generation, sandbox_id, activated_ms)
VALUES (?, 'provisioned', ?, ?, ?, ?, ?)
ON CONFLICT (attempt_id) DO NOTHING
`;



const FREEZE_ATTEMPT_IDENTITY_SQL = `
UPDATE review_launches SET attempt_key = ?, attempt_generation = ?
WHERE attempt_id = ? AND attempt_key IS NULL
`;

const READ_ATTEMPT_IDENTITY_SQL = `SELECT attempt_key, attempt_generation FROM review_launches WHERE attempt_id = ?`;

/** One attempt's frozen Check identity: the key and the generation it belongs to. */
export type AttemptIdentity = { key: string; generation: number };

const CLAIM_LAUNCH_SQL = `
UPDATE review_launches
SET state = 'launched', launched_at_ms = ?
WHERE attempt_id = ? AND state = 'provisioned'
`;

const COMPLETE_LAUNCH_SQL = `
UPDATE review_launches
SET state = 'persisted', persisted_at_ms = ?, result_json = ?, gate_secrets_enc = ?, result_outcome = 'persisted'
WHERE attempt_id = ? AND state = 'launched'
`;

/**
 * The AAD the gate's credential envelope is bound to: the column it lives in
 * plus this attempt's id, so a ciphertext copied onto another attempt's row
 * fails the GCM tag (the secretbox contract).
 */
const GATE_SECRETS_AAD = "review_launches.gate_secrets_enc";

const READ_GATE_SECRETS_SQL = `SELECT gate_secrets_enc FROM review_launches WHERE attempt_id = ?`;

/**
 * Seal the paid session's EXACT gate set — the provider keys it transported and
 * the installation token it minted — onto its own attempt row (I-000685). This
 * is the set the SEC-01 gate must scan for on a RESUMED host: re-resolving the
 * App config there would scan for whatever the config holds later, so a rotated
 * or removed key's echo would pass. Nothing but that gate opens it.
 */
export async function sealGateSecrets(
  encryptionKey: string | undefined,
  attemptId: string,
  values: readonly string[],
): Promise<string> {
  return createSecretbox(encryptionKey).encryptSecret(
    JSON.stringify(values),
    `${GATE_SECRETS_AAD}:${attemptId}`,
  );
}

/**
 * The sealed set's plaintext list. Throws on a tampered / AAD-mismatched /
 * key-lost envelope — the gate must never treat an unreadable set as empty.
 */
export async function openGateSecrets(
  encryptionKey: string | undefined,
  attemptId: string,
  envelope: string,
): Promise<string[]> {
  const parsed: unknown = JSON.parse(
    await createSecretbox(encryptionKey).decryptSecret(envelope, `${GATE_SECRETS_AAD}:${attemptId}`),
  );
  if (!Array.isArray(parsed) || !parsed.every((value): value is string => typeof value === "string")) {
    throw new Error(`attempt ${attemptId}: the sealed gate credential set is not a string list`);
  }
  return parsed;
}

/**
 * The persisted result's sealed gate set, or `null` when that row records none.
 * A NULL is only ever a PERSISTED-RESULT fact: the seal is taken before the paid
 * exec (an encryption fault fails the step, so no result is written), and a
 * sealing fault can therefore never leave a persisted row without one — the only
 * NULL rows are attempts paid before the column existed. A store fault throws:
 * the caller must retry, never publish a body it could not scan.
 */
export async function readGateSecretsEnvelope(db: D1Like, attemptId: string): Promise<string | null> {
  const row = await db
    .prepare(READ_GATE_SECRETS_SQL)
    .bind(attemptId)
    .first<{ gate_secrets_enc: string | null }>();
  return row?.gate_secrets_enc ?? null;
}

/**
 * The attempt's terminal NO-RESULT outcome, as one conditional statement: only
 * a `launched` row moves to `failed`, so a replay or duplicate settle changes
 * nothing. It carries `result_outcome` in the same statement (the schema
 * refuses the timestamp without it).
 */
const RECORD_LAUNCH_FAILURE_SQL = `
UPDATE review_launches
SET state = 'failed', failed_at_ms = ?, result_outcome = 'failed'
WHERE attempt_id = ? AND state = 'launched'
`;

/**
 * The same conditional write as a STATEMENT, for a caller that must land it in
 * ONE batch beside the durable failure row it stands for (the lost-reply
 * settlement): a row may never be authorised as settled ahead of the fact it
 * records, and a half-applied settlement must not exist.
 */
export function recordReviewFailureStatement(db: D1Like, attemptId: string, nowMs: number): D1StatementLike {
  return db.prepare(RECORD_LAUNCH_FAILURE_SQL).bind(nowMs, attemptId);
}

/**
 * The REVOCATION as a statement (see `markAttemptRevoked`), for a settlement
 * that must clear the attempt's capacity hold in the same batch: an expired
 * admission row keeps holding its slot while its attempt is activated and never
 * revoked, and a window that proved no live child is exactly the evidence
 * `revoke()` would have given. Idempotent: an already-revoked row matches zero.
 */
export function markAttemptRevokedStatement(db: D1Like, attemptId: string, nowMs: number): D1StatementLike {
  return db
    .prepare(
      `UPDATE review_launches SET revoked_ms = ?
        WHERE attempt_id = ? AND state = 'launched' AND result_outcome IS NULL AND revoked_ms IS NULL`,
    )
    .bind(nowMs, attemptId);
}


const ABANDON_LAUNCH_SQL = `
INSERT INTO review_launches (attempt_id, state, claimed_at_ms, abandoned_at_ms, sandbox_id)
VALUES (?, 'abandoned', ?, ?, ?)
ON CONFLICT (attempt_id) DO UPDATE
   SET state = 'abandoned', abandoned_at_ms = excluded.abandoned_at_ms
 WHERE review_launches.state = 'provisioned'
`;

const NOTE_CHECK_OWED_SQL = `
UPDATE review_launches
SET check_owed_ms = ?, check_key = ?, check_generation = ?
WHERE attempt_id = ? AND check_owed_ms IS NULL
  AND EXISTS (
    SELECT 1 FROM review_checks c
     WHERE c.attempt_key = ? AND c.generation = ? AND c.terminal_ms IS NULL
  )
`;

const BUMP_CHECK_OWED_SQL = `
UPDATE review_launches
SET check_owed_ms = ?
WHERE check_owed_ms IS NOT NULL
  AND check_key = (SELECT c.attempt_key FROM review_checks c WHERE c.id = ?)
  AND check_generation = (SELECT c.generation FROM review_checks c WHERE c.id = ?)
`;

const CLEAR_CHECK_OWED_SQL = `
UPDATE review_launches
SET check_owed_ms = NULL, check_key = NULL, check_generation = NULL
WHERE check_owed_ms IS NOT NULL
  AND check_key = (SELECT c.attempt_key FROM review_checks c WHERE c.id = ?)
  AND check_generation = (SELECT c.generation FROM review_checks c WHERE c.id = ?)
`;

const CLEAR_CONCLUDED_CHECK_OWED_SQL = `
UPDATE review_launches
SET check_owed_ms = NULL, check_key = NULL, check_generation = NULL
WHERE check_owed_ms IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM review_checks c
     WHERE c.attempt_key = review_launches.check_key
       AND c.generation = review_launches.check_generation
       AND c.terminal_ms IS NOT NULL
  )
`;

const READ_LAUNCH_SQL = `
SELECT state, claimed_at_ms, launched_at_ms, persisted_at_ms, failed_at_ms, abandoned_at_ms, result_json, result_outcome, check_owed_ms
FROM review_launches
WHERE attempt_id = ?
`;

/**
 * The row's state vocabulary — exactly the schema's CHECK list. A value outside
 * it means this build is older than the row, which decodes as `unknown` (never
 * as "no row"), so a new state can never be read as permission.
 */
export const LAUNCH_STATES = ["provisioned", "launched", "persisted", "failed", "abandoned"] as const;
export type LaunchRowState = (typeof LAUNCH_STATES)[number];

function isLaunchState(raw: string): raw is LaunchRowState {
  return (LAUNCH_STATES as readonly string[]).includes(raw);
}

type LaunchRow = {
  state: string;
  claimed_at_ms: number;
  launched_at_ms: number | null;
  persisted_at_ms: number | null;
  failed_at_ms: number | null;
  abandoned_at_ms: number | null;
  result_json: string | null;
  result_outcome: string | null;
  check_owed_ms: number | null;
};

/** Unreachable by construction: the compiler proves every state is handled. */
export function noLaunchState(state: never): never {
  throw new Error(`review_launches: unhandled state ${JSON.stringify(state)}`);
}

/**
 * THE plan's retention table, in code. `launchVerdict` is the ONLY place the
 * row's state is turned into meaning; every reader switches on the verdict, so
 * a seventh state cannot be added without the compiler naming every reader's
 * answer (and `noLaunchState` proves the switch is complete).

 *   absent      → never-claimed      (nothing was ever provisioned)
 *   unknown     → unrecognised       (a row this build cannot interpret)
 *   provisioned → never-paid         (a container may exist; no paid exec sent)
 *   abandoned   → owned-by-cleanup   (another cleanup owns its destruction)
 *   launched    → paid-unknown       (the paid exec was sent, no durable outcome)
 *   persisted   → persisted          (the result is durable)
 *   failed      → paid-failed        (the paid call returned a nonzero status)
 */
export type LaunchVerdict =
  | { kind: "never-claimed" }
  | { kind: "unrecognised" }
  | { kind: "never-paid" }
  | { kind: "owned-by-cleanup" }
  | { kind: "paid-unknown" }
  | { kind: "persisted"; execution: ReviewAttemptExecution; persistedAtMs: number }
  | { kind: "paid-failed" };

export function launchVerdict(state: ReviewLaunchState | null): LaunchVerdict {
  if (state === null) return { kind: "never-claimed" };
  switch (state.state) {
    case "unknown":
      return { kind: "unrecognised" };
    case "provisioned":
      return { kind: "never-paid" };
    case "abandoned":
      return { kind: "owned-by-cleanup" };
    case "launched":
      return { kind: "paid-unknown" };
    case "persisted":
      return { kind: "persisted", execution: state.execution, persistedAtMs: state.persistedAtMs };
    case "failed":
      return { kind: "paid-failed" };
    default:
      return noLaunchState(state);
  }
}

/**
 * The attempt's TERMINAL outcome as its own row records it — the only authority
 * retention reads. `null` means no outcome is durable yet, whatever the state.
 */
export type ReviewLaunchOutcome = "persisted" | "failed";

/**
 * Where one attempt is in the paid-step machine, as the row records it. The
 * state IS the retention contract (plan Task 4b): `provisioned` has not sent
 * the paid exec, `launched` has and carries no outcome yet, and the two
 * terminal states carry theirs.
 */
export type ReviewLaunchState =
  | { state: "provisioned"; claimedAtMs: number; checkOwedMs: number | null }
  | { state: "launched"; claimedAtMs: number; launchedAtMs: number; checkOwedMs: number | null }
  | {
      state: "persisted";
      claimedAtMs: number;
      launchedAtMs: number;
      persistedAtMs: number;
      execution: ReviewAttemptExecution;
      checkOwedMs: number | null;
    }
  | { state: "failed"; claimedAtMs: number; launchedAtMs: number; failedAtMs: number; checkOwedMs: number | null }
  | { state: "abandoned"; claimedAtMs: number; abandonedAtMs: number; checkOwedMs: number | null }
  | { state: "unknown"; claimedAtMs: number | null };

/**
 * The launch decision. `ok` means this caller owns the one paid step of the
 * attempt; every refusal names why the step may not be taken, and `persisted`
 * carries the durable result so a replay reads it instead of paying again.
 * `no-claim` covers an attempt that never prepared (no row) and a row that is
 * not in a launchable state — both refuse.
 */
export type LaunchClaim =
  | { ok: true }
  | { ok: false; reason: "already-launched" }
  | { ok: false; reason: "persisted"; execution: ReviewAttemptExecution }
  | { ok: false; reason: "failed" }
  | { ok: false; reason: "no-claim" };

/**
 * Claim the right to provision this attempt's container. `claimed` means THIS
 * entry created the row and may start the container; `already-claimed` means an
 * earlier entry did, so this one may only prove the incarnation that already
 * exists.
 */
export async function claimReviewAttempt(
  db: D1Like,
  attemptId: string,
  nowMs: number,
  identity: AttemptIdentity | null,
): Promise<"claimed" | "already-claimed"> {
  const written = await db
    .prepare(CLAIM_ATTEMPT_SQL)
    .bind(attemptId, nowMs, identity?.key ?? null, identity?.generation ?? null, attemptSandboxId(attemptId), nowMs)
    .run();
  return written.meta.changes === 1 ? "claimed" : "already-claimed";
}

/**
 * Whether this attempt's D1 row entitles a caller to provision its container.
 *
 * The row IS the authority to start (D1): only `provisioned` with no launch and
 * no revocation proves that nothing paid can be lost, so a stopped or
 * undeclared slot may be started again. Every other state refuses — and a
 * revoked row is refused as `retired`, because no retry can ever help.
 */
async function readProvisionGate(
  db: D1Like,
  attemptId: string,
): Promise<"may-provision" | "retired" | string> {
  const row = await db
    .prepare(`SELECT state, launched_at_ms, revoked_ms FROM review_launches WHERE attempt_id = ?`)
    .bind(attemptId)
    .first<{ state: string; launched_at_ms: number | null; revoked_ms: number | null }>();
  if (row === null) return "absent";
  if (row.revoked_ms !== null) return "retired";
  if (row.state !== "provisioned" || row.launched_at_ms !== null) return `'${row.state}'`;
  return "may-provision";
}

/**
 * Freeze the attempt's Check identity the first time it is knowable. ONE
 * conditional write whose CAS is `attempt_key IS NULL`: `true` means this caller
 * won; `false` means another caller already froze a different head — a moved
 * head — and the caller settles this attempt as skipped instead of continuing.
 */
export async function freezeAttemptIdentity(
  db: D1Like,
  attemptId: string,
  identity: AttemptIdentity,
): Promise<boolean> {
  const written = await db
    .prepare(FREEZE_ATTEMPT_IDENTITY_SQL)
    .bind(identity.key, identity.generation, attemptId)
    .run();
  return written.meta.changes === 1;
}

/** The FROZEN identity for this attempt — the only value later phases may use. */
export async function readAttemptIdentity(
  db: D1Like,
  attemptId: string,
): Promise<AttemptIdentity | null> {
  const row = await db
    .prepare(READ_ATTEMPT_IDENTITY_SQL)
    .bind(attemptId)
    .first<{ attempt_key: string | null; attempt_generation: number | null }>();
  if (row?.attempt_key == null || row.attempt_generation == null) return null;
  return { key: row.attempt_key, generation: row.attempt_generation };
}

/**
 * Take the attempt's one paid step: `provisioned` → `launched` in one
 * conditional statement, taken in the caller's statement that is ABOUT TO SEND
 * the exec. A row already launched — a lost reply, a retried entry, a restart —
 * changes nothing and is refused, a persisted row hands back its durable
 * result instead, and a failed row (the paid call returned a nonzero status)
 * refuses a second launch without inventing a result.
 */
export async function claimReviewLaunch(
  db: D1Like,
  attemptId: string,
  nowMs: number,
): Promise<LaunchClaim> {
  const written = await db.prepare(CLAIM_LAUNCH_SQL).bind(nowMs, attemptId).run();
  if (written.meta.changes === 1) return { ok: true };
  const verdict = launchVerdict(await readReviewLaunch(db, attemptId));
  switch (verdict.kind) {
    case "persisted":
      return { ok: false, reason: "persisted", execution: verdict.execution };
    case "paid-unknown":
      return { ok: false, reason: "already-launched" };
    case "paid-failed":
      return { ok: false, reason: "failed" };
    case "never-claimed":
    case "never-paid":
      return { ok: false, reason: "no-claim" };
    case "owned-by-cleanup":
      return { ok: false, reason: "no-claim" };
    case "unrecognised":
      return { ok: false, reason: "no-claim" };
    default:
      return noLaunchState(verdict);
  }
}

/**
 * Record the paid step's RESULT and its completion as one fact: the row reaches
 * `persisted` only in the statement that stores the result, so completion
 * cannot be recorded before the result is durable (the schema refuses the
 * combination). `false` means the row did not move — nothing is confirmed.
 */
/**
 * @param gateSecretsEnc the seal taken BEFORE the exec (see `runReviewAttempt`).
 *   A `null` is only legitimate for a row that predates the seal (or a test that
 *   writes the result directly) — never for an attempt this build paid, whose
 *   sealing fault fails the step before the result exists.
 */
export async function completeReviewLaunch(
  db: D1Like,
  attemptId: string,
  execution: ReviewAttemptExecution,
  nowMs: number,
  gateSecretsEnc: string | null = null,
): Promise<boolean> {
  const written = await db
    .prepare(COMPLETE_LAUNCH_SQL)
    .bind(nowMs, encodeExecution(execution), gateSecretsEnc, attemptId)
    .run();
  return written.meta.changes === 1;
}

/**
 * Record the attempt's terminal NO-RESULT outcome on its own row, as ONE
 * conditional statement, AFTER the durable failure row exists — the settlement
 * calls this once its `review_failures` insert resolved, so the row never
 * authorises destruction ahead of the fact it stands for. An ambiguous exec
 * records nothing, so a resumed cleanup still holds the container.
 *
 * The two pre-exec stop paths in `runReviewAttempt` call it directly: there the
 * exec never started, so the row is the only place that fact can be written.
 */
export async function recordReviewFailure(
  db: D1Like,
  attemptId: string,
  nowMs: number,
): Promise<boolean> {
  const written = await db.prepare(RECORD_LAUNCH_FAILURE_SQL).bind(nowMs, attemptId).run();
  return written.meta.changes === 1;
}

/**
 * Record that this attempt's Check settlement is still owed, on the attempt row
 * (see NOTE_CHECK_OWED_SQL). Idempotent; `false` means the row is gone or the
 * obligation was already stamped.
 */
export async function noteCheckOwed(
  db: D1Like,
  input: { attemptId: string; checkKey: string; checkGeneration: number; dueMs: number },
): Promise<boolean> {
  const written = await db
    .prepare(NOTE_CHECK_OWED_SQL)
    .bind(
      input.dueMs,
      input.checkKey,
      input.checkGeneration,
      input.attemptId,
      input.checkKey,
      input.checkGeneration,
    )
    .run();
  return written.meta.changes === 1;
}

/**
 * Advance the obligation's due instant after a FAILED recovery attempt, exactly
 * as the Check row's own `next_attempt_ms` advances — otherwise a repeatedly
 * failing row cycles without ever backing off.
 */
export async function bumpCheckOwed(
  db: D1Like,
  checkAttemptId: string,
  dueMs: number,
): Promise<boolean> {
  const written = await db
    .prepare(BUMP_CHECK_OWED_SQL)
    .bind(dueMs, checkAttemptId, checkAttemptId)
    .run();
  return written.meta.changes === 1;
}

/**
 * The Check obligation is settled: clear it, so the reconciler stops selecting
 * the attempt. Named by the CHECK's id — the association is the Check's own
 * `attempt_key` + `generation`, which this statement resolves — because the
 * acknowledgement comes from the lane that concluded the Check, never from the
 * writer.
 */
export async function clearCheckOwed(db: D1Like, checkAttemptId: string): Promise<boolean> {
  const written = await db.prepare(CLEAR_CHECK_OWED_SQL).bind(checkAttemptId, checkAttemptId).run();
  return written.meta.changes === 1;
}

/**
 * Clear every mark whose Check has already concluded — the retry path for a
 * clear that faulted, and the cleanup for a holder that terminated the Check
 * itself. Idempotent, one statement, safe to run on every pass.
 */
export async function clearConcludedCheckOwed(db: D1Like): Promise<number> {
  const written = await db.prepare(CLEAR_CONCLUDED_CHECK_OWED_SQL).run();
  return written.meta.changes;
}

/**
 * Claim the attempt for destruction — and `absent` is NO EXCEPTION: with no row
 * this INSERTs one already `abandoned`, with a row it moves `provisioned` →
 * `abandoned`, in ONE statement whose `changes` is the whole answer. `true`
 * means THIS caller won and may destroy the container; `false` means another
 * caller owns the attempt (it may be about to send the exec), so no destruction
 * may follow a read that is now stale.
 *
 * Writing the row is what closes the first-provisioning race: a caller can no
 * longer insert a paid row after cleanup decided there was none.
 */
export async function abandonReviewLaunch(db: D1Like, attemptId: string, nowMs: number): Promise<boolean> {
  const written = await db
    .prepare(ABANDON_LAUNCH_SQL)
    .bind(attemptId, nowMs, nowMs, attemptSandboxId(attemptId))
    .run();
  return written.meta.changes === 1;
}

/**
 * Defer a Check to recovery AND advance the owed obligation in ONE call, so a
 * caller cannot advance one without the other: the obligation's due instant is
 * exactly the Check's own `next_attempt_ms`. SQL cannot update two tables in one
 * statement, so the pairing is one store function rather than one SQL text.
 *
 * `recovery` spends one attempt and backs off; `proof-wait` gives the claim back
 * without spending one (the publication may prove itself at any moment) and
 * re-arms at the same instant.
 */
export async function deferCheckWithOwed(
  db: D1Like,
  input: {
    checkAttemptId: string;
    lease: CheckLease;
    nextAttemptMs: number;
    nowMs: number;
    kind: "recovery" | "proof-wait";
    state?: "pending" | "remote-unconfirmed";
    reason?: string;
  },
): Promise<boolean> {
  await bumpCheckOwed(db, input.checkAttemptId, input.nextAttemptMs);
  let deferred: boolean;
  try {
    deferred =
      input.kind === "proof-wait"
        ? await deferCheckForPendingPublication(db, input.checkAttemptId, input.lease, input.nextAttemptMs, input.nowMs)
        : await deferCheckRecovery(
            db,
            input.checkAttemptId,
            input.lease,
            {
              state: input.state ?? "remote-unconfirmed",
              nextAttemptMs: input.nextAttemptMs,
              reason: input.reason ?? "recovery deferred",
            },
            input.nowMs,
          );
  } catch (err) {
    throw err;
  }
  return deferred;
}

/**
 * The attempts whose Check settlement is still owed, oldest first — the durable
 * handoff the recovery lane reads. It grants nothing on the Check row: the
 * obligation lives on the attempt row, and the lane decides from that row plus
 * the Check's own lease state.
 */
export async function listCheckOwed(
  db: D1Like,
  limit: number,
): Promise<Array<{ attemptId: string; owedMs: number }>> {
  const { results } = await db
    .prepare(
      `SELECT attempt_id, check_owed_ms FROM review_launches
       WHERE check_owed_ms IS NOT NULL
       ORDER BY check_owed_ms, attempt_id LIMIT ?`,
    )
    .bind(limit)
    .all<{ attempt_id: string; check_owed_ms: number }>();
  return results.map((row) => ({ attemptId: row.attempt_id, owedMs: row.check_owed_ms }));
}

/**
 * The attempt's launch row, or null when it never prepared.
 *
 * The state is parsed as a UNION: every member is mapped explicitly (with the
 * `never` default proving completeness), and anything this build does not know —
 * an unrecognised state value, or a state whose coupled facts are missing —
 * decodes as `unknown`. It is never `null`: "no row" means nothing was ever
 * claimed, and collapsing the two would turn an unreadable row into permission.
 */
export async function readReviewLaunch(db: D1Like, attemptId: string): Promise<ReviewLaunchState | null> {
  const row = await db.prepare(READ_LAUNCH_SQL).bind(attemptId).first<LaunchRow>();
  if (row === null) return null;
  const unreadable = (): ReviewLaunchState => ({ state: "unknown", claimedAtMs: row.claimed_at_ms });
  if (!isLaunchState(row.state)) return unreadable();
  switch (row.state) {
    case "provisioned":
      return row.result_outcome !== null
        ? unreadable()
        : { state: "provisioned", claimedAtMs: row.claimed_at_ms, checkOwedMs: row.check_owed_ms };
    case "abandoned":
      return row.abandoned_at_ms === null || row.result_outcome !== null
        ? unreadable()
        : {
            state: "abandoned",
            claimedAtMs: row.claimed_at_ms,
            abandonedAtMs: row.abandoned_at_ms,
            checkOwedMs: row.check_owed_ms,
          };
    case "launched":
      return row.launched_at_ms === null || row.result_outcome !== null
        ? unreadable()
        : {
            state: "launched",
            claimedAtMs: row.claimed_at_ms,
            launchedAtMs: row.launched_at_ms,
            checkOwedMs: row.check_owed_ms,
          };
    case "failed":
      return row.launched_at_ms === null || row.failed_at_ms === null || row.result_outcome !== "failed"
        ? unreadable()
        : {
            state: "failed",
            claimedAtMs: row.claimed_at_ms,
            launchedAtMs: row.launched_at_ms,
            failedAtMs: row.failed_at_ms,
            checkOwedMs: row.check_owed_ms,
          };
    case "persisted":
      if (
        row.launched_at_ms === null ||
        row.persisted_at_ms === null ||
        row.result_json === null ||
        row.result_outcome !== "persisted"
      ) {
        return unreadable();
      }
      return {
        state: "persisted",
        claimedAtMs: row.claimed_at_ms,
        launchedAtMs: row.launched_at_ms,
        persistedAtMs: row.persisted_at_ms,
        execution: decodeExecution(attemptId, row.result_json),
        checkOwedMs: row.check_owed_ms,
      };
    default:
      return noLaunchState(row.state);
  }
}

function encodeExecution(execution: ReviewAttemptExecution): string {
  return JSON.stringify({
    run: { stdout: execution.run.stdout, exitCode: execution.run.exitCode },
    recheck:
      execution.recheck === null ? null : { ...execution.recheck, rejected: [...execution.recheck.rejected] },
    report: execution.report,
    appliedProvider: execution.appliedProvider,
  });
}

function decodeExecution(attemptId: string, json: string): ReviewAttemptExecution {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
  }
  const stored = parsed as
    | ((Partial<{ run: { stdout: string; exitCode: number } }> & {
        recheck?: (Omit<RecheckRead, "rejected"> & { rejected: string[] }) | null;
        report?: ReportDoc | null;
        appliedProvider?: string | null;
      }))
    | null;
  if (typeof stored?.run?.exitCode !== "number" || typeof stored.run.stdout !== "string") {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: its recorded result cannot be read back — nothing was launched`,
      "review.internal.unclassified",
    );
  }
  return {
    run: { stdout: stored.run.stdout, stderr: "", exitCode: stored.run.exitCode },
    recheck:
      stored.recheck == null ? null : { ...stored.recheck, rejected: new Set(stored.recheck.rejected) },
    report: stored.report ?? null,
    appliedProvider: stored.appliedProvider ?? null,
  };
}

/**
 * Structured log sink of one attempt. The caller owns the field schema; this
 * module only adds the fields of the step it is in.
 */
export type AttemptLogFields = Record<string, unknown>;

export type AttemptLog = {
  info(fields: AttemptLogFields, msg?: string): void;
  warn(fields: AttemptLogFields, msg?: string): void;
};

/**
 * The facts one attempt carries across its steps: the coarse stage the caller's
 * failure path attributes a row to, the session's ACTUAL secret values (SEC-01
 * exact-value defense) and the runner's start instant (visibility only). They
 * are passed by reference so a throw inside a step still leaves them visible to
 * the caller's catch.
 */
export type ReviewAttemptProgress = {
  failureStage: FailureStage;
  secretValues: string[];
  runnerStartedAt: number | undefined;
  runnerReturned: boolean;
  /**
   * The runner's last traced stage, read from its stderr the moment it returned.
   * It rides the progress object so a throw raised AFTER the runner (a lost
   * document read, a nonzero exit) still hands the stage to the caller's record.
   */
  lastStage?: string;
};

/** The container, credential and checkout an attempt's paid step runs on. */
export type PreparedReviewAttempt = {
  sandbox: ReviewSandbox;
  token: string;
  cmds: GitOpsCommands;
  headSha: string;
};

/** What the paid step left in the container for collection. */
export type ReviewAttemptExecution = {
  run: { stdout: string; stderr: string; exitCode: number };
  recheck: RecheckRead | null;
  report: ReportDoc | null;
  appliedProvider: string | null;
};

/**
 * The derived-deadline refusal: an attempt's own clock declined a step or a
 * paid exec. `window` names which derived window was spent — the runner
 * window frozen at the anchor (`runner`), or the preparation window before
 * the runner received an allocation (`preparation`).
 */
export class RoundBudgetSpent extends Error {
  constructor(
    message: string,
    readonly window: BudgetExhaustedOutcome["budgetWindow"],
  ) {
    super(message);
    this.name = "RoundBudgetSpent";
  }
}

/**
 * The resolved wall-clock stop: the outcome is built at the site that
 * observed the evidence (the runner's exit-0 signal, or the sandbox exec
 * killed at the anchored deadline) and carried to the caller's single
 * publication catch, which publishes it once — Check, durable failure row,
 * then ack.
 */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly outcome: BudgetExhaustedOutcome,
    message: string,
    /**
     * The runner's last traced stage, when its stderr was readable at this
     * point. Data next to `message`, never parsed back out of it: settlement
     * logs it as `last_stage` so an operator sees where the budget ran out.
     */
    readonly lastStage?: string,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * What the derived pre-runner cutoff still owes a bounded preparation step,
 * capped at the step's own budget. THROWS the explicit round-budget failure
 * once spent: a spent deadline must decline the step, never manufacture a
 * positive (1ms) timeout that starts paid work and then fails it for the
 * wrong cause. The runner's own budget is derived once, at the anchor, and
 * never re-clamped here. `nowMs` fixes the clock when the caller must reuse
 * its own sample — a step whose timeout AND whose kill attribution read one
 * instant (the runner input write) passes it; everyone else takes the fresh
 * read.
 */
export function boundedStepTimeout(
  runnerDeadlineMs: number,
  capMs: number,
  step: string,
  window: BudgetExhaustedOutcome["budgetWindow"],
  nowMs = Date.now(),
): number {
  const left = Math.min(capMs, runnerDeadlineMs - nowMs);
  if (left <= 0) {
    throw new RoundBudgetSpent(
      `round budget spent: ${step} declined — the derived runner deadline was already spent before this step`,
      window,
    );
  }
  return left;
}

type BoundedRead = { text: string | null; failure: "overflow" | "unreadable" | null };

type ReportBoundedRead = { text: string | null; failure: "overflow" | "unreadable" | "absent" | null };

export function parseBoundedRead(stdout: string): BoundedRead;
export function parseBoundedRead(stdout: string, provesAbsence: true): ReportBoundedRead;
export function parseBoundedRead(stdout: string, provesAbsence = false): ReportBoundedRead {
  const out = stdout.trimEnd();
  const split = out.lastIndexOf("\n");
  if (split < 0) return { text: null, failure: "unreadable" };
  const flag = out.slice(split + 1).trim();
  if (provesAbsence && flag === BOUNDED_READ_ABSENT_FLAG) return { text: null, failure: "absent" };
  if (flag !== "0") return { text: null, failure: "overflow" };
  return { text: out.slice(0, split), failure: null };
}

/**
 * A marker-guarded read of a post-paid document. Every outcome other than
 * `ran` is an explicit unknown whose message NAMES the observation, so an
 * operator can tell "the slot was replaced" from "the slot stopped" — the
 * collection is fail-closed either way (QC1 F-002).
 */
async function boundedRead(
  sandbox: ReviewSandbox,
  marker: string,
  command: ShellCommand,
  timeoutMs: number,
): Promise<BoundedRead>;
async function boundedRead(
  sandbox: ReviewSandbox,
  marker: string,
  command: ShellCommand,
  timeoutMs: number,
  provesAbsence: true,
): Promise<ReportBoundedRead>;
async function boundedRead(
  sandbox: ReviewSandbox,
  marker: string,
  command: ShellCommand,
  timeoutMs: number,
  provesAbsence = false,
): Promise<ReportBoundedRead> {
  let read: MarkedRun;
  const openedAtMs = Date.now();
  try {
    read = await sandbox.runMarked(marker, command, { timeout: timeoutMs });
  } catch (err) {
    // Same contract as the boundary itself: sanitize against this call's own
    // command, reserve the elapsed suffix, and never echo what cannot be proven.
    read = { kind: "reply-lost", cause: execCause(err, openedAtMs, execSensitiveValues(command)) };
  }
  if (read.kind !== "ran") {
    throw new AttemptUnknownError(
      `the attempt container could not be read (${read.kind})${lostReplyCause(read)} — its result is not collected`,
      "review.paid.reply_lost",
      read.kind === "reply-lost" ? read.cause : undefined,
    );
  }
  if (read.exitCode !== 0) return { text: null, failure: "unreadable" };
  return provesAbsence ? parseBoundedRead(read.stdout, true) : parseBoundedRead(read.stdout);
}

function boundedStatusText(value: unknown): string | null {
  return typeof value === "string"
    ? redactSecrets(value).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS)
    : null;
}

function parseRecheckStatus(text: string | null, headSha: string): RecheckStatus | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    if (value["schema"] !== "mstar.recheck-status/v1" || value["headSha"] !== headSha) return null;
    const outcome = value["outcome"];
    if (outcome !== "ok" && outcome !== "skipped" && outcome !== "failed") return null;
    const rejectedRowIds = Array.isArray(value["rejected_row_ids"])
      ? value["rejected_row_ids"].filter((id): id is string => typeof id === "string")
      : [];
    const rejectedUnnamed = value["rejected_unnamed"];
    return {
      schema: "mstar.recheck-status/v1",
      headSha,
      outcome,
      rejected: rejectedRowIds.length,
      rejected_row_ids: rejectedRowIds,
      rejected_unnamed:
        typeof rejectedUnnamed === "number" && Number.isInteger(rejectedUnnamed) && rejectedUnnamed >= 0
          ? rejectedUnnamed
          : 0,
      reason: isRecheckStatusReason(value["reason"]) ? value["reason"] : null,
      error: boundedStatusText(value["error"]),
    };
  } catch {
    return null;
  }
}

/**
 * Bounded read + validation of the runner's recheck output:
 * the audited fixed-path command (`src/pipeline/gitops.ts`
 * `readRecheckCommand`) emits `<content>\n<overflow-flag>` where the flag is
 * `wc -c`'s own output, i.e. NEWLINE-TERMINATED (`…\n0\n` / `…\n1\n`). The
 * flag is therefore read off the last non-empty line after the trailing
 * newline(s) are dropped — a transport that preserves or trims that final
 * newline parses identically. Flag `0` = within the byte bound. Anything else
 * (non-zero exit, overflow, malformed JSON, failed validation) is NO recheck:
 * the round proceeds with every selected row conservatively omitted, never a
 * fabricated document.
 *
 * The SAME transport reads the seat's status document, which is what makes a
 * round that produced no usable document attributable in D1 without container
 * stderr. Rows `validateRecheckDoc` dropped come back as `rejected` so the
 * reconciliation can name them `invalid-output` instead of `omitted` — but the
 * written document is ALREADY filtered by the seat, so a second validation
 * pass sees no drops; the status's `rejected_row_ids` is the only surviving
 * record of them and is therefore the primary source. It is trusted only for
 * the row IDs this round actually sent. A drop that carried no usable rowId
 * cannot be named: the status's `rejected_unnamed` count is the record of it,
 * and the reconciliation attributes those drops by position among the
 * sent-but-unanswered rows. The two sources are unioned by taking the larger
 * count, since the seat filters its document before writing it.
 */
export type RecheckRead = {
  doc: RecheckDoc | null;
  docFailure: string | null;
  rejected: ReadonlySet<string>;
  anonymousRejectedRows: number;
  status: RecheckStatus | null;
};

async function readRecheckDoc(
  sandbox: ReviewSandbox,
  marker: string,
  recheckInput: RecheckInput,
): Promise<RecheckRead> {
  const [docRead, statusRead] = await Promise.all([
    boundedRead(sandbox, marker, readRecheckCommand(RECHECK_OUTPUT_PATH), POST_RUNNER_READ_TIMEOUT_MS),
    boundedRead(sandbox, marker, readRecheckStatusCommand(), POST_RUNNER_READ_TIMEOUT_MS),
  ]);
  let doc: RecheckDoc | null = null;
  const docText = docRead.text !== null && docRead.text.trim() !== "" ? docRead.text : null;
  let docFailure: string | null =
    docRead.failure ?? (docRead.text !== null && docText === null ? "absent" : null);
  const droppedRowIds = new Set<string>();
  let anonymousRejectedRows = 0;
  if (docText !== null) {
    try {
      const gate = validateRecheckDoc(JSON.parse(docText), recheckInput);
      if (gate.ok) {
        doc = gate.doc;
        docFailure = null;
        for (const row of gate.rejected) {
          if (row.rowId === null) anonymousRejectedRows += 1;
          else droppedRowIds.add(row.rowId);
        }
      } else {
        docFailure = `invalid-document: ${gate.error}`;
      }
    } catch {
      docFailure = "invalid-document: not JSON";
    }
  }
  const status = parseRecheckStatus(statusRead.text, recheckInput.headSha);
  const sent = new Set(recheckInput.targets.map((target) => target.rowId));
  const rejected = new Set(droppedRowIds);
  const answeredRowIds = new Set((doc?.results ?? []).map((row) => row.rowId));
  for (const rowId of status?.rejected_row_ids ?? []) {
    if (sent.has(rowId) && !answeredRowIds.has(rowId)) rejected.add(rowId);
  }
  const unnamedRejectedRows = Math.max(anonymousRejectedRows, status?.rejected_unnamed ?? 0);
  return { doc, docFailure, rejected, anonymousRejectedRows: unnamedRejectedRows, status };
}

async function readAppliedProvider(
  sandbox: ReviewSandbox,
  marker: string,
  secretValues: string[],
  log: AttemptLog,
  fields: AttemptLogFields,
): Promise<string | null> {
  const read = await boundedRead(
    sandbox,
    marker,
    readReportCommand(APPLIED_MODEL_PATH),
    POST_RUNNER_READ_TIMEOUT_MS,
    true,
  );
  if (read.failure !== null) {
    if (read.failure !== "absent") {
      log.warn({ ...fields, applied_model: read.failure }, `applied-model document ${read.failure}`);
    }
    return null;
  }
  if (read.text === null || read.text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    log.warn({ ...fields, applied_model: "invalid-json" }, "applied-model document is not JSON — left unrecorded");
    return null;
  }
  const value = (parsed as { appliedModel?: unknown } | null)?.appliedModel;
  if (typeof value !== "string") {
    log.warn(
      { ...fields, applied_model: "invalid-document" },
      "applied-model document carries no provider — left unrecorded",
    );
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > APPLIED_MODEL_MAX_CHARS) {
    log.warn(
      { ...fields, applied_model: "invalid-document" },
      "applied-model document exceeds the provider bound — left unrecorded",
    );
    return null;
  }
  const redacted = redactExactSecrets(redactSecrets(trimmed), secretValues).trim();
  if (!APPLIED_MODEL_PATTERN.test(redacted)) {
    log.warn(
      { ...fields, applied_model: "invalid-document" },
      "applied-model document does not name a provider/model pair — left unrecorded",
    );
    return null;
  }
  return redacted;
}

async function readReportDoc(
  sandbox: ReviewSandbox,
  marker: string,
  secretValues: string[],
  expectedHeadSha: string,
  log: AttemptLog,
  fields: AttemptLogFields,
): Promise<ReportDoc | null> {
  const read = await boundedRead(sandbox, marker, readReportCommand(), POST_RUNNER_READ_TIMEOUT_MS, true);
  if (read.failure !== null) {
    log.warn(
      { ...fields, report_doc: read.failure },
      `report document ${read.failure} — sections render none`,
    );
    return null;
  }
  if (read.text === null || read.text.trim() === "") {
    log.warn({ ...fields, report_doc: "empty" }, "report document empty — sections render none");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    log.warn({ ...fields, report_doc: "invalid-json" }, "report document is not JSON — sections render none");
    return null;
  }
  const redact = (text: string) => redactExactSecrets(redactSecrets(text), secretValues);
  const gate = validateReportDoc(parsed);
  if (!gate.ok) {
    const error = redact(gate.error);
    log.warn(
      { ...fields, report_doc: "invalid-document", report_doc_error: error },
      `report document failed its gate — sections render none: ${error}`,
    );
    return null;
  }
  if (gate.doc.headSha !== expectedHeadSha) {
    log.warn(
      {
        ...fields,
        report_doc: "stale-head",
        report_doc_head_sha: gate.doc.headSha,
      },
      `report document is bound to head ${gate.doc.headSha}, not the reviewed head ${expectedHeadSha} — sections render none`,
    );
    return null;
  }
  return {
    schema: "mstar.report/v1",
    headSha: gate.doc.headSha,
    overview: redact(gate.doc.overview),
    linkedIssueAc: redact(gate.doc.linkedIssueAc),
    verified: redact(gate.doc.verified),
    rejected: redact(gate.doc.rejected),
    planToFix: redact(gate.doc.planToFix),
  };
}

const HARNESS_ROOT = "/opt/mstar-harness";
const OMP_AGENT_DIR = "/opt/omp-agent";

/**
 * Per-App AI configuration for the runner exec env. `keys` maps provider id
 * to decrypted key pools in store order; modelChain is the verbatim stored
 * selector chain. Missing chains or keyless chain providers fail closed.
 */
export type RunnerAppConfig = {
  keys: Record<string, string[]>;
  modelChain: string | null;
};

/**
 * The effective model selector chain for one message plus WHERE it came from.
 * AL-24-5 zero global fallback: the App's verbatim non-blank chain is the ONLY
 * source. A falsy/whitespace-only chain = unset (input bounds) →
 * `chain: undefined` (unreachable on the production path: the fail-closed
 * assertAppConfigComplete gate rejects a chain-less App before the
 * runner/put steps; the undefined shape survives only for direct unit calls
 * to this single-point parser). `fromApp` is always true. This is THE chain
 * single source — used by the runner exec env and the version-record put, so
 * the recorded model can never drift from the chain the runner actually saw.
 */
export function effectiveModelChain(
  appCfg: RunnerAppConfig | undefined,
): { chain: string | undefined; fromApp: boolean } {
  const appChain =
    typeof appCfg?.modelChain === "string" && appCfg.modelChain.trim() !== ""
      ? appCfg.modelChain
      : undefined;
  if (appChain !== undefined) return { chain: appChain, fromApp: true };
  return { chain: undefined, fromApp: true };
}

/**
 * The head (primary) selector of an effective chain — the version record
 * written to `reviews.model`. Comma-separated, trimmed,
 * empty segments dropped (the same grammar as the runner-side selector
 * parse). No chain → NULL — reachable only from direct unit calls: on the
 * production path assertAppConfigComplete fail-closes any App whose chain
 * is missing or parses to zero selectors (AL-24-5), so a successful put
 * never records NULL (the in-image DEFAULT_MODEL_PATTERN scaffold is
 * unreachable from the consumer).
 */
export function chainHeadSelector(chain: string | undefined): string | null {
  if (chain === undefined) return null;
  for (const segment of chain.split(",")) {
    const selector = segment.trim();
    if (selector !== "") return selector;
  }
  return null;
}

function toRunnerCustomProvider(provider: CustomProviderConsumerConfig): CustomProviderDeclaration {
  const declaration: CustomProviderDeclaration = {
    provider_id: provider.provider_id,
    base_url: provider.base_url,
    api: provider.api,
    model_ids: [...provider.model_ids],
  };
  const catalog = catalogLimitsFor(provider.provider_id);
  const meta: CustomProviderModelsMeta = {};
  for (const modelId of provider.model_ids) {
    const declared = provider.models_meta?.[modelId];
    const resolved = resolveModelSize(declared, catalog?.[modelId]);
    const entry: CustomProviderModelMeta = {};
    if (resolved.contextWindow !== undefined) entry.contextWindow = resolved.contextWindow;
    if (resolved.maxTokens !== undefined) entry.maxTokens = resolved.maxTokens;
    if (declared?.name !== undefined) entry.name = declared.name;
    if (declared?.reasoning !== undefined) entry.reasoning = declared.reasoning;
    if (declared?.input !== undefined) entry.input = [...declared.input];
    if (Object.keys(entry).length > 0) meta[modelId] = entry;
  }
  if (Object.keys(meta).length > 0) declaration.models_meta = meta;
  return declaration;
}

function buildRunnerEnv(appCfg: RunnerAppConfig): Record<string, string> {
  const runnerEnv: Record<string, string> = {
    HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
  };
  const { chain } = effectiveModelChain(appCfg);
  if (chain !== undefined) {
    runnerEnv.OMP_REVIEW_MODEL = chain;
  }
  return runnerEnv;
}

/**
 * safety: Build the runner's credential transport: the versioned stdin payload
 * (packages/shared/src/credential-payload) plus the exact key VALUES it carries — the
 * SEC-01 exact-redaction list. ONE resolution serves both, so the recorded
 * secret list can never drift from the keys the session actually saw.
 *
 * Provider id (the App-config key space) → ordered pool, in store order: the
 * allowlisted BYOK ids first, then the App's custom declarations. Blank values
 * never ride, and a pool with none left is not transported at all. `payload`
 * is `undefined` when nothing was transported (the keyless run shape). Key
 * values live only in this payload and are never logged.
 */
function buildRunnerCredentials(
  appCfg: RunnerAppConfig,
  log?: AttemptLog,
  fields?: AttemptLogFields,
  customProviders?: readonly CustomProviderConsumerConfig[],
): { payload: string | undefined; keyValues: string[] } {
  const emit = log !== undefined && fields !== undefined;
  const pools: CredentialPools = {};
  const keyValues: string[] = [];
  let appKeys = 0;
  const addPool = (provider: string, rawKeys: readonly string[], source: "app" | "custom"): number => {
    const keys = rawKeys.filter((key) => key.trim() !== "");
    if (keys.length === 0) return 0;
    pools[provider] = keys;
    keyValues.push(...keys);
    if (emit) {
      log.info(
        { ...fields, provider, key_source: source },
        `provider key pool from App config: ${provider} (${keys.length} key(s))`,
      );
    }
    return keys.length;
  };
  for (const [provider, keys] of Object.entries(appCfg.keys)) {
    if (providerEnvName(provider) === undefined) {
      if (emit) {
        log.warn(
          { ...fields, provider },
          "stored provider key id is not on the PROVIDERS allowlist — row skipped",
        );
      }
      continue;
    }
    appKeys += addPool(provider, keys, "app");
  }
  for (const decl of customProviders ?? []) {
    if (addPool(decl.provider_id, decl.api_keys, "custom") === 0 && emit) {
      log.warn(
        { ...fields, provider: decl.provider_id, key_source: "custom" },
        "custom provider key pool is empty — no keys transported",
      );
    }
  }
  if (emit) {
    const customCount = customProviders?.length ?? 0;
    log.info(
      { ...fields, config_source: "app" },
      `per-App credential payload: ${appKeys} provider key(s) from App config, ${customCount} custom` +
        `${effectiveModelChain(appCfg).chain !== undefined ? ", model chain from App config" : ""}`,
    );
  }
  return {
    payload: Object.keys(pools).length === 0 ? undefined : encodeCredentialPayload(pools),
    keyValues,
  };
}

const RUNNER_EXEC_ENV_PASSTHROUGH_NAMES: readonly string[] = [
  "OMP_REVIEW_MODEL",
  "HARNESS_PLUGIN_ROOT",
  "PI_CODING_AGENT_DIR",
];

/**
 * The ACTUAL secret values one review session carried (SEC-01 exact-value
 * defense): every provider key the credential payload transported — the values
 * a prompt-injected model could echo verbatim — plus the installation token
 * minted for the session. `redactExactSecrets` removes them even when they
 * evade every shape pattern. The key list is the SAME resolution the runner
 * exec used (no re-resolution split-brain). The exec env adds nothing here: it
 * carries only the names in `RUNNER_EXEC_ENV_PASSTHROUGH_NAMES`.
 */
function sessionSecretValues(runnerEnv: Record<string, string>, keyValues: readonly string[], token: string): string[] {
  const values: string[] = [token, ...keyValues];
  for (const [name, value] of Object.entries(runnerEnv)) {
    if (RUNNER_EXEC_ENV_PASSTHROUGH_NAMES.includes(name)) continue;
    if (value !== "") values.push(value);
  }
  return values;
}

/** Characters of an exec's stderr tail carried by its failure message. */
export const STDERR_TAIL_MAX = 600;

/** Bound on a stage name — the runner's vocabulary is short words, never a payload. */
const STAGE_NAME_MAX_CHARS = 60;

/**
 * The LAST `{"event":"review_stage","stage":"…"}` line the runner wrote, or
 * `undefined` when it wrote none. This is the one answer to "where did the
 * review stop?" that needs no dashboard: the runner traces each stage to
 * stderr, and a budget stop or a lost reply otherwise says only that time ran
 * out.
 *
 * Read line by line, last match wins: a stage line is one JSON object on its
 * own line, and the LAST one is the last stage the runner ENTERED — the trace
 * marks entry, not completion, so a failure inside that stage (or after it)
 * names the stage that started last, never one proven to have been running.
 * A malformed line, a non-string stage or an empty one is skipped rather than
 * ending the scan — the earlier stage is still better evidence than nothing.
 *
 * The stage is runner-controlled text, so it gets the SAME two-layer redaction
 * the stderr tail gets: shape patterns (`redactSecrets`) AND every exact session
 * secret the exec carried (`secretValues`). A stage that happens to BE a
 * credential — or to contain one verbatim — cannot leak through this field. The
 * result is bounded, because the line is attacker-influenced text.
 */
export function lastRunnerStage(stderr: string, secretValues: readonly string[] = []): string | undefined {
  let stage: string | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("review_stage")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A stage trace split across lines (or interleaved with other output) is
      // not this event; an earlier complete one still stands.
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const { event, stage: candidate } = parsed as { event?: unknown; stage?: unknown };
    if (event !== "review_stage" || typeof candidate !== "string") continue;
    const bounded = redactExactSecrets(redactSecrets(candidate), secretValues).trim().slice(0, STAGE_NAME_MAX_CHARS);
    if (bounded !== "") stage = bounded;
  }
  return stage;
}

/**
 * The text a failure message appends for an already-redacted stage. Derived from
 * the ONE parse above: a caller that needs both the field and the sentence reads
 * stderr once and passes the result here, so the two can never disagree. The
 * sentence says "last stage", not "running stage": the trace marks entry.
 */
export function lastStageNote(stage: string | undefined): string {
  return stage === undefined ? "" : ` (last stage: ${stage})`;
}

/**
 * The `last_stage` log field, spreadable into every settlement line. Absent
 * when no stage was traced: an empty field would claim a stage nobody observed.
 * The value is shape-redacted again HERE because a throw site can carry a stage
 * it did not obtain from `lastRunnerStage`, and this is the last boundary before
 * the field reaches a durable log line.
 */
export function lastStageField(stage: string | undefined): { last_stage?: string } {
  return stage === undefined ? {} : { last_stage: redactSecrets(stage) };
}

function runnerFailureDetail(
  run: { stdout: string; stderr: string; exitCode: number },
  secretValues: readonly string[],
  lastStage: string | undefined,
): string {
  const base = `runner failed: exit ${run.exitCode}, stdout ${new TextEncoder().encode(run.stdout).length}B`;
  const tail = redactExactSecrets(redactSecrets(run.stderr), secretValues).trim().slice(-STDERR_TAIL_MAX);
  const detail = tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
  return `${detail}${lastStageNote(lastStage)}`;
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The cause suffix a lost reply's message carries. The boundary hands back
 * bounded evidence (error name, message, elapsed time) or nothing; this never
 * invents text, so an older outcome keeps its exact wording.
 */
function lostReplyCause(read: { kind: string; cause?: string }): string {
  return read.cause === undefined ? "" : ` — ${read.cause}`;
}

/**
 * Run one marker-guarded command and hand back the RAW outcome. The three
 * callers below map the same closed set differently because the D1 row gives
 * each of them a different entitlement (prepare: nothing paid; review entry:
 * nothing paid yet; paid exec: row `launched`).
 */
async function markedCommand(
  sandbox: ReviewSandbox,
  marker: string,
  command: ShellCommand,
  opts?: { env?: Record<string, string>; cwd?: string; timeout?: number; deadlineEpochMs?: number; stdin?: string },
): Promise<MarkedRun> {
  const openedAtMs = Date.now();
  try {
    return await sandbox.runMarked(marker, command, opts);
  } catch (err) {
    // An RPC that never answered is an issued exec with no reply. The cause gets
    // the boundary's own sanitize+bound policy, so a rejection cannot smuggle an
    // unbounded or command-bearing message past it.
    return { kind: "reply-lost", cause: execCause(err, openedAtMs, execSensitiveValues(command, opts)) };
  }
}

/**
 * A prepare-phase command on the slot `provision` just declared. UNGUARDED by
 * design (D2): provision ran inside the DO's exclusive gate and is the only
 * thing that speaks for the slot's disk, so a plain exec is enough. A slot that
 * stopped since then is a TRANSIENT `ContainerNotRunningError` — the next entry
 * re-provisions from scratch, and the D1 row still proves nothing paid can be
 * lost. A read fault is an ordinary error, which the platform retries too.
 */
async function runPreparedCommand(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  opts?: { env?: Record<string, string>; cwd?: string; timeout?: number; deadlineEpochMs?: number; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return sandbox.runCommand(command, opts);
}

/**
 * A pre-paid command at the review step's own entry. The row is `provisioned`,
 * so a slot that stopped or was replaced means the attempt cannot continue —
 * but nothing was charged. `reply-lost` and `retired` stay explicit unknowns:
 * neither proves that nothing runs (§3.2, review-entry column).
 */
async function runReviewEntryCommand(
  sandbox: ReviewSandbox,
  marker: string,
  command: ShellCommand,
  opts?: { env?: Record<string, string>; cwd?: string; timeout?: number; deadlineEpochMs?: number; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const read = await markedCommand(sandbox, marker, command, opts);
  switch (read.kind) {
    case "ran":
      return { stdout: read.stdout, stderr: read.stderr, exitCode: read.exitCode };
    case "deadline-spent":
      throw new Error("the exec deadline was spent before the runner input write started");
    case "not-running":
    case "marker-mismatch":
      throw new ContainerLostBeforePaidError(
        `the attempt container did not carry this attempt's preparation (${read.kind}) — nothing was charged, a new attempt runs`,
      );
    case "marker-unreadable":
    case "reply-lost":
      throw new AttemptUnknownError(
        `the attempt container could not be read at the review step (${read.kind})${lostReplyCause(read)} — nothing may be concluded`,
        "review.paid.reply_lost",
        read.kind === "reply-lost" ? read.cause : undefined,
      );
    case "retired":
      throw new AttemptUnknownError(
        "the attempt's slot is retired — nothing may run on it and nothing is charged",
        "review.container.retired",
      );
    default:
      return noMarkedOutcome(read);
  }
}

/**
 * The PAID exec. The marker proof precedes the exec, so every proof outcome
 * proves the paid exec was never issued: that is a confirmed no-result, not a
 * lost reply. Only `reply-lost` leaves the child possibly alive, and only
 * `deadline-spent` is a cap stop (§3.2, paid-runner column).
 */
async function runPaidCommand(
  sandbox: ReviewSandbox,
  marker: string,
  command: ShellCommand,
  opts:
    | { env?: Record<string, string>; cwd?: string; timeout?: number; deadlineEpochMs?: number; stdin?: string }
    | undefined,
  log: AttemptLog,
  fields: AttemptLogFields,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const read = await markedCommand(sandbox, marker, command, opts);
  switch (read.kind) {
    case "ran":
      return { stdout: read.stdout, stderr: read.stderr, exitCode: read.exitCode };
    case "deadline-spent":
      throw new ExecDeadlineRefusedError(read.remainingMs);
    case "not-running":
    case "marker-mismatch":
    case "marker-unreadable":
    case "retired":
      throw new ContainerLostAfterClaimError(
        `the attempt container was lost after its launch was claimed (${read.kind}) — the paid exec was never sent`,
      );
    case "reply-lost":
      // The cause rides the message AND its own field: the message is what an
      // operator reads on the PR page, the field is what a log query filters.
      log.warn(
        read.cause === undefined
          ? { ...fields }
          : { ...fields, exec_cause: read.cause },
        "paid exec reply lost — the process may still be running",
      );
      throw new AttemptUnknownError(
        `the paid exec was issued and its reply was lost${lostReplyCause(read)} — the process may still be running`,
        "review.paid.reply_lost",
        read.cause,
      );
    default:
      return noMarkedOutcome(read);
  }
}

/** Unreachable by construction: the compiler proves every outcome is handled. */
function noMarkedOutcome(outcome: never): never {
  throw new Error(`review sandbox: unhandled marked outcome ${JSON.stringify(outcome)}`);
}

/**
 * The purpose-scoped sandbox read credential, mintable by ANY phase: a step
 * that re-derives its live objects after a restart needs the same repository-
 * scoped, read-only grant the preparing invocation received, and the adapter's
 * own installation-token cache makes the repeat call free.
 */
export async function mintSandboxReadToken(input: {
  payload: ReviewJobPayload;
  commenter: Pick<ReviewCommenter, "getInstallationToken">;
}): Promise<string> {
  const grant = await input.commenter.getInstallationToken({
    scope: {
      appId: input.payload.botRef.appId,
      installationId: input.payload.installation_id,
      owner: input.payload.owner,
      repo: input.payload.repo,
      prNumber: input.payload.pr_number,
    },
    purpose: "sandbox-read",
  });
  assertSandboxGrant(grant, input.payload.repo);
  return grant.token;
}

/**
 * The Check attempt key for a delivery: the attempt identity frozen on the
 * launch row. `null` when the delivery carries no reusable head yet (an
 * issue-comment delivery), in which case the row's key is frozen at the
 * checkout instead.
 */
export function checkKeyOf(payload: ReviewJobPayload, headSha: string | null): string | null {
  if (headSha === null) return null;
  const scope = scopeOfPayload(payload);
  if (scope === undefined) return null;
  return attemptKey({
    appId: scope.appId,
    installationId: scope.installationId,
    owner: scope.owner,
    repo: scope.repo,
    prNumber: scope.pr_number,
    headSha,
    triggeredBy: payload.triggered_by,
    action: payload.action,
  });
}

function scopeOfPayload(payload: ReviewJobPayload): { appId: string; installationId: number; owner: string; repo: string; pr_number: number } | undefined {
  const bot = payload.botRef as { appId?: string } | undefined;
  if (bot?.appId === undefined) return undefined;
  return {
    appId: bot.appId,
    installationId: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
  };
}

/**
 * The attempt's observed head is not the head its identity was frozen for. The
 * old attempt is settled as SKIPPED and this error starts a new one (the queue
 * redelivers under a fresh attempt id); nothing is reviewed under the old
 * identity.
 */
export class MovedHeadError extends Error {
  constructor(
    readonly attemptId: string,
    readonly frozenKey: string,
    readonly observedKey: string,
  ) {
    super(
      `attempt ${attemptId}: the observed head is not the frozen one (${frozenKey} ≠ ${observedKey}) — settled as skipped, a new attempt owns this head`,
    );
    this.name = "MovedHeadError";
  }
}

/**
 * Acquire the attempt's container, mint its purpose-scoped read credential,
 * clone the PR head and resolve the AUTHORITATIVE checkout SHA. The caller's
 * failure path reads `progress.failureStage` and `progress.secretValues`, so
 * both are updated in place as the steps advance.
 *
 * EVERY entry provisions from scratch. The D1 row is the authority to start —
 * `provisioned`, `launched_at_ms IS NULL`, `revoked_ms IS NULL` — and that row
 * proves nothing paid can be lost, so a stopped or undeclared slot is a free
 * retry rather than an unknown. A fresh disk means every retry re-clones; the
 * marker is written by `provision` and is never repaired by a later step.
 *
 * `runnerCutoffMs` is the attempt's derived pre-runner cutoff: one absolute
 * deadline bounds start + inactivity setting + readiness + marker write, capped
 * by the existing git step bound.
 */
export async function prepareReviewAttempt(input: {
  payload: ReviewJobPayload;
  deps: {
    env: { SANDBOX: unknown; DB: D1Like };
    getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  };
  commenter: Pick<ReviewCommenter, "getInstallationToken">;
  attemptId: string;
  identity: AttemptIdentity | null;
  sandbox: ReviewSandbox | null;
  onSandbox: (sandbox: ReviewSandbox) => void;
  progress: ReviewAttemptProgress;
  /**
   * The attempt's derived pre-runner cutoff. REQUIRED: provisioning is the one
   * step that must not invent its own window, or a cold start can overrun the
   * preparation budget and still be reported as provisioned.
   */
  runnerCutoffMs: number;
}): Promise<PreparedReviewAttempt> {
  const { payload, deps, commenter, attemptId, progress } = input;
  let sandbox = input.sandbox;
  try {
    const provisioning = await claimReviewAttempt(deps.env.DB, attemptId, Date.now(), input.identity);
    if (provisioning === "already-claimed" && input.identity !== null) {
      const existing = await readAttemptIdentity(deps.env.DB, attemptId);
      if (existing === null) {
        if (!(await freezeAttemptIdentity(deps.env.DB, attemptId, input.identity))) {
          const winner = await readAttemptIdentity(deps.env.DB, attemptId);
          throw new MovedHeadError(
            attemptId,
            winner?.key ?? "another caller's head",
            input.identity.key,
          );
        }
      } else if (
        existing.key !== input.identity.key ||
        existing.generation !== input.identity.generation
      ) {
        throw new MovedHeadError(attemptId, existing.key, input.identity.key);
      }
    }
  } catch (err) {
    if (err instanceof MovedHeadError) throw err;
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the provisioning claim could not be read back (${detail}) — nothing is provisioned for it`,
      "review.container.unavailable",
    );
  }
  const gate = await readProvisionGate(deps.env.DB, attemptId);
  if (gate === "retired") {
    throw new AttemptRetiredError(
      `attempt ${attemptId}: its slot is retired — nothing may ever start on it`,
    );
  }
  if (gate !== "may-provision") {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: its launch row is ${gate}, so no container may be provisioned for it`,
      "review.container.unavailable",
    );
  }
  if (sandbox === null) {
    progress.failureStage = "sandbox";
    sandbox = await reviewAttemptSandbox(deps, attemptId);
    input.onSandbox(sandbox);
  }
  const marker = attemptMarker(attemptId);
  const provisionMs = boundedStepTimeout(
    input.runnerCutoffMs ?? Date.now() + EXEC_TIMEOUT_GIT_MS,
    EXEC_TIMEOUT_GIT_MS,
    "container provisioning",
    "preparation",
  );
  progress.failureStage = "sandbox";
  const provisioned = await sandbox.provision(marker, { deadlineEpochMs: Date.now() + provisionMs });
  if (provisioned.kind === "retired") {
    throw new AttemptRetiredError(
      `attempt ${attemptId}: its slot is retired — nothing may ever start on it`,
    );
  }
  if (provisioned.kind === "misconfigured") {
    // A missing image is setup, not weather: retrying re-reads the same absent
    // binding forever, so it settles as a terminal configuration fault.
    throw new ConfigUnresolvedError(
      `attempt ${attemptId}: no container image is bound for its slot — nothing was started`,
    );
  }
  if (provisioned.kind === "unavailable") {
    throw new ContainerUnavailableError(
      `attempt ${attemptId}: its container could not be provisioned inside ${provisionMs}ms — nothing is proven, the next entry re-provisions it`,
    );
  }
  progress.failureStage = "pipeline";
  const token = await mintSandboxReadToken({ payload, commenter });
  progress.secretValues = [token];
  progress.failureStage = "sandbox";
  const cmds = buildGitOpsCommands({
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
    cloneDir: CLONE_DIR,
    diffPath: DIFF_PATH,
  });

  const clone = await runPreparedCommand(sandbox, cmds.clone, {
    env: gitTransportEnv(token),
    timeout: EXEC_TIMEOUT_GIT_MS,
  });
  if (clone.exitCode !== 0) {
    throw new Error(`clone failed: exit ${clone.exitCode}, stdout ${clone.stdout.length}B`);
  }

  const rev = await runPreparedCommand(sandbox, cmds.checkedOutSha, {
    timeout: EXEC_TIMEOUT_GIT_MS,
  });
  if (rev.exitCode !== 0 || rev.stdout.trim() === "") {
    throw new Error(`cannot resolve head sha: git exit ${rev.exitCode}, stdout ${rev.stdout.length}B`);
  }
  return { sandbox, token, cmds, headSha: rev.stdout.trim() };
}

/**
 * `runReviewAttempt` takes the prepared checkout, writes the runner input,
 * makes the blocking paid call at the attempt's absolute deadline and collects
 * the result documents. The caller's failure path reads the same
 * `progress` object, so a throw still carries the runner stage, its start
 * instant and the session's exact secret values.
 *
 * The attempt's row fences the paid step: this function claims `launched` in
 * one conditional statement before the call, so a lost reply, a retried entry
 * or a restart finds the row already launched and refuses a second launch as
 * `unknown`. After the paid call returns, the collected result and the
 * completion are written in ONE statement; a result that cannot be made durable
 * leaves the attempt `launched` and refuses to confirm completion.
 */
export async function runReviewAttempt(input: {
  deps: { log: AttemptLog; env: { DB: D1Like; DASHBOARD_ENCRYPTION_KEY?: string } };
  /** The absolute instant the exec is killed at (`anchorRunnerBudget`'s end). */
  deadlineMs: number;
  sandbox: ReviewSandbox;
  headSha: string;
  token: string;
  level: ReviewLevel;
  appCfg: RunnerAppConfig;
  fields: AttemptLogFields;
  reconFacts: readonly string[];
  modelOverrides: Record<string, string> | undefined;
  customProviders: readonly CustomProviderConsumerConfig[] | undefined;
  recheckInput: RecheckInput | undefined;
  recheckAssignmentMaxBytes: number | undefined;
  prContext: PrContext | undefined;
  runnerAnchor: RunnerBudgetAnchor;
  observedChangedLines: number | null;
  progress: ReviewAttemptProgress;
  attemptId: string;
}): Promise<ReviewAttemptExecution> {
  const {
    deps,
    deadlineMs,
    sandbox,
    headSha,
    token,
    level,
    appCfg,
    fields,
    reconFacts,
    modelOverrides,
    customProviders,
    recheckInput,
    recheckAssignmentMaxBytes,
    prContext,
    runnerAnchor,
    observedChangedLines,
    progress,
    attemptId,
  } = input;
  let entry: LaunchVerdict;
  try {
    entry = launchVerdict(await readReviewLaunch(deps.env.DB, attemptId));
  } catch (err) {
    // An already-classified unknown (an undecodable persisted result) keeps its
    // own code: a fresh read fault must not overwrite a fact this row already proves.
    if (err instanceof AttemptUnknownError) throw err;
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    deps.log.warn({ ...fields, error: detail }, "launch row unreadable — the paid step is not taken");
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the launch row could not be read — the paid step is not taken`,
      "review.container.unavailable",
    );
  }
  switch (entry.kind) {
    case "persisted":
      progress.runnerReturned = true;
      return entry.execution;
    case "never-paid":
      break;
    case "paid-unknown":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: its paid step was already launched and its result is not durable — refusing a second launch`,
        "review.paid.reply_lost",
      );
    case "paid-failed":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: its paid step returned a failure — refusing a second launch`,
        "review.container.lost_after_claim",
      );
    case "owned-by-cleanup":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: a cleanup owns this container's destruction — refusing to run the paid step on it`,
        "review.container.lost_before_paid",
      );
    case "unrecognised":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: its launch row is in a state this build cannot interpret — refusing the paid step`,
        "review.container.lost_before_paid",
      );
    case "never-claimed":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: it holds no provisioning claim — nothing was launched for it`,
        "review.container.lost_before_paid",
      );
    default:
      return noLaunchState(entry);
  }
  const runnerInput = {
    worktreePath: CLONE_DIR,
    reconFacts,
    capabilityHosts: [],
    outerDeadlineEpochMs: deadlineMs,
    ...(modelOverrides !== undefined ? { modelOverrides } : {}),
    ...(customProviders !== undefined
      ? { customProviders: customProviders.map(toRunnerCustomProvider) }
      : {}),
    ...(recheckInput !== undefined ? { recheck: recheckInput } : {}),
    ...(recheckAssignmentMaxBytes !== undefined ? { recheckAssignmentMaxBytes } : {}),
    ...(prContext !== undefined ? { prContext } : {}),
  };
  const runnerInputStdin = toBase64Utf8(JSON.stringify(runnerInput));
  const inputWriteWindowMs = deadlineMs - Date.now();
  const writeInput = await runReviewEntryCommand(
    sandbox,
    attemptMarker(attemptId),
    writeJsonCommand(RUNNER_INPUT_PATH),
    {
      stdin: runnerInputStdin,
      timeout: boundedStepTimeout(
        deadlineMs,
        EXEC_TIMEOUT_GIT_MS,
        "runner input write",
        "runner",
        deadlineMs - inputWriteWindowMs,
      ),
    },
  );
  if (writeInput.exitCode !== 0) {
    if (writeInput.exitCode === 124 && inputWriteWindowMs <= EXEC_TIMEOUT_GIT_MS) {
      throw new BudgetExhaustedError(
        {
          kind: "budget-exhausted",
          cause: "sandbox-kill",
          tier: level,
          budgetWindow: "runner",
          budgetMs: runnerAnchor.effectiveBudgetMs,
          seatsDispatched: 0,
          seatsStopped: 0,
          changedLines: observedChangedLines,
        },
        "runner input write killed at the anchored runner deadline",
      );
    }
    throw new Error(`runner input write failed: exit ${writeInput.exitCode}`);
  }

  progress.failureStage = "runner";
  const runnerEnv = buildRunnerEnv(appCfg);
  const credentials = buildRunnerCredentials(appCfg, deps.log, fields, customProviders);
  progress.secretValues = sessionSecretValues(runnerEnv, credentials.keyValues, token);
  // SEC-01 resume (I-000685): the exact set this exec is about to hand the model
  // — the provider keys it transports plus the installation token it minted — is
  // sealed HERE, BEFORE the exec: an encryption failure is a PRE-SPEND failure of
  // the paid step (nothing paid, nothing persisted). The ciphertext then rides the
  // POST-SPEND statement that records the result, so a persisted row and its seal
  // are durable together and neither can exist without the other.
  const gateSecretsEnc = await sealGateSecrets(
    deps.env.DASHBOARD_ENCRYPTION_KEY,
    attemptId,
    progress.secretValues,
  );
  // §7.8: with a recheck input the runner gains `--recheck-out` — the seat
  // writes its validated document to the audited fixed path before the
  // envelope reaches stdout. `--report-out` rides whenever the report seat
  // has context to work with.
  const runnerCmd = runnerCommand(
    RUNNER_PATH,
    level,
    RUNNER_INPUT_PATH,
    recheckInput !== undefined ? RECHECK_OUTPUT_PATH : undefined,
    prContext !== undefined ? REPORT_OUTPUT_PATH : undefined,
  );
  const beforeClaimMs = deadlineMs - Date.now();
  if (beforeClaimMs <= 0) {
    throw new RoundBudgetSpent(
      `round budget spent: runner declined — the exec deadline is spent (${beforeClaimMs}ms left for it)`,
      "runner",
    );
  }
  let launch: LaunchClaim;
  try {
    launch = await claimReviewLaunch(deps.env.DB, attemptId, Date.now());
  } catch (err) {
    // The claim reads the row back, so the same rule holds: a classified unknown
    // is not a claim fault.
    if (err instanceof AttemptUnknownError) throw err;
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    deps.log.warn({ ...fields, error: detail }, "launch claim failed — the paid step is not taken");
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the launch claim could not be read back — the paid step is not taken`,
      "review.container.unavailable",
    );
  }
  if (!launch.ok) {
    if (launch.reason === "persisted") {
      progress.runnerReturned = true;
      return launch.execution;
    }
    throw new AttemptUnknownError(
      `attempt ${attemptId}: another entry owns the paid step (${launch.reason}) — refusing a second launch`,
      launch.reason === "failed"
        ? "review.container.lost_after_claim"
        : launch.reason === "already-launched"
          ? "review.paid.reply_lost"
          : "review.container.lost_before_paid",
    );
  }
  const capStop = (reason: string): BudgetExhaustedError =>
    new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "consumer-deadline",
        tier: level,
        budgetWindow: "runner",
        budgetMs: runnerAnchor.effectiveBudgetMs,
        seatsDispatched: 0,
        seatsStopped: 0,
        changedLines: observedChangedLines,
      },
      reason,
    );
  const runnerTimeout = Math.max(0, deadlineMs - Date.now());
  if (runnerTimeout === 0) {
    await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    throw capStop("runner declined after the launch claim — the deadline was spent by the claim");
  }
  progress.runnerStartedAt = Date.now();
  let run: { stdout: string; stderr: string; exitCode: number };
  try {
    run = await runPaidCommand(
      sandbox,
      attemptMarker(attemptId),
      runnerCmd,
      {
        cwd: CLONE_DIR,
        env: runnerEnv,
        ...(credentials.payload === undefined ? {} : { stdin: credentials.payload }),
        deadlineEpochMs: deadlineMs,
      },
      deps.log,
      fields,
    );
  } catch (err) {
    if (err instanceof ContainerLostAfterClaimError) {
      // A proof outcome above the exec proves the paid exec was never issued, so
      // the row may move to `failed` — the same terminal no-result the deadline
      // refusal records.
      progress.runnerStartedAt = undefined;
      await recordReviewFailure(deps.env.DB, attemptId, Date.now());
      throw err;
    }
    if (!(err instanceof ExecDeadlineRefusedError)) throw err;
    progress.runnerStartedAt = undefined;
    await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    throw capStop(
      `runner declined inside the container — the deadline was spent before the exec started (${err.remainingMs}ms left)`,
    );
  }
  progress.runnerReturned = true;
  const runnerElapsedMs = Date.now() - progress.runnerStartedAt;
  // Where the review stopped, once, for every path below: the runner traces each
  // stage to stderr and nothing else on this row can say it.
  const lastStage = lastRunnerStage(run.stderr, progress.secretValues);
  progress.lastStage = lastStage;
  if (run.exitCode === 124) {
    deps.log.warn(
      {
        ...fields,
        stderr_tail: redactExactSecrets(redactSecrets(run.stderr), progress.secretValues).slice(-STDERR_TAIL_MAX),
        ...(lastStage === undefined ? {} : { last_stage: lastStage }),
      },
      "runner exec killed at the anchored deadline (provider stderr on this line only)",
    );
    throw new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "sandbox-kill",
        tier: level,
        budgetWindow: "runner",
        budgetMs: runnerAnchor.effectiveBudgetMs,
        seatsDispatched: null,
        seatsStopped: null,
        changedLines: observedChangedLines,
      },
      `runner exec killed at its deadline: exit 124, stdout ${new TextEncoder().encode(run.stdout).length}B${lastStageNote(lastStage)}`,
      lastStage,
    );
  }
  if (run.exitCode !== 0) {
    // The detail text already names the stage for a reader; the own property
    // carries it as DATA too, so the failure record and its log field get it
    // without anything reparsing the sentence.
    const detail = runnerFailureDetail(run, progress.secretValues, lastStage);
    const failure = new Error(detail);
    if (lastStage !== undefined) (failure as Error & { lastStage?: string }).lastStage = lastStage;
    throw failure;
  }
  deps.log.info(
    {
      ...fields,
      elapsed_ms: runnerElapsedMs,
      ...(lastStage === undefined ? {} : { last_stage: lastStage }),
    },
    `runner finished in ${runnerElapsedMs}ms (budget ${runnerTimeout}ms)`,
  );

  const budgetSignal = parseBudgetExhaustedSignal(run.stdout);
  if (budgetSignal.ok) {
    throw new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "runner-deadline",
        tier: level,
        budgetWindow: "runner",
        budgetMs: runnerAnchor.effectiveBudgetMs,
        seatsDispatched: budgetSignal.signal.seatsDispatched,
        seatsStopped: budgetSignal.signal.seatsStopped,
        changedLines: observedChangedLines,
      },
      `runner signalled budget exhaustion (seats ${budgetSignal.signal.seatsStopped}/${budgetSignal.signal.seatsDispatched})${lastStageNote(lastStage)}`,
      lastStage,
    );
  }

  progress.failureStage = "pipeline";

  const marker = attemptMarker(attemptId);
  const recheck = recheckInput !== undefined ? await readRecheckDoc(sandbox, marker, recheckInput) : null;

  const report: ReportDoc | null =
    prContext !== undefined
      ? await readReportDoc(sandbox, marker, progress.secretValues, headSha, deps.log, fields)
      : null;

  const appliedProvider = await readAppliedProvider(sandbox, marker, progress.secretValues, deps.log, fields);

  const secretValues = progress.secretValues;
  const stdoutRedaction = redactDocument(run.stdout, secretValues, "run");
  const recheckRedaction = redactDocument(recheck, secretValues, "recheck");
  const reportRedaction = redactDocument(report, secretValues, "report");
  const providerRedaction = redactDocument(appliedProvider, secretValues, "text");
  const execution = {
    run: { stdout: stdoutRedaction.value, stderr: "", exitCode: run.exitCode },
    recheck: recheckRedaction.value,
    report: reportRedaction.value,
    appliedProvider: providerRedaction.value,
  };
  let recorded = false;
  try {
    recorded = await completeReviewLaunch(deps.env.DB, attemptId, execution, Date.now(), gateSecretsEnc);
  } catch (err) {
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    deps.log.warn(
      { ...fields, error: detail },
      "launch completion write failed — the result is not confirmed durable",
    );
  }
  if (!recorded) {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the paid result could not be recorded as durable — completion is not confirmed`,
      "review.paid.reply_lost",
    );
  }
  return execution;
}
