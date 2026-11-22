/**
 * One review attempt's execution body. `prepareReviewAttempt` acquires the
 * container and its purpose-scoped credential, clones the PR head and resolves
 * the authoritative checkout SHA; `runReviewAttempt` writes the runner input,
 * makes the blocking paid call and collects the result documents. The queue
 * consumer still drives both — admission, dedupe, skip settlement, the Check
 * seam and publication stay there.
 */

import type { CustomProviderDeclaration, ReviewLevel } from "../../packages/shared/src/runtime";
import { APPLIED_MODEL_MAX_CHARS, APPLIED_MODEL_PATH, APPLIED_MODEL_PATTERN } from "../../packages/shared/src/runtime";
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
import type { D1Like } from "../store/types";
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
import type { MarkedRun, RetentionProof, ReviewSandbox } from "./sandbox";
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
    );
  }
  if (activation.revoked) {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: a successor revoked it, so nothing may start for it again`,
    );
  }
  if (activation.sandboxId === null) {
    throw new AttemptUnknownError(`attempt ${attemptId}: its provisioning row carries no minted container id`);
  }
  try {
    return await deps.getSandbox(deps.env.SANDBOX, activation.sandboxId);
  } catch (err) {
    const detail = redactSecrets(err instanceof Error ? err.message : String(err));
    throw new AttemptUnknownError(
      `attempt ${attemptId}: its container handle could not be resolved (${detail}) — the container's state is unknown`,
    );
  }
}

/** One attempt's activation state, as the provisioning row records it. */
export type AttemptActivation = {
  /** The container id the claim minted; null on a row written before it existed. */
  sandboxId: string | null;
  /** The guarded transition that precedes every start has been won. */
  activated: boolean;
  /** A successor took this attempt's PR: nothing may start again. */
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
 * prepared: its marker is missing or different (a replacement incarnation, a
 * lost container, an unreadable filesystem). Nothing was read or destroyed on
 * that evidence and the outcome is unknown — neither a failure nor a success.
 */
export class AttemptUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptUnknownError";
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
 * or no paid work started). No marker match and no retention proof destroy
 * nothing and report `unknown`, so a replacement incarnation is never torn
 * down and a running paid command never loses its only copy.
 */
export async function discardReviewAttempt(
  sandbox: ReviewSandbox,
  attemptId: string,
  retention: RetentionProof,
): Promise<"destroyed" | "unknown"> {
  return sandbox.destroyMarked(attemptMarker(attemptId), retention);
}

/**
 * The attempt's own row: the only authority to provision its container, the
 * fence in front of the paid step, and the record that the paid step's result
 * is durable. `migrations/0082_review_launches.sql` enforces the identity, the
 * forward-only state machine and the coupling of `persisted` to a stored
 * result; every transition below is ONE conditional statement whose
 * `meta.changes` is the only success signal, so the row — not the caller —
 * decides whether an attempt may provision, launch or record completion.
 *
 * The INSERT is the first-provisioning claim: only the entry whose INSERT
 * created the row may start a container for this attempt. A later entry finds
 * the row held and may never stamp a replacement as the original — not even
 * after a crash before the marker write, which is why the marker is proven,
 * never re-claimed, from the second entry on.
 */
const CLAIM_ATTEMPT_SQL = `
INSERT INTO review_launches (attempt_id, state, claimed_at_ms, attempt_key, attempt_generation, sandbox_id, activated_ms)
VALUES (?, 'provisioned', ?, ?, ?, ?, ?)
ON CONFLICT (attempt_id) DO NOTHING
`;



/**
 * Fill the frozen IDENTITY once — key AND generation — for a delivery that had
 * no head at creation. The CAS is `attempt_key IS NULL`: exactly one winner, and
 * a loser means another caller froze a DIFFERENT head (a moved head), which the
 * caller must settle as skipped, never continue on.
 */
const FREEZE_ATTEMPT_IDENTITY_SQL = `
UPDATE review_launches SET attempt_key = ?, attempt_generation = ?
WHERE attempt_id = ? AND attempt_key IS NULL
`;

const READ_ATTEMPT_IDENTITY_SQL = `SELECT attempt_key, attempt_generation FROM review_launches WHERE attempt_id = ?`;

/** One attempt's frozen Check identity: the key and the generation it belongs to. */
export type AttemptIdentity = { key: string; generation: number };

/**
 * The paid-step fence, taken in the statement that is ABOUT TO SEND the exec:
 * `provisioned` → `launched` only. A row already launched (a replay, a retry,
 * a restart) changes nothing, so no second paid call can start; a row that is
 * still `provisioned` when the exec is about to run means the earlier work
 * (mint, input write) never reached it and the attempt remains releasable.
 */
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
 * The attempt's sealed gate set, or `null` when it carries none (paid before
 * the envelope existed, or sealing was impossible). A store fault throws: the
 * caller must retry, never publish a body it could not scan.
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
 * Destruction CLAIMS the row first: `provisioned → abandoned` in one
 * conditional statement. Only the winner (`meta.changes === 1`) may destroy; a
 * loser means a concurrent attempt moved the row to `launched`, so the
 * container may be paying and cleanup must report `unknown` instead.
 */
const ABANDON_LAUNCH_SQL = `
INSERT INTO review_launches (attempt_id, state, claimed_at_ms, abandoned_at_ms, sandbox_id)
VALUES (?, 'abandoned', ?, ?, ?)
ON CONFLICT (attempt_id) DO UPDATE
   SET state = 'abandoned', abandoned_at_ms = excluded.abandoned_at_ms
 WHERE review_launches.state = 'provisioned'
`;

/**
 * The attempt's owed Check settlement, recorded on the ATTEMPT row and nowhere
 * else. The association is the open Check row's own `attempt_key` AND its
 * `generation` — a key alone names the attempt, so an older generation's mark
 * could match a newer row — and `check_owed_ms` is the obligation's own due
 * instant. Written only while that generation has NOT concluded.
 */
const NOTE_CHECK_OWED_SQL = `
UPDATE review_launches
SET check_owed_ms = ?, check_key = ?, check_generation = ?
WHERE attempt_id = ? AND check_owed_ms IS NULL
  AND EXISTS (
    SELECT 1 FROM review_checks c
     WHERE c.attempt_key = ? AND c.generation = ? AND c.terminal_ms IS NULL
  )
`;

/** Advance the obligation's due instant — the same backoff the Check row uses. */
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

/**
 * Housekeeping for the marks whose conclusion already landed: a holder that
 * terminated the Check, or a clear that faulted, leaves a mark whose Check row
 * is terminal. Clearing it is idempotent and retried on EVERY pass, so the
 * obligation cannot stay set after a conclusion.
 */
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
  /**
   * A row this build cannot interpret — an unrecognised state, or a state whose
   * coupled facts are missing. It is NEVER `null`: "no row" means nothing was
   * ever claimed, while `unknown` means a row exists that this code must not
   * reason about.
   */
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
  /**
   * The identity frozen at creation — key AND generation — or `null` when this
   * delivery had no admitted claim (the freeze then happens at the checkout).
   */
  identity: AttemptIdentity | null,
): Promise<"claimed" | "already-claimed"> {
  const written = await db
    .prepare(CLAIM_ATTEMPT_SQL)
    .bind(attemptId, nowMs, identity?.key ?? null, identity?.generation ?? null, attemptSandboxId(attemptId), nowMs)
    .run();
  return written.meta.changes === 1 ? "claimed" : "already-claimed";
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
  // A zero-row claim carries no cause, so the refusal costs one read — only on
  // the refusal path, and only to name it. It never decides anything.
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
      // No row, or a row a concurrent caller already moved past `provisioned`.
      return { ok: false, reason: "no-claim" };
    case "owned-by-cleanup":
      // A cleanup claimed this attempt for destruction: the paid step must not
      // start on a container that is being removed.
      return { ok: false, reason: "no-claim" };
    case "unrecognised":
      // A row this build cannot interpret: no launch may be taken on it.
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
  // The bump goes FIRST, so a defer that then fails or loses its fence cannot
  // leave the obligation silently un-advanced: it is compensated by clearing the
  // mark. Neither error is swallowed — a bump fault is the caller's failed
  // defer, and a defer fault propagates after the compensation.
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
    // The fence faulted after the instant moved. The obligation is KEPT: it is
    // the only record that a Check still needs settling, and a transient fault
    // must not drop it — the next pass retries the defer. No error is swallowed.
    throw err;
  }
  // A lost fence moved nothing, so the mark stays too: only a conclusion (a
  // recorded terminal or an honest give-up) may clear it.
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
  // The coupled fact, checked in EVERY arm: a state is only readable with the
  // outcome it stores (NULL for the non-terminal ones). The schema enforces the
  // same coupling, so a mismatch means a row this build must not reason about
  // — never a terminal state whose authorisation is inferred from timestamps.
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
      // No outcome on a launched row: an outcome IS the transition, so this
      // arm is the only `unknown` and only it holds container and capacity.
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
      // The switch is exhaustive over `LaunchRowState`; this arm is unreachable
      // and exists so adding a union member without a decoder arm fails to build.
      return noLaunchState(row.state);
  }
}

/**
 * The paid step's collected result as the row stores it. `recheck.rejected` is
 * a Set in memory and a plain array on the row — the one shape that needs a
 * codec; everything else is stored and read back verbatim.
 *
 * `run.stderr` is deliberately NOT stored: it is untrusted provider text used
 * only on the failure paths, which never reach a persisted row, and keeping it
 * out of D1 keeps an unredacted stream out of the durable store.
 */
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
    // Falls through to the one shape check below — an unreadable row is the
    // same refusal as a row that does not carry a paid outcome.
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
    );
  }
  return {
    run: { stdout: stored.run.stdout, stderr: "", exitCode: stored.run.exitCode },
    // A row written by this module always carries the array; a `Set` of
    // undefined would still be an empty set, so a truncated field degrades to
    // "no rejected rows" rather than a throw.
    recheck:
      stored.recheck == null ? null : { ...stored.recheck, rejected: new Set(stored.recheck.rejected) },
    report: stored.report ?? null,
    appliedProvider: stored.appliedProvider ?? null,
  };
}

/**
 * A replay's marker proof: an existing incarnation may be PROVEN, never
 * re-claimed, so the guarded read needs a command that changes nothing.
 */
const MARKER_PROOF_COMMAND = shellCommand("true");

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
  /**
   * The paid exec RETURNED (an exit status was observed). A rejection or a lost
   * reply leaves this false: nothing then proves the child stopped, so the
   * caller may not destroy its container.
   */
  runnerReturned: boolean;
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
      `round budget spent: ${step} declined — the derived runner deadline is spent (${left}ms left for it)`,
      window,
    );
  }
  return left;
}

/**
 * Payload text of one bounded read, plus WHY it yielded nothing. A missing
 * flag line or overflow beyond the byte bound are both "no payload" to the
 * caller, but they are different D1 causes, so the failure is named rather
 * than collapsed into a bare null. Shared by the recheck document and status
 * reads and the diff capture — the transport is identical, only the producer
 * differs.
 */
type BoundedRead = { text: string | null; failure: "overflow" | "unreadable" | null };

/**
 * The report read's own result: the same transport, plus `absent` — the
 * command itself proved the path is not there. ONLY a read whose command
 * probes for the file may report it (see `readReportCommand`); every other
 * producer never emits that flag, so their reads cannot report it and keep
 * their meanings.
 */
type ReportBoundedRead = { text: string | null; failure: "overflow" | "unreadable" | "absent" | null };

export function parseBoundedRead(stdout: string): BoundedRead;
export function parseBoundedRead(stdout: string, provesAbsence: true): ReportBoundedRead;
export function parseBoundedRead(stdout: string, provesAbsence = false): ReportBoundedRead {
  const out = stdout.trimEnd();
  const split = out.lastIndexOf("\n");
  if (split < 0) return { text: null, failure: "unreadable" };
  const flag = out.slice(split + 1).trim();
  // Absence is claimed only where the command PROVED it; for every other read
  // a stray `2` keeps its old meaning (over the byte bound).
  if (provesAbsence && flag === BOUNDED_READ_ABSENT_FLAG) return { text: null, failure: "absent" };
  if (flag !== "0") return { text: null, failure: "overflow" }; // beyond the byte bound
  return { text: out.slice(0, split), failure: null };
}

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
  // The marker is re-proved on EVERY read, from the same container the command
  // then runs on: a replacement between collection steps yields unknown, never
  // a document from a container this attempt did not prepare. A rejected call
  // is unprovable too — the reply never said whether the proof or the command
  // failed — so it is `unknown`, not an unreadable document.
  let read: MarkedRun;
  try {
    read = await sandbox.runMarked(marker, command, { timeout: timeoutMs });
  } catch {
    throw new AttemptUnknownError(
      "the attempt container could not be proven to be this attempt's (the read itself was lost) — its result is not collected",
    );
  }
  // No deadline rides a bounded read, so `deadline-spent` cannot happen here;
  // if it ever did, nothing was read and the document is not collectable.
  if (read.kind !== "ran") {
    throw new AttemptUnknownError(
      "the attempt container could not be proven to be this attempt's — its result is not collected",
    );
  }
  if (read.exitCode !== 0) return { text: null, failure: "unreadable" };
  return provesAbsence ? parseBoundedRead(read.stdout, true) : parseBoundedRead(read.stdout);
}

/**
 * A seat-authored `reason`/`error` bounded for the D1 failure text and the log
 * field. Redaction runs FIRST: slicing first would cut a secret that straddles
 * the cap and persist its surviving fragment. `null` for a non-string field.
 */
function boundedStatusText(value: unknown): string | null {
  return typeof value === "string"
    ? redactSecrets(value).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS)
    : null;
}

/**
 * The seat's recheck status document (`RecheckStatus`), or null when the file
 * is absent/unreadable or carries a foreign schema or HEAD. Anything but this
 * round's own status for this HEAD is no attribution at all — never a
 * fabricated outcome.
 */
function parseRecheckStatus(text: string | null, headSha: string): RecheckStatus | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    if (value["schema"] !== "mstar.recheck-status/v1" || value["headSha"] !== headSha) return null;
    const outcome = value["outcome"];
    if (outcome !== "ok" && outcome !== "skipped" && outcome !== "failed") return null;
    // `rejected` is DERIVED from the row-id list, never read from the document:
    // one source survives, so the two faces of the count cannot disagree in a
    // foreign or hand-rolled status. `rejected_unnamed` has no list to derive
    // from — it is the count of drops the gate could not name, and it is the
    // only record of them once the seat has filtered its own document.
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
      // `reason` is a CLOSED vocabulary: the per-row accounting below branches
      // on these exact literals, so an off-vocabulary value would fall through
      // to the wrong verdict instead of being ignored. Unrecognized → null
      // (same as absent), never a guessed reason.
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
  /** Why `doc` is null (absent read / overflow / validation), null when it survived. */
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
  // A zero-byte payload is the seat writing nothing: absent, not malformed.
  // Parsing it would throw and report the round as a JSON fault instead.
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
  // A row the surviving document CARRIES has a real answer, so a status that
  // also names it (the seat drops, then re-emits it) must not cost it that
  // answer: `rejected` outranks the answered row in the reconciliation, and a
  // row listed in both would report `invalid-output` instead of its actual
  // assessment. Local gate drops need no such filter — a dropped row is by
  // construction absent from `doc.results`.
  const answeredRowIds = new Set((doc?.results ?? []).map((row) => row.rowId));
  for (const rowId of status?.rejected_row_ids ?? []) {
    if (sent.has(rowId) && !answeredRowIds.has(rowId)) rejected.add(rowId);
  }
  // The seat writes an ALREADY-FILTERED document, so the local pass above
  // normally sees no drops at all; the status is the surviving record. Taking
  // the larger of the two unions them without double-counting a round whose
  // unfiltered document also reached this pass.
  const unnamedRejectedRows = Math.max(anonymousRejectedRows, status?.rejected_unnamed ?? 0);
  return { doc, docFailure, rejected, anonymousRejectedRows: unnamedRejectedRows, status };
}

/**
 * Bounded read + validation + redaction of the report seat's document: the
 * audited fixed-path read (`readReportCommand`) yields `<content>\n<flag>`;
 * anything other than a flag-0 document that passes `validateReportDoc` and is
 * bound to `expectedHeadSha` is NO report (the sections render `none`) and
 * leaves ONE warn naming which cause rejected it — a document the read PROVED
 * missing (`absent`) and a read that broke (`unreadable`) are separate names,
 * though both render `none`. Each narrative field is redacted before it can
 * reach a public body — the seat's text is model output like any other, and a
 * prompt-injected credential can hide in a PR description it quoted.
 */
/**
 * The runner's applied-model document: WHICH `provider/model` actually served
 * the round, or null when the runner wrote none (no model served). This is a
 * projection of the runner's observation — never a derivation from the
 * configured chain, which would report what we asked for instead of what ran.
 * A broken read or document is null with one warn: losing the attribution must
 * never lose the review, and it must never invent a provider either.
 */
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
    // `absent` is the ordinary no-model-served shape — no warn without a fault.
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
  // The document is container-authored, like the recheck status and the report:
  // bounded FIRST (a value over the column's bound is refused whatever it
  // contains), then redacted, then validated to the shape the column advertises
  // (`provider/model`) — never persisted as whatever string it carried.
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
    // `absent` and `unreadable` are distinct failures of the SAME disclosure:
    // the seat wrote no document vs. the read of it broke. Both render `none`.
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
    // No parse-error detail: `JSON.parse` quotes the input, and the input is
    // seat-authored text that may carry a credential-shaped value.
    log.warn({ ...fields, report_doc: "invalid-json" }, "report document is not JSON — sections render none");
    return null;
  }
  const redact = (text: string) => redactExactSecrets(redactSecrets(text), secretValues);
  const gate = validateReportDoc(parsed);
  if (!gate.ok) {
    // The shared gate names only the accepted shape, never the seat's own
    // key/value text; the same shape + exact-value redaction every other log
    // field gets is applied here too.
    const error = redact(gate.error);
    log.warn(
      { ...fields, report_doc: "invalid-document", report_doc_error: error },
      `report document failed its gate — sections render none: ${error}`,
    );
    return null;
  }
  // The fixed path is shared with every earlier run in this container: a
  // document bound to another head is that run's narrative, not this one's. A
  // missing/invalid head never reaches here — the gate rejects it first.
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

/** The harness paths the in-image runner exec env carries. */
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

/**
 * The runner-input projection of one consumer config: the declaration with
 * the API keys stripped. Provider keys ride only the runner's stdin credential
 * payload (under the declaration's own provider id).
 *
 * Sizes are resolved HERE, not stored: the operator's statement wins per field
 * and the provider catalog fills a blank one. The runner has no catalog of its
 * own (the image copies package sources only), so a size left unresolved would
 * reach the synthesized models.yml as absent. A model with a fact on neither
 * side keeps the bare id entry it has always had.
 */
function toRunnerCustomProvider(provider: CustomProviderConsumerConfig): CustomProviderDeclaration {
  const declaration: CustomProviderDeclaration = {
    provider_id: provider.provider_id,
    base_url: provider.base_url,
    api: provider.api,
    model_ids: [...provider.model_ids],
  };
  // The vendor's numbers describe the MODEL, so the id alone resolves them —
  // whatever endpoint the declaration points at.
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
  // Absent when neither the declaration nor the catalog states anything: the
  // synthesis then emits the bare `- id:` entry it has always emitted.
  if (Object.keys(meta).length > 0) declaration.models_meta = meta;
  return declaration;
}

/**
 * Build the runner exec env: harness paths + the App's verbatim model chain.
 * It carries NO credential — provider keys ride the stdin payload
 * (`buildRunnerCredentials`), never the process environment.
 */
function buildRunnerEnv(appCfg: RunnerAppConfig): Record<string, string> {
  const runnerEnv: Record<string, string> = {
    HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
  };
  // The App's verbatim chain forwards VERBATIM (the guard only decides
  // unset-vs-set; it never mutates the value; the runner-side selector parse
  // trims segments). A blank chain cannot reach production — the
  // assertAppConfigComplete gate fails the message before the guard. The
  // precedence lives in effectiveModelChain (ONE resolution shared with the
  // version-record put — no re-resolution split-brain).
  const { chain } = effectiveModelChain(appCfg);
  if (chain !== undefined) {
    runnerEnv.OMP_REVIEW_MODEL = chain;
  }
  return runnerEnv;
}

/**
 * Build the runner's credential transport: the versioned stdin payload
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
  // Log only when the caller supplied BOTH the sink and the identity fields
  // (the consumer flow does; direct unit calls may omit them).
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

/**
 * Exec-env names that are configuration/paths, not credentials — the only
 * values the runner exec env carries now that keys ride the stdin payload.
 */
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

/**
 * The runner stage's failure detail. stderr is the ONLY diagnosis a non-zero
 * exit carries (exit 124 = the exec bound fired, and the run leaves 0B of
 * stdout), so a redacted tail rides the message that reaches the durable
 * review_failures row and the log line. `stdout` is counted in UTF-8 bytes,
 * never in UTF-16 units. Redaction runs BEFORE the tail cut:
 * a secret sliced in half would survive the exact-value pass.
 */
function runnerFailureDetail(
  run: { stdout: string; stderr: string; exitCode: number },
  secretValues: readonly string[],
): string {
  // review_failures.error is unbounded TEXT (migration 0010), so the bounded
  // tail below cannot overflow the column.
  const base = `runner failed: exit ${run.exitCode}, stdout ${new TextEncoder().encode(run.stdout).length}B`;
  const tail = redactExactSecrets(redactSecrets(run.stderr), secretValues).trim().slice(-STDERR_TAIL_MAX);
  return tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
}

/**
 * Base64-encode UTF-8 text for the in-image JSON write step (workerd-safe).
 * Byte→char conversion is CHUNKED (qc3 F-303): a plain per-byte `+=` loop
 * is O(n²) and this sits in the worker hot path; 0x8000 chars per
 * `String.fromCharCode` call stays far below the engine arg-count cliff.
 */
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
 * Run one attempt command through the guarded form: `claimed` runs it plainly
 * (this entry just provisioned the container), `already-claimed` runs it under
 * the marker gate — ONE Durable Object request that proves the incarnation and
 * acts on it, so proof and action can never straddle a replacement. A missing
 * marker, a different one or a lost guarded reply is `unknown`: nothing ran on
 * an unproven container.
 *
 * The options carry everything a paid command needs (`stdin` for the runner
 * input and the credential payload, `cwd` for the clone, `env` for the model
 * chain, `timeout` for the anchored window), so a guarded call replaces the
 * unguarded one rather than being followed by it.
 */
async function runPreparedCommand(
  sandbox: ReviewSandbox,
  marker: string,
  provisioning: "claimed" | "already-claimed",
  command: ShellCommand,
  opts?: { env?: Record<string, string>; cwd?: string; timeout?: number; deadlineEpochMs?: number; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (provisioning === "claimed") return sandbox.runCommand(command, opts);
  let read: MarkedRun;
  try {
    read = await sandbox.runMarked(marker, command, opts);
  } catch (err) {
    // A lost reply is not an answer: the guarded command may have run on some
    // incarnation, and none is proven here. Unknown — never an ordinary
    // failure, which a caller could settle and then destroy the marked
    // container on. The cause rides the message so the log still names it.
    const detail = err instanceof Error ? err.message : String(err);
    throw new AttemptUnknownError(
      `the attempt container could not be proven (the guarded command's reply was lost: ${detail}) — nothing ran on a replacement`,
    );
  }
  if (read.kind === "unknown") {
    throw new AttemptUnknownError(
      "the attempt container could not be proven — nothing ran on a replacement",
    );
  }
  if (read.kind === "deadline-spent") {
    // The DO checked the absolute deadline again, immediately before starting
    // the process, and refused. Nothing ran.
    throw new ExecDeadlineRefusedError(read.remainingMs);
  }
  // The guarded form answers `{kind:"ran", …}`; callers get the exec result
  // they would have got unguarded, so the discriminant never reaches a durable
  // record or a comparison.
  return { stdout: read.stdout, stderr: read.stderr, exitCode: read.exitCode };
}

/**
 * Write the attempt's marker on the container this entry provisioned. Only a
 * returned `written`/`matched` continues: other bytes mean the container is not
 * this attempt's, and a REJECTED write is `unknown` — a lost reply leaves the
 * marker possibly written, so a concurrent replay can prove this container and
 * launch paid work on it. Settling this entry as a failure would then destroy a
 * container that may be paying, and a retry would mint a fresh attempt id.
 */
async function claimAttemptMarker(
  sandbox: ReviewSandbox,
  marker: string,
  attemptId: string,
): Promise<void> {
  let claimed: "written" | "matched" | "unknown";
  try {
    claimed = await sandbox.claimMarker(marker);
  } catch {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the marker claim's reply was lost — the container's state is unknown`,
    );
  }
  if (claimed === "unknown") {
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the container is not this attempt's (its marker is missing or different)`,
    );
  }
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

/** The App/PR identity, derived without dereferencing a legacy `botRef`. */
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
 * The attempt's own row grants the container: the entry whose INSERT creates it
 * provisions, and every later entry may only prove — and then act on — the
 * incarnation that entry started. A prepare that cannot prove that incarnation
 * is `unknown`, not a retry.
 */
export async function prepareReviewAttempt(input: {
  payload: ReviewJobPayload;
  deps: {
    env: { SANDBOX: unknown; DB: D1Like };
    getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  };
  commenter: Pick<ReviewCommenter, "getInstallationToken">;
  /** The attempt identity: the container derives from it, and so does the marker written here. */
  attemptId: string;
  /**
   * The Check identity frozen at creation (key + generation). `null` for a
   * delivery that had no admitted claim — its identity is frozen at the
   * checkout, and the freeze CAS decides who owns the head.
   */
  identity: AttemptIdentity | null;
  sandbox: ReviewSandbox | null;
  /**
   * The caller owns the container's lifetime (its finally destroys it), so it
   * learns the handle the moment it exists — a throw after acquisition must
   * not lose the only reference to a running container.
   */
  onSandbox: (sandbox: ReviewSandbox) => void;
  progress: ReviewAttemptProgress;
}): Promise<PreparedReviewAttempt> {
  const { payload, deps, commenter, attemptId, progress } = input;
  let sandbox = input.sandbox;
  // 1. Sandbox + installation token (created lazily; destroyed by the caller).
  // AL-6 stage window: container acquisition + every in-sandbox step below
  // (clone/rev-parse/diff/numstat/input-write) classify "sandbox" until the
  // runner step takes over. The installation-token mint is a GITHUB AUTH
  // call, not a sandbox step — it stays OUTSIDE the sandbox window so a
  // mint failure (bad App credentials, GitHub auth outage) records
  // stage "pipeline" and is never mis-tagged as a sandbox/infra failure.
  //
  // The durable first-provisioning claim comes FIRST, before a container is
  // even resolved: only the entry whose row INSERT created it may start one.
  //
  // A rejected claim is not an answer: the write may have landed, so this
  // attempt may already own a provisioned container — and paid work — from an
  // earlier entry. The outcome is `unknown`, never a retryable failure: a
  // retried delivery mints a FRESH attempt id and could pay twice, because the
  // fence only binds within one attempt. An unknown attempt holds its admission
  // row to TTL instead; that is the intended trade, not a gap to "fix" back
  // into a retry.
  let provisioning: "claimed" | "already-claimed";
  try {
    provisioning = await claimReviewAttempt(deps.env.DB, attemptId, Date.now(), input.identity);
    // A row that predates this entry (a replay, or a claim seeded elsewhere) may
    // carry no identity yet: freeze it under the SAME CAS. A loss means another
    // caller froze a different head — a moved head — never a no-op.
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
        // WHOLE identity: the same pair is our own and proceeds; anything else
        // is a foreign freeze.
        throw new MovedHeadError(attemptId, existing.key, input.identity.key);
      }
    }
  } catch (err) {
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the provisioning claim could not be read back (${detail}) — nothing is provisioned for it`,
    );
  }
  if (sandbox === null) {
    progress.failureStage = "sandbox";
    sandbox = await reviewAttemptSandbox(deps, attemptId);
    input.onSandbox(sandbox);
  }
  const marker = attemptMarker(attemptId);
  if (provisioning === "claimed") {
    // First provisioning: the marker is written BEFORE the checkout and every
    // runner input. It is the one fact that later proves a collect/destroy
    // addresses THIS attempt's live container. A container already carrying
    // other bytes is not repaired (it belongs to someone else), and a lost
    // reply is not an ordinary failure either: the marker may already be there,
    // so a concurrent replay can prove this container and start paying on it
    // (see claimAttemptMarker).
    await claimAttemptMarker(sandbox, marker, attemptId);
  } else {
    // A replayed prepare may NOT provision: an earlier entry claimed that
    // right, so the only accepted outcome is the incarnation it started — and
    // every later command runs guarded on that same handle (a refused or lost
    // guarded reply is `unknown`, never an ordinary failure). A fresh container
    // (no marker, not running) is never stamped as the original, including
    // after a crash before the marker write: the attempt stays unknown rather
    // than a second container wearing its name.
    await runPreparedCommand(sandbox, marker, provisioning, MARKER_PROOF_COMMAND);
  }
  progress.failureStage = "pipeline";
  // Purpose-scoped sandbox read grant (§7.6 / RL-6): the mint is
  // repository-scoped read-only BY REQUEST, and the sandbox path only
  // proceeds on the RETURNED capabilities — assertSandboxGrant fails
  // closed on any broader grant (RL-6: the request is never presented as
  // proof of the response).
  const token = await mintSandboxReadToken({ payload, commenter });
  // SEC-01: seed the exact-value list with the minted token immediately —
  // a failure before the runner env is assembled (clone/diff/input steps)
  // still exact-redacts the token in the catch path.
  progress.secretValues = [token];
  progress.failureStage = "sandbox";
  const cmds = buildGitOpsCommands({
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
    cloneDir: CLONE_DIR,
    diffPath: DIFF_PATH,
  });

  // 2. Clone the PR head branch. Git transport auth via scoped extraheader
  // env (bugbot A1 — git ignores GH_TOKEN, so private-repo clones failed
  // without this; same pattern as the smoke-entry git fallback), built by
  // the ONE `gitTransportEnv` the oversized-diff fetch also uses. GH_TOKEN
  // stays for the gh steps below. Credentials are exec env only — never in
  // the command string, never in the image, never in logs.
  const clone = await runPreparedCommand(sandbox, marker, provisioning, cmds.clone, {
    env: gitTransportEnv(token),
    timeout: EXEC_TIMEOUT_GIT_MS,
  });
  if (clone.exitCode !== 0) {
    throw new Error(`clone failed: exit ${clone.exitCode}, stdout ${clone.stdout.length}B`);
  }

  // 3. AUTHORITATIVE sha: read the checked-out HEAD (bugbot A2). Everything
  // downstream — idempotency key, D1 row, posted commit_id, KV state — is
  // keyed off this sha, so diff/files/commit_id always describe the same
  // commit and a force-push mid-flight is captured here, not drifted.
  const rev = await runPreparedCommand(sandbox, marker, provisioning, cmds.checkedOutSha, {
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
  /** The attempt identity: its container's marker is the proof collection runs on. */
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
  // The entry gate is a READ, not the fence: a replay that finds a durable
  // result hands it back without touching the container, and a row that already
  // sent (or already failed) its paid call is refused here. The one-way claim is
  // taken later, in the statement that is about to SEND the exec, so everything
  // before it — minting, the input write — leaves the row `provisioned`, which
  // cleanup may still release.
  let entry: LaunchVerdict;
  try {
    entry = launchVerdict(await readReviewLaunch(deps.env.DB, attemptId));
  } catch (err) {
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    deps.log.warn({ ...fields, error: detail }, "launch row unreadable — the paid step is not taken");
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the launch row could not be read — the paid step is not taken`,
    );
  }
  switch (entry.kind) {
    case "persisted":
      // The paid step ran and its result is durable, even though this entry did
      // not run it: a replay must never claim "no paid work started".
      progress.runnerReturned = true;
      return entry.execution;
    case "never-paid":
      // `provisioned`: everything below may proceed; the fence is claimed at
      // the send, so a failure here leaves the row releasable.
      break;
    case "paid-unknown":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: its paid step was already launched and its result is not durable — refusing a second launch`,
      );
    case "paid-failed":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: its paid step returned a failure — refusing a second launch`,
      );
    case "owned-by-cleanup":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: a cleanup owns this container's destruction — refusing to run the paid step on it`,
      );
    case "unrecognised":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: its launch row is in a state this build cannot interpret — refusing the paid step`,
      );
    case "never-claimed":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: it holds no provisioning claim — nothing was launched for it`,
      );
    default:
      return noLaunchState(entry);
  }
  // The input carries the SAME absolute deadline every post-diff step bills —
  // the exec's own end instant, never a duration. The runner anchors its own
  // review deadline AT it, so the write's own window and the runner's parse
  // time both spend that deadline instead of each being added back onto it.
  const runnerInput = {
    worktreePath: CLONE_DIR,
    reconFacts,
    // No image-declared base provider: the per-review models.yml is the
    // App's own declarations, and built-in providers resolve from the
    // runtime's own catalog.
    capabilityHosts: [],
    // The absolute instant the exec below is killed at: the runner anchors
    // its own review deadline there, so a shortened round plans synthesis
    // inside the exec it runs under instead of the level's whole tier cap.
    outerDeadlineEpochMs: deadlineMs,
    ...(modelOverrides !== undefined ? { modelOverrides } : {}),
    ...(customProviders !== undefined
      ? { customProviders: customProviders.map(toRunnerCustomProvider) }
      : {}),
    // §7.8: the typed recheck input rides ONLY when open rows
    // exist — a first round with an empty lifecycle serializes
    // byte-identically to the pre-recheck payload.
    ...(recheckInput !== undefined ? { recheck: recheckInput } : {}),
    // The seat's ask budget: a top-level runner field, never part of the
    // frozen recheck document.
    ...(recheckAssignmentMaxBytes !== undefined ? { recheckAssignmentMaxBytes } : {}),
    // The report seat's untrusted input. Absent when gh could not answer,
    // so no report is attempted and the sections render `none`.
    ...(prContext !== undefined ? { prContext } : {}),
  };
  // The document rides the exec stdin pipe: as an argv string it became one
  // argument, and a recheck round above ~98 KiB breaches Linux's 128 KiB cap.
  // Serialization is paid BEFORE the write's one clock sample, so the armed
  // bound and the `124` attribution below both read the instant the write
  // actually started at — a straddling sample cannot arm the deadline's
  // shorter remainder and then classify its kill as the step cap's.
  const runnerInputStdin = toBase64Utf8(JSON.stringify(runnerInput));
  const inputWriteWindowMs = deadlineMs - Date.now();
  // Guarded: ONE request proves the attempt's marker and writes the input in
  // the same call, so a container replaced after prepare cannot receive the
  // document. `stdin` rides the guarded options — no second probe.
  const writeInput = await runPreparedCommand(
    sandbox,
    attemptMarker(attemptId),
    "already-claimed",
    writeJsonCommand(RUNNER_INPUT_PATH),
    {
      stdin: runnerInputStdin,
      timeout: boundedStepTimeout(
        deadlineMs,
        EXEC_TIMEOUT_GIT_MS,
        "runner input write",
        "runner",
        // The SAME sample both bounds the write and decides whether a `124`
        // was that bound's: two reads could disagree across the cap/deadline
        // crossover and retry a stop the clock already spent.
        deadlineMs - inputWriteWindowMs,
      ),
    },
  );
  if (writeInput.exitCode !== 0) {
    // A kill under the anchored runner deadline (its remainder bound the
    // write, not the step's own cap) is the typed stop, not a generic
    // write error: the runner never started, so every observed counter is
    // KNOWN — provably 0/0 seats — and the attempt acks rather than paying
    // a queue retry for the same clock. A `124` the step's own cap fired
    // keeps the generic path: that kill was not the frozen deadline's.
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

  // 4. In-image runner: cwd = clone dir; harness paths + the App's model
  // chain via exec env, and the App's own provider keys via the exec STDIN
  // credential payload (compass D, AL-24-5: per-App BYOK only, zero global
  // fallback; key_source app|custom logging; secrets never baked into the
  // image, never in logs, never in the process environment). The runtime
  // runner has NO summary-degrade path: exit 0 ⇒ stdout is the
  // engine-validated mstar.review/v1 envelope.
  // AL-6 stage window: the review run itself — a non-zero exit or an exec
  // exception (timeout / container error) here classifies "runner".
  progress.failureStage = "runner";
  // SEC-01 exact-value defense: the SAME credential resolution the runner
  // exec used is captured here (single source — no re-resolution
  // split-brain) so the session's actual secret values can be
  // exact-redacted from any model-echoed output below.
  const runnerEnv = buildRunnerEnv(appCfg);
  const credentials = buildRunnerCredentials(appCfg, deps.log, fields, customProviders);
  // SEC-01 exact-value defense: the session's ACTUAL secret values (the
  // transported provider keys + the minted installation token) — needed by
  // the failure message below and shared by the degrade and success paths.
  progress.secretValues = sessionSecretValues(runnerEnv, credentials.keyValues, token);
  // SEC-01 resume (I-000685): the exact set this exec is about to hand the model
  // — the provider keys it transports plus the installation token it minted — is
  // sealed HERE, before anything is spent, and rides the statement that records
  // the paid result. A failure to seal is a failure of the paid step itself: an
  // unsealed attempt would be a review whose body no resumed host could ever
  // protect, so it fails while nothing has been paid, never after.
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
  // What that ONE absolute instant still owes, read HERE after the input
  // write consumed its window: the write and startup spend the deadline
  // instead of being added back onto it. A deadline the write finished is
  // declined explicitly, never started as a 1ms exec that fails for the
  // wrong cause. This is the EARLY refusal — it keeps the row releasable
  // (`provisioned`) when the claim would be pointless; the authoritative
  // bound is taken after the claim below, because the claim is a D1 round
  // trip and its latency belongs to the attempt's clock too.
  const beforeClaimMs = deadlineMs - Date.now();
  if (beforeClaimMs <= 0) {
    throw new RoundBudgetSpent(
      `round budget spent: runner declined — the exec deadline is spent (${beforeClaimMs}ms left for it)`,
      "runner",
    );
  }
  // THE paid-step fence, taken in the statement that is ABOUT TO SEND: a lost
  // reply, a retried entry or a restart finds `launched` and is refused, while
  // everything above this line leaves the row `provisioned` (releasable). The
  // refusal is `unknown`: a failure the caller could retry would pay twice.
  let launch: LaunchClaim;
  try {
    launch = await claimReviewLaunch(deps.env.DB, attemptId, Date.now());
  } catch (err) {
    // A rejected claim is not a zero-row claim: the write may have landed, so
    // the attempt may already own its one paid step. Unknown, never a
    // settleable failure — a failure the caller could retry would pay twice.
    const detail = redactExactSecrets(
      redactSecrets(err instanceof Error ? err.message : String(err)),
      progress.secretValues,
    );
    deps.log.warn({ ...fields, error: detail }, "launch claim failed — the paid step is not taken");
    throw new AttemptUnknownError(
      `attempt ${attemptId}: the launch claim could not be read back — the paid step is not taken`,
    );
  }
  if (!launch.ok) {
    if (launch.reason === "persisted") {
      progress.runnerReturned = true;
      return launch.execution;
    }
    throw new AttemptUnknownError(
      `attempt ${attemptId}: another entry owns the paid step (${launch.reason}) — refusing a second launch`,
    );
  }
  // The typed cap stop shared by both pre-start refusals below: no paid child
  // ran, so the record is a confirmed no-result terminal (cleanup may release)
  // and the counters are provably 0/0 — never `unknown`, never a zero-length
  // exec.
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
  // THE exec bound is taken at the LAST possible instant the WORKER can see:
  // the claim above is a D1 write, and its round trip is part of the attempt's
  // clock. The container repeats this check after its own queue, marker proof
  // and RPC (the absolute instant rides the request below), so this refusal is
  // the cheap pre-RPC one.
  const runnerTimeout = Math.max(0, deadlineMs - Date.now());
  if (runnerTimeout === 0) {
    // We own the row now, so leaving it `launched` would be an `unknown` that
    // holds the container and capacity forever. The paid call was never sent:
    // record the confirmed stop and throw it.
    await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    throw capStop("runner declined after the launch claim — the deadline was spent by the claim");
  }
  // The runner started HERE: everything after this line is the paid child's
  // window, so a throw before it is not evidence that a child ran.
  progress.runnerStartedAt = Date.now();
  // Guarded: the paid exec is proven and executed in ONE request, so a
  // replacement container can never receive credentials or run the review. The
  // ABSOLUTE deadline rides that request: the DO reads the remainder right
  // before starting the process and reserves the kill grace out of it, so the
  // proof and the RPC cannot let the child run past the frozen instant.
  let run: { stdout: string; stderr: string; exitCode: number };
  try {
    run = await runPreparedCommand(sandbox, attemptMarker(attemptId), "already-claimed", runnerCmd, {
      cwd: CLONE_DIR,
      env: runnerEnv,
      // The credential payload rides the exec STDIN pipe — present only when
      // the App actually transported a key (keyless run shape = no stdin).
      ...(credentials.payload === undefined ? {} : { stdin: credentials.payload }),
      deadlineEpochMs: deadlineMs,
    });
  } catch (err) {
    if (!(err instanceof ExecDeadlineRefusedError)) throw err;
    // The container refused BEFORE starting anything: this is the same
    // confirmed stop as the pre-RPC refusal, not a lost reply. The runner had
    // not started, so cleanup must not treat it as unproven.
    progress.runnerStartedAt = undefined;
    await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    throw capStop(
      `runner declined inside the container — the deadline was spent before the exec started (${err.remainingMs}ms left)`,
    );
  }
  // The exec answered with an exit status: the paid child's completion is
  // observed, not inferred. A rejection above never reaches this line.
  progress.runnerReturned = true;
  const runnerElapsedMs = Date.now() - progress.runnerStartedAt;
  if (run.exitCode === 124) {
    // The sandbox's GNU-timeout wrapper killed the exec at the anchored
    // instant — the runner could not print its own signal, so neither seat
    // counts nor the stop instant are observable. `sandbox-kill` records
    // the frozen runner budget and leaves every counter null. The persisted
    // outcome carries only trusted budget fields plus fixed diagnostics:
    // provider stderr is untrusted text, so it rides one redacted log line
    // and never the durable row the outcome builds below.
    deps.log.warn(
      {
        ...fields,
        stderr_tail: redactExactSecrets(redactSecrets(run.stderr), progress.secretValues).slice(-STDERR_TAIL_MAX),
      },
      "runner exec killed at the anchored deadline (provider stderr on this line only)",
    );
    // The returned status is the fact; the ROW's terminal transition belongs
    // to the settlement that also writes the durable failure row, so the row
    // never authorises destruction before that row exists (plan Task 4b's
    // coupled-facts rule). The settlement reads `runnerReturned` from the
    // phase facts to know this return was observed.
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
      `runner exec killed at its deadline: exit 124, stdout ${new TextEncoder().encode(run.stdout).length}B`,
    );
  }
  if (run.exitCode !== 0) {
    // A RETURNED nonzero status is an observation, but the row's transition is
    // the settlement's: it happens once the durable failure row exists, never
    // before (the phase facts carry `runnerReturned: true`).
    throw new Error(runnerFailureDetail(run, progress.secretValues));
  }
  // d5-budget AC-S10-logs: one runner attempt → at least one budget line
  // (level + runner_timeout_ms + elapsed_ms + orchestration). elapsed_ms is
  // VISIBILITY ONLY — it never throws; the sandbox exec timeout above is
  // the only wall-clock failure (spec 不 abort).
  deps.log.info(
    { ...fields, elapsed_ms: runnerElapsedMs },
    `runner finished in ${runnerElapsedMs}ms (budget ${runnerTimeout}ms)`,
  );

  // The ONE typed terminal outcome outside the verdict envelope (spec §
  // Exhaustion): the runner declared the round's wall clock spent and
  // stopped review work BEFORE its own deadline fired — the signal is the
  // outcome, not model content, so a malformed one is still a parse
  // degrade below. It resolves before any verdict parsing and before the
  // post-runner publication steps it made un-runnable; the single catch
  // publishes it. failureStage stays "runner" for the row.
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
      `runner signalled budget exhaustion (seats ${budgetSignal.signal.seatsStopped}/${budgetSignal.signal.seatsDispatched})`,
    );
  }

  // AL-6 stage window: post-runner steps (parse has its own branch; the
  // post/KV/put orchestration is worker-side) are "pipeline" again.
  progress.failureStage = "pipeline";

  // §7.7 step 5 (cont): read the concurrent recheck seat's document AND its
  // status through the audited fixed-path bounded reads (§7.3: Worker
  // validates against ITS OWN trusted input — never a model echo). Anything
  // other than a valid document is NO recheck; the round proceeds with every
  // selected row conservatively accounted (§7.4), and the seat's status makes
  // that loss attributable in D1. Rows the gate dropped are carried as
  // rejected — by rowId when it had one, by position among the unanswered
  // sent rows when it did not — so they are never mistaken for rows the seat
  // never reached.
  const marker = attemptMarker(attemptId);
  const recheck = recheckInput !== undefined ? await readRecheckDoc(sandbox, marker, recheckInput) : null;

  // The report document (mstar.report/v1) rides the SAME audited bounded read
  // and the SAME fail-closed rule: the Worker validates it against its own
  // gate and falls back to `none` headings, or null when the seat wrote
  // nothing. Read only when the runner was actually given `--report-out`.
  const report: ReportDoc | null =
    prContext !== undefined
      ? await readReportDoc(sandbox, marker, progress.secretValues, headSha, deps.log, fields)
      : null;

  // Which provider actually served — the runner's own observation, projected
  // here and NOWHERE derived again. null = the runner reported none (no model
  // served), which stays null on the row; it is never replaced with the chain
  // head, because that would report the configured first selector as if it
  // had run.
  const appliedProvider = await readAppliedProvider(sandbox, marker, progress.secretValues, deps.log, fields);

  // Result and completion are ONE statement: the row reaches `persisted` only
  // in the write that stores the result, so completion is never recorded before
  // the result is durable. Anything else — a row that moved, a result too large
  // for the row, a storage fault, a lost reply — leaves the attempt `launched`
  // and refuses to confirm: the paid outcome is not proven durable, so it is
  // `unknown`, never a failure the caller may settle, destroy on, or retry. A
  // rejected write is explicitly unknown: it may have landed.
  //
  // NO runner output crosses the persistence boundary unredacted. The exact
  // values this session's own exec received, and every bounded transform of
  // them, are removed HERE, on the host that holds them; the stored and the
  // returned value are this one sanitized object, so nothing downstream can
  // publish the raw stream either. Each retained document is redacted as its
  // own root, with its host-written identity protected BY PATH — a forged
  // `{"head_sha": …}` in model text is at no protected path and is redacted.
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
    );
  }
  return execution;
}
