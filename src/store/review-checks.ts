
import { CHECK_WINDOW_MS } from "../review-budget";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import { suspensionCredentialOf, type Lease, type SuspensionKind } from "./finding-lifecycle";
import type { D1Like, ReviewCheckRow } from "./types";


/**
 * The Check lane's suspension kinds. It carries the M8 set verbatim plus its
 * own `paused`, which M8 has no equivalent for: the Check lane must stop
 * creating for a kill-switched App (spec §7.6) while M8's publication lane
 * simply does not send.
 */
export type CheckSuspensionKind = SuspensionKind | "paused";

/**
 * Encode a suspension reason in the SAME durable grammar the M8 lane owns
 * (`<prefix><kind>: <text> cred=<64-hex>`, `src/store/finding-lifecycle.ts`).
 * `suspensionReasonOf` is the encoder of record but its parameter is narrowed
 * to the M8 kind set, and finding-lifecycle is outside this task's allowed
 * edit set — so the lane's one extra kind rides the identical grammar here
 * rather than widening a sibling module's public union. The fingerprint is
 * parsed back by the SHARED reader (`suspensionCredentialOf`), so the token
 * cannot drift between the two lanes.
 */
export function checkSuspensionReason(
  kind: CheckSuspensionKind,
  text: string,
  credentialFingerprint?: string,
): string {
  const suffix = credentialFingerprint === undefined ? "" : ` cred=${credentialFingerprint}`;
  return `suspend:${kind}: ${text}${suffix}`;
}

/**
 * The matching reader. Anything unrecognized — including a legacy row written
 * before this encoding — is `unknown`, which the re-enable scan treats exactly
 * like an identity-mismatch: it demands a fresh live credential proof rather
 * than auto-resuming on App status alone. That fail-closed default is the whole
 * point of the encoding (P68-QC-003).
 */
export function checkSuspensionKindOf(lastError: string | null): CheckSuspensionKind {
  if (lastError === null || !lastError.startsWith("suspend:")) return "unknown";
  const rest = lastError.slice("suspend:".length);
  const colon = rest.indexOf(":");
  const kind = colon === -1 ? rest : rest.slice(0, colon);
  switch (kind) {
    case "disabled":
    case "identity-mismatch":
    case "missing":
    case "deleted":
    case "decrypt-failed":
    case "paused":
      return kind;
    default:
      return "unknown";
  }
}

/** The shared fingerprint reader (M8's own), re-exported for the Check lane. */
export { suspensionCredentialOf };
export type { SuspensionKind };

/** The authenticated routing scope (spec §7.0) — same vocabulary as the store. */
export type { Scope } from "../../packages/shared/src/recheck-wire";
export type { Lease, PublicationProof } from "./finding-lifecycle";


export type CheckDesired = "in_progress" | "success" | "neutral" | "failure";
export type CheckObserved = "unknown" | CheckDesired;
export type CheckCreateState = "not-sent" | "sending" | "known" | "unknown";
export type CheckRecoveryState = "pending" | "done" | "remote-unconfirmed" | "local-error" | "suspended";
/**
 * The approved category of a terminal review failure (compass D9, migration
 * 0087). It SELECTS the approved wording; the text itself is never derived from
 * an error. A review that produced a verdict has no category — a missed gate is
 * a result, not a failure — and a waiting attempt has none either.
 */
export type CheckFailureStatus = "paused" | "unknown-failure" | "budget-stop" | "cap-stop";

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
  publicationId: string | null;
  createState: CheckCreateState;
  desired: CheckDesired;
  observed: CheckObserved;
  recoveryState: CheckRecoveryState;
  executionDeadlineMs: number;
  attempts: number;
  terminalMs: number | null;
  terminalFailureStatus: CheckFailureStatus | null;
  correctionDesired: Exclude<CheckDesired, "in_progress"> | null;
  correctionGeneration: number | null;
  correctionDispatchedMs: number | null;
  createdAtMs: number;
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
  summary: string | null;
};

/** A terminal intent: `in_progress` is structurally excluded (spec §7.11.2). */
export type CheckConclusion = {
  desired: Exclude<CheckDesired, "in_progress">;
  title: string;
  summary: string;
  failureStatus?: CheckFailureStatus;
};

/**
 * The applied review outcome the Check gate reads (spec §7.9): the row's
 * verdict plus the persisted envelope's `tally.scorePct`. `scorePct` is null
 * when the row carries no readable tally — the caller treats that as an
 * unreadable gate input, never as a pass.
 */
export type PublishedReview = { verdict: string; scorePct: number | null };

/** The §7.9 claim outcome union. */
export type ClaimAttemptResult =
  | { kind: "claimed"; attempt: CheckAttempt; lease: Lease }
  | { kind: "busy" | "terminal"; attempt: CheckAttempt }
  | { kind: "absent" };

/**
 * The transaction clock (spec §7.0). Every §7.9/§7.11.2 signature the contract
 * pins WITHOUT a clock argument fences on the exact lease triple; passing
 * `nowMs` additionally enforces `lease_until_ms > nowMs` and stamps
 * `updated_ms`. Callers that already hold a transaction clock pass it.
 */
export type CheckClock = number;


/** GitHub run name (spec §7.9: exactly this string; never per-attempt unique). */
export const CHECK_NAME = "mstar-inspector review";
/** Immutability anchor for `external_id` (spec §7.9's `mstar-check:v1:` prefix). */
export const CHECK_EXTERNAL_ID_PREFIX = "mstar-check:v1:";
/**
 * Claim lease == immutable execution deadline (spec §7.9: claim time +
 * `CHECK_WINDOW_MS`) — derived from the ONE round budget
 * (`src/review-budget.ts`), never an independent literal: the claim, adoption
 * and recovery fencing all cover `execDeadline + reserve` measured from their
 * actual origins.
 */
export const CHECK_LEASE_MS = CHECK_WINDOW_MS;
/**
 * The delivery-side attach window (spec §7.9). The run is created when the
 * delivery is ACCEPTED, but the queue may only hand the message to a consumer
 * minutes later, so the attach row's deadline has to outlive that delay. It is
 * NOT an execution window: the consumer narrows the row to `CHECK_WINDOW_MS`
 * the moment it adopts it, and a row nobody ever adopts is closed by the
 * reconciler when this window expires.
 */
export const CHECK_ATTACH_WINDOW_MS = 3_600_000;
/**
 * How long an attach row may sit under its DELIVERY holder before an admitted
 * message takes it over (spec §7.9). Seconds, not minutes, because the two
 * holders do different work: the delivery holder only mints a token, creates
 * one run and writes two rows, so a holder silent this long is stalled (an
 * expired inline budget plus a slow create), while the CONSUMER holder stays
 * silent for minutes while the model runs and is never taken this way.
 */
export const CHECK_ATTACH_HOLDER_STALE_MS = 5_000;
/**
 * How long a RELEASED attach row waits for the admitted message to adopt it
 * before the recovery lane may take it (spec §7.9). It exists because the two
 * paths overlap: the delivery path may release the row after the message was
 * admitted, and a consumer that answered `busy` once does not come back. The
 * due time makes the minute reconciler adopt an unclaimed attach row about two
 * minutes after the attach instead of leaving it invisible until the one-hour
 * window expires. It is a BOUND on that invisibility, not a schedule: the
 * consumer's adoption ignores the due time, so the ordinary path still takes
 * the row immediately, and the grace only decides when recovery may step in.
 */
export const CHECK_ATTACH_GRACE_MS = 120_000;
/** Recovery lease (spec §7.9: "Recovery lease is 120,000ms"). */
export const CHECK_RECOVERY_LEASE_MS = 120_000;
/**
 * How long a FROZEN intent keeps waiting on the holder that froze it: 120,000ms
 * is the terminalize hook's whole budget — its 10 s inline wait plus one 5 s
 * `checks.update` send (spec §7.10) — with margin, so a holder that is merely
 * slow still owns its row and only a holder that stopped writing is taken over.
 * Authority over a row that still wants `in_progress` is unaffected: the
 * execution deadline alone governs those, because the model may still be running.
 */
export const CHECK_STALE_HOLDER_MS = 120_000;
/**
 * Backoff after the Nth failed recovery attempt (spec §7.11.1's ladder, which
 * §7.11.2's bounded Check recovery inherits); indexed by `attempts - 1`.
 */
export const CHECK_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000];
/** Durable reason cap (spec §7.9: "error ≤300"). */
export const CHECK_ERROR_MAX_CHARS = 300;
/** Frozen summary cap (spec §7.9: "summary ≤2000 chars"). */
export const CHECK_SUMMARY_MAX_CHARS = 2_000;
/**
 * Frozen title cap. The spec bounds the summary explicitly; the title is the
 * short line GitHub renders above it, so it is bounded by the same rule — a
 * caller must not be able to smuggle unbounded text into the public surface.
 */
export const CHECK_TITLE_MAX_CHARS = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NONTERMINAL_WHERE = "terminal_ms IS NULL";

/**
 * The launch whose PAID result is durable (`persisted`) for the Check's own
 * key + generation: the paid step is over, so the Check no longer has to wait
 * out its execution deadline once no live lease holds it (I-000684 — a host that
 * died after persisting the result leaves that Check queued with nothing
 * selecting it). The state is the attempt's own frozen identity, never a head
 * match, and it grants no authority over a live holder.
 */
const LAUNCH_PERSISTED_SQL = `EXISTS (
    SELECT 1 FROM review_launches l
     WHERE l.attempt_key = review_checks.attempt_key
       AND l.attempt_generation = review_checks.generation
       AND l.state = 'persisted'
  )`;

/**
 * The §7.11.2 due predicate, SHARED by the selector and the recovery claim so
 * the two can never drift (`claimCheckRecovery` repeats the selector's full
 * eligibility by contract). Bound values, in order: `maxAttempts`, `nowMs`,
 * `nowMs`, `nowMs - CHECK_STALE_HOLDER_MS`, `nowMs`, `nowMs`, `nowMs`.
 *
 * The second disjunct is the OWED shape: a resumed publication that could not
 * adopt its Check recorded the obligation on the attempt row (`check_owed_ms`),
 * and that attempt is due as soon as no live lease holds it — the publication
 * proof it concludes from is already durable, so it must not wait out the
 * execution deadline.
 *
 * The PERSISTED launch (`LAUNCH_PERSISTED_SQL`) joins the FIRST shape for the
 * same reason: once the attempt's paid result is durable, its Check does not
 * have to wait out `execution_deadline_ms` — it is due as soon as NO LIVE LEASE
 * holds it (the ordinary lease clause, unchanged). A live execution holder keeps
 * full authority whatever its silence: it may still be collecting, and taking
 * its lease would fence the conclusion it already knows (a staging conflict's
 * `pre-publication-failure`, say) out of the row. The lease is the fence; the
 * launch state only decides whether the row waits for the deadline after the
 * holder is gone. `recovery_state`, the due time, the attempt cap and
 * `terminal_ms IS NULL` still gate it, so a concluded Check is never selected
 * and nothing is re-run or re-published.
 */
const CHECK_DUE_PREDICATE = `recovery_state IN ('pending','remote-unconfirmed')
          AND attempts < ?
          AND (
            (
              (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
              AND (lease_until_ms IS NULL OR lease_until_ms <= ?
                   OR (desired <> 'in_progress' AND holder IS NOT NULL AND updated_ms <= ?))
              AND (desired <> 'in_progress' OR execution_deadline_ms <= ?
                   OR (recovery_state IN ('pending','remote-unconfirmed') AND next_attempt_ms <= ?)
                   OR ${LAUNCH_PERSISTED_SQL})
            )
            OR (
              -- An OWED settlement, associated by the Check's OWN attempt key
              -- (never by two generated ids), and honouring the obligation's
              -- own due instant so the backoff is not bypassed.
              EXISTS (
                SELECT 1 FROM review_launches l
                 WHERE l.check_key = review_checks.attempt_key
                   AND l.check_generation = review_checks.generation
                   AND l.check_owed_ms IS NOT NULL
                   AND l.check_owed_ms <= ?
              )
              AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
            )
          )`;


/**
 * Canonical `attempt_key`: `JSON.stringify` of the flat attempt tuple in the
 * fixed spec order (the spec pins this shape — callers pass the scope
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

const NEXT_GENERATION_SQL = `(SELECT COALESCE(MAX(generation), 0) + 1 FROM review_checks m WHERE m.attempt_key = ?)`;

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


function attemptOf(row: ReviewCheckRow): CheckAttempt {
  return {
    identity: {
      attemptId: row.id,
      generation: row.generation,
      externalId: row.external_id,
      scope: {
        appId: row.bot_id,
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
    publicationId: row.publication_id,
    createState: row.create_state as CheckCreateState,
    desired: row.desired as CheckDesired,
    observed: row.observed as CheckObserved,
    recoveryState: row.recovery_state as CheckRecoveryState,
    executionDeadlineMs: row.execution_deadline_ms,
    attempts: row.attempts,
    terminalMs: row.terminal_ms,
    terminalFailureStatus: row.terminal_failure_status as CheckFailureStatus | null,
    correctionDesired: row.correction_desired as Exclude<CheckDesired, "in_progress"> | null,
    correctionGeneration: row.correction_generation,
    correctionDispatchedMs: row.correction_dispatched_ms,
    createdAtMs: row.created_ms,
  };
}

/** Bound a durable reason (spec §7.9: error ≤300). Never payload content. */
export function checkReason(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return flat.length <= CHECK_ERROR_MAX_CHARS ? flat : flat.slice(0, CHECK_ERROR_MAX_CHARS);
}

function boundText(text: string, max: number): string {
  const flat = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

function frozenTitle(title: string): string {
  const bounded = boundText(title, CHECK_TITLE_MAX_CHARS);
  return bounded.length === 0 ? CHECK_NAME : bounded;
}

async function runFenced(
  db: D1Like,
  id: string,
  lease: Lease,
  sets: string,
  values: unknown[],
  nowMs: CheckClock,
  guard?: string,
  guardValues: unknown[] = [],
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_checks SET updated_ms = ?, ${sets} ` +
        `WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?` +
        ` AND lease_until_ms > ? AND ${NONTERMINAL_WHERE}` +
        `${guard === undefined ? "" : ` AND ${guard}`}`,
    )
    .bind(nowMs, ...values, id, lease.holder, lease.epoch, lease.untilMs, nowMs, ...guardValues)
    .run();
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
  terminalFailureStatus: CheckFailureStatus | null;
  publicationId: string | null;
  correctionDesired: Exclude<CheckDesired, "in_progress"> | null;
  correctionGeneration: number | null;
};

/** Null when the row is gone, the fence is not the caller's live lease, or the attempt already ended. */
export async function getCheckOwnership(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<CheckOwnership | null> {
  const row = await db
    .prepare(
      `SELECT * FROM review_checks
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?` +
        ` AND lease_until_ms > ? AND ${NONTERMINAL_WHERE}`,
    )
    .bind(id, lease.holder, lease.epoch, lease.untilMs, nowMs)
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
    terminalFailureStatus: row.terminal_failure_status as CheckFailureStatus | null,
    publicationId: row.publication_id,
    correctionDesired: attempt.correctionDesired,
    correctionGeneration: attempt.correctionGeneration,
  };
}


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
    attachDeliveryId?: string;
    expect?: { key: string; generation: number };
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
  if (input.expect !== undefined) {
    const active = await db
      .prepare(`SELECT * FROM review_checks WHERE attempt_key = ? AND ${NONTERMINAL_WHERE} ORDER BY generation DESC LIMIT 1`)
      .bind(input.expect.key)
      .first<ReviewCheckRow>();
    return active === null ? { kind: "absent" } : { kind: "busy", attempt: attemptOf(active) };
  }
  const attemptId = crypto.randomUUID();

  const provenPublication = `(
    SELECT COUNT(*) FROM review_checks p
      JOIN review_publications pub ON pub.id = p.publication_id
     WHERE p.attempt_key = ?
       AND pub.bot_id = p.bot_id
       AND pub.installation_id = p.installation_id
       AND pub.owner = p.owner AND pub.repo = p.repo
       AND pub.pr_number = p.pr_number AND pub.head_sha = p.head_sha
       AND pub.kind IN ('review','degraded')
       AND pub.proof_json IS NOT NULL
       AND json_valid(pub.proof_json)
       -- Presence AND JSON type for every required PublicationProof field.
       -- json_type returns NULL for a missing path, so these predicates
       -- enforce presence and type together: a field that is absent, or
       -- present with the wrong JSON type, leaves the proof unproven.
       AND json_type(pub.proof_json, '$.publicationId') = 'text'
       AND json_type(pub.proof_json, '$.headSha') = 'text'
       AND json_type(pub.proof_json, '$.kind') = 'text'
       AND json_type(pub.proof_json, '$.bodySha256') = 'text'
       AND json_type(pub.proof_json, '$.confirmedMs') = 'integer'
       AND json_type(pub.proof_json, '$.round') = 'integer'
       AND json_type(pub.proof_json, '$.commentId') = 'integer'
       AND json_type(pub.proof_json, '$.scope.appId') = 'text'
       AND json_type(pub.proof_json, '$.scope.installationId') = 'integer'
       AND json_type(pub.proof_json, '$.scope.owner') = 'text'
       AND json_type(pub.proof_json, '$.scope.repo') = 'text'
       AND json_type(pub.proof_json, '$.scope.prNumber') = 'integer'
       -- Identity: the embedded proof must agree with the journal row it is
       -- stored on, so JSON that disagrees with its own row is unproven.
       AND json_extract(pub.proof_json, '$.publicationId') = pub.id
       AND json_extract(pub.proof_json, '$.kind') = pub.kind
       AND json_extract(pub.proof_json, '$.headSha') = pub.head_sha
       AND json_extract(pub.proof_json, '$.scope.appId') = pub.bot_id
       AND json_extract(pub.proof_json, '$.scope.installationId') = pub.installation_id
       AND json_extract(pub.proof_json, '$.scope.owner') = pub.owner
       AND json_extract(pub.proof_json, '$.scope.repo') = pub.repo
       AND json_extract(pub.proof_json, '$.scope.prNumber') = pub.pr_number
       -- Values (the contract: round >= 1, commentId > 0, confirmedMs is the
       -- positive Unix-ms stamp of the confirming response, digest 64-hex).
       AND json_extract(pub.proof_json, '$.round') >= 1
       AND json_extract(pub.proof_json, '$.commentId') > 0
       AND json_extract(pub.proof_json, '$.confirmedMs') > 0
       AND length(json_extract(pub.proof_json, '$.bodySha256')) = 64
       AND json_extract(pub.proof_json, '$.bodySha256') NOT GLOB '*[^0-9a-f]*'
  )`;
  const noProvenPublication = `(
    (SELECT COUNT(*) FROM review_checks p
      WHERE p.attempt_key = ? AND p.observed = 'success') = 0
    AND ${provenPublication} = 0
  )`;
  const insert = db
    .prepare(
      `INSERT INTO review_checks
         (id, bot_id, github_app_id, installation_id, owner, repo, pr_number,
          head_sha, triggered_by, action, attempt_key, generation, external_id,
          check_run_id, create_state, holder, lease_epoch, lease_until_ms,
          execution_deadline_ms, desired, desired_title, desired_summary, observed,
          recovery_state, publication_id, attempts, next_attempt_ms, last_error,
          terminal_ms, created_ms, updated_ms, attach_delivery_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ${NEXT_GENERATION_SQL},
              ${EXTERNAL_ID_SQL},
              NULL, 'not-sent', ?, 1, ?, ?,
              'in_progress', NULL, NULL, 'unknown',
              'pending', NULL, 0, NULL, NULL, NULL, ?, ?, ?
         FROM (SELECT 1) AS seed
        WHERE NOT EXISTS (SELECT 1 FROM review_checks o WHERE o.attempt_key = ? AND ${NONTERMINAL_WHERE})
          AND ${noProvenPublication}`,
    )
    .bind(
      attemptId, scope.appId, input.githubAppId, scope.installationId,
      scope.owner, scope.repo, scope.prNumber,
      input.headSha, input.triggeredBy, input.action, key,
      key,
      attemptId, key,
      input.holder, input.executionDeadlineMs, input.executionDeadlineMs,
      nowMs, nowMs, input.attachDeliveryId ?? null,
      key,
      key,
      key,
    );

  try {
    await db.batch([insert]);
  } catch (error) {
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

export async function readCheckIdentity(
  db: D1Like,
  id: string,
): Promise<{ key: string; generation: number } | null> {
  const row = await db
    .prepare(`SELECT attempt_key, generation FROM review_checks WHERE id = ?`)
    .bind(id)
    .first<{ attempt_key: string; generation: number }>();
  return row === null ? null : { key: row.attempt_key, generation: row.generation };
}

/**
 * The open Check identity for an attempt KEY: its generation, read once at
 * freeze time when the settlement holds no handle (a refused claim). The key is
 * the attempt's own, so this names the attempt's row — it is not the "newest
 * open generation" guess the owed mark must never make.
 */
export async function readOpenCheckIdentityForKey(
  db: D1Like,
  key: string,
): Promise<{ key: string; generation: number } | null> {
  const row = await db
    .prepare(
      `SELECT generation FROM review_checks
        WHERE attempt_key = ? AND terminal_ms IS NULL
        ORDER BY generation DESC LIMIT 1`,
    )
    .bind(key)
    .first<{ generation: number }>();
  return row === null ? null : { key, generation: row.generation };
}

/**
 * The `check_run.rerequested` lookup (webhook route): which attempt a remote
 * check run id names, scoped to the GitHub App id — a run another App
 * created never resolves, so this is both the "is it ours" proof and the
 * authoritative owner/repo/pr/head source (a fork PR's delivery carries an
 * empty `pull_requests` list). A remote run id names at most one attempt in
 * practice; the ORDER BY only keeps a duplicate-write accident deterministic.
 */
export async function findCheckAttemptByRunId(
  db: D1Like,
  githubAppId: number,
  checkRunId: number,
): Promise<{ owner: string; repo: string; prNumber: number; headSha: string; installationId: number } | null> {
  const row = await db
    .prepare(
      `SELECT installation_id, owner, repo, pr_number, head_sha FROM review_checks
        WHERE github_app_id = ? AND check_run_id = ?
        ORDER BY created_ms DESC LIMIT 1`,
    )
    .bind(githubAppId, checkRunId)
    .first<{ installation_id: number; owner: string; repo: string; pr_number: number; head_sha: string }>();
  if (row === null) return null;
  return {
    installationId: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
  };
}

export async function getCheckAttempt(db: D1Like, id: string): Promise<CheckAttempt | null> {
  const row = await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(id).first<ReviewCheckRow>();
  return row === null ? null : attemptOf(row);
}
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}


/**
 * Recovery reacquire: ONE conditional UPDATE that repeats the FULL candidate
 * eligibility predicate of `listCheckReconcileBatch` and increments the epoch.
 * A live lease — another holder's or this holder's unexpired one — is never
 * taken, UNLESS the row's intent is already frozen and its holder has been
 * silent for `CHECK_STALE_HOLDER_MS` (see the selector's note): then the lease
 * belongs to a holder that is not coming back. `execution_deadline_ms` is
 * untouched and the recovery lease runs `CHECK_RECOVERY_LEASE_MS` from `nowMs`,
 * so expiry always still means the execution deadline (spec §7.9/§7.11.2).
 *
 * Repeating the selector is not redundancy: selection alone grants no
 * ownership (§7.11.2 step 1), and a row selected as due can stop being due
 * before this statement runs — a backoff moved forward or the attempt cap
 * reached. Every one of those is re-checked HERE, at the claim, against the
 * SAME claim-time `nowMs` the selector would use.
 *
 * `desired = 'in_progress'` is not by itself disqualifying: a row RELEASED to
 * recovery (an abandoned hook, a failed send) may still owe a conclusion from
 * a proof that has not arrived yet, and its release recorded that due time, so
 * it is eligible on `next_attempt_ms` — before the execution deadline. A row
 * with NO due time is withheld until the deadline, UNLESS its attempt's paid
 * result is already durable: a released persisted launch is due as soon as no
 * live lease holds it, because the wait it was released for can never produce
 * the proof (see the predicate's note). The lease stays the one authority in
 * both shapes — this claim never takes a live one.
 *
 * Deliberately spends NO attempt: a budget deferral must not burn a retry
 * (§7.11.2 step 5) — the caller releases the claim instead.
 */
export async function claimCheckRecovery(
  db: D1Like,
  id: string,
  holder: string,
  nowMs: number,
  maxAttempts: number,
): Promise<Lease | null> {
  const claim = await db
    .prepare(
      `UPDATE review_checks
          SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?, updated_ms = ?
        WHERE id = ? AND ${NONTERMINAL_WHERE}
          AND ${CHECK_DUE_PREDICATE}`,
    )
    .bind(holder, nowMs + CHECK_RECOVERY_LEASE_MS, nowMs, id, maxAttempts, nowMs, nowMs, nowMs - CHECK_STALE_HOLDER_MS, nowMs, nowMs, nowMs, nowMs)
    .run();
  if (claim.meta.changes !== 1) return null;
  const row = await db
    .prepare(`SELECT holder, lease_epoch, lease_until_ms FROM review_checks WHERE id = ?`)
    .bind(id)
    .first<Pick<ReviewCheckRow, "holder" | "lease_epoch" | "lease_until_ms">>();
  if (row === null || row.holder !== holder || row.lease_until_ms === null) return null;
  return { holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms };
}

/**
 * Adopt a RELEASED attempt (spec §7.7 step 4 / §7.9): the delivery path
 * creates the run at acceptance and gives the row back, so the admitted
 * message can take it over and terminalize inline instead of leaving the run
 * to the reconciler.
 *
 * ONE conditional UPDATE, like every other claim. Two shapes are adoptable:
 *
 *   - the row is RELEASED (no holder, no lease) — the ordinary attach; and
 *   - the row is held by a STALLED DELIVERY holder: `holder` still starts with
 *     `delivery:`, its lease is live, and it has written nothing for
 *     `CHECK_ATTACH_HOLDER_STALE_MS`. That is the overlap the ordering cannot
 *     remove (the delivery path waits a bounded time and then lets the attach
 *     finish on the invocation context), and a delivery holder silent for
 *     seconds is stalled — it only mints one token, creates one run and writes
 *     two rows. A CONSUMER holder is never taken: its silence is the model
 *     running, and it is minutes, not seconds.
 *
 * Either way the row must still want `in_progress`, carry a KNOWN run id
 * (nothing else is adoptable: a row without a proven run has no handle to
 * return) and still be inside its window. The epoch is bumped, so a late write
 * from the attach's own holder is refused by the same fence every other
 * mutation uses.
 *
 * `execution_deadline_ms` is NARROWED here to the adopted lease: the attach
 * window is long only so a queued message can still find its run, while the
 * execution window is whatever the caller passes as `executionDeadlineMs` —
 * the attempt's frozen absolute deadline, so the reconciler reads the same
 * instant the execution fence does.
 */
export async function adoptReleasedCheckAttempt(
  db: D1Like,
  input: {
    attemptId: string;
    githubAppId: number;
    holder: string;
    executionDeadlineMs: number;
    nowMs: number;
  },
): Promise<Lease | null> {
  if (input.holder.length === 0) {
    throw new Error("review-checks: adoption requires a nonblank holder identity");
  }
  if (input.executionDeadlineMs <= input.nowMs) {
    throw new Error("review-checks: execution deadline must be after the adoption time");
  }
  const adopted = await db
    .prepare(
      `UPDATE review_checks
          SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?,
              execution_deadline_ms = ?, updated_ms = ?
        WHERE id = ? AND ${NONTERMINAL_WHERE}
          AND recovery_state IN ('pending','remote-unconfirmed')
          AND desired = 'in_progress'
          AND create_state = 'known' AND check_run_id IS NOT NULL
          AND github_app_id = ?
          AND execution_deadline_ms > ?
          AND (
            (holder IS NULL AND lease_until_ms IS NULL)
            OR (holder LIKE 'delivery:%' AND lease_until_ms > ? AND updated_ms <= ?)
          )`,
    )
    .bind(
      input.holder,
      input.executionDeadlineMs,
      input.executionDeadlineMs,
      input.nowMs,
      input.attemptId,
      input.githubAppId,
      input.nowMs,
      input.nowMs,
      input.nowMs - CHECK_ATTACH_HOLDER_STALE_MS,
    )
    .run();
  if (adopted.meta.changes !== 1) return null;
  const row = await db
    .prepare(`SELECT holder, lease_epoch, lease_until_ms FROM review_checks WHERE id = ?`)
    .bind(input.attemptId)
    .first<Pick<ReviewCheckRow, "holder" | "lease_epoch" | "lease_until_ms">>();
  if (row === null || row.holder !== input.holder || row.lease_until_ms === null) return null;
  return { holder: input.holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms };
}

/**
 * Take the ATTACH row of one delivery for settlement (spec §7.9): a delivery
 * that is skipped BEFORE execution must close its attached run, and the skip
 * path holds no handle. This is the same fenced one-statement claim as
 * `adoptReleasedCheckAttempt`, keyed by the delivery's own `attempt_key`
 * instead of an attempt id.
 *
 * TWO shapes are taken, and only these:
 *
 *   - a row still held by THIS delivery's own attach holder
 *     (`holder = delivery:<attachDeliveryId>`, ANY age — fresh or stale); and
 *   - a RELEASED row (`holder IS NULL AND lease_until_ms IS NULL`) **created by
 *     this delivery** (`attach_delivery_id = <attachDeliveryId>`).
 *
 * The IDENTITY is what separates the two failure modes a staleness window could
 * not: taking a fresh `delivery:*` holder may be this delivery's own attach
 * (which has already created the run and only needs to finish releasing), but
 * it may equally be ANOTHER delivery's run — the same `attempt_key` is shared
 * by every delivery of one event — and settling that one would close a live
 * review's Check `neutral` (a premature pass). The creator COLUMN covers the
 * other arm: the attach may still be running when the message is enqueued (the
 * inline budget expired), so its row is released only later and no holder names
 * it — without the column that run would close red at the deadline.
 *
 * A consumer holder, another delivery's holder, a frozen intent and a terminal
 * row are therefore never taken; a row nobody releases stays with the
 * grace/deadline lane. A delivery whose attach found the key owned created no
 * row, so its settlements are no-ops by the predicate itself.
 *
 * The candidate is SELECTed first only to learn its id; the UPDATE repeats
 * every predicate, so a row that stopped being claimable between the two
 * statements writes nothing.
 */
export async function claimAttachedCheckForSettlement(
  db: D1Like,
  input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    attachDeliveryId?: string;
    holder: string;
    executionDeadlineMs: number;
    nowMs: number;
  },
): Promise<{ attempt: CheckAttempt; lease: Lease } | null> {
  if (input.holder.length === 0) {
    throw new Error("review-checks: settlement requires a nonblank holder identity");
  }
  if (input.attachDeliveryId === undefined || input.attachDeliveryId === null || input.attachDeliveryId.length === 0) {
    return null;
  }
  if (input.executionDeadlineMs <= input.nowMs) {
    throw new Error("review-checks: execution deadline must be after the settlement time");
  }
  const key = attemptKey({
    appId: input.scope.appId,
    installationId: input.scope.installationId,
    owner: input.scope.owner,
    repo: input.scope.repo,
    prNumber: input.scope.prNumber,
    headSha: input.headSha,
    triggeredBy: input.triggeredBy,
    action: input.action,
  });
  const claimable = `terminal_ms IS NULL
          AND create_state = 'known' AND check_run_id IS NOT NULL
          AND desired = 'in_progress'
          AND recovery_state IN ('pending','remote-unconfirmed')
          AND execution_deadline_ms > ?
          AND (
            holder = ?
            OR (holder IS NULL AND lease_until_ms IS NULL AND attach_delivery_id = ?)
          )`;
  const ownHolder = `delivery:${input.attachDeliveryId}`;
  const candidate = await db
    .prepare(`SELECT id FROM review_checks WHERE attempt_key = ? AND ${claimable} ORDER BY generation DESC LIMIT 1`)
    .bind(key, input.nowMs, ownHolder, input.attachDeliveryId)
    .first<{ id: string }>();
  if (candidate === null) return null;
  const claimed = await db
    .prepare(
      `UPDATE review_checks
          SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?,
              execution_deadline_ms = ?, updated_ms = ?
        WHERE id = ? AND attempt_key = ? AND ${claimable}`,
    )
    .bind(
      input.holder,
      input.executionDeadlineMs,
      input.executionDeadlineMs,
      input.nowMs,
      candidate.id,
      key,
      input.nowMs,
      ownHolder,
      input.attachDeliveryId,
    )
    .run();
  if (claimed.meta.changes !== 1) return null;
  const row = await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(candidate.id).first<ReviewCheckRow>();
  if (row === null || row.holder !== input.holder || row.lease_until_ms === null) return null;
  return {
    attempt: attemptOf(row),
    lease: { holder: input.holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms },
  };
}

/**
 * Release a recovery claim WITHOUT spending an attempt (spec §7.11.2 step 5:
 * a budget deferral "does not spend an attempt"; the same applies to a paused
 * App's not-sent row, which must stay due rather than be charged). Everything
 * except the lease is preserved — attempts, `next_attempt_ms`, desired,
 * observed, the remote IDs, the proof link and `last_error` all stay exactly
 * as they were, so the next selector pass in the same window sees the row due
 * again immediately instead of waiting out a 120s lease.
 *
 * `deferCheckRecovery` is deliberately NOT used here: it increments `attempts`
 * and rewrites the due time, which is the correct shape for a recovery action
 * that actually failed and the wrong shape for one that never ran.
 */
export async function releaseCheckClaim(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<boolean> {
  return runFenced(db, id, lease, `holder = NULL, lease_until_ms = NULL`, [], nowMs);
}

/**
 * Renew the EXECUTION lease under the same fence the claim established
 * (spec §7.9). Renewal moves only the lease window — `lease_until_ms` is
 * re-stamped to a fresh `CHECK_LEASE_MS` window, never shortened, and CAPPED by
 * the immutable `execution_deadline_ms`, which this statement never writes: a
 * renewal can never extend the attempt's absolute hard stop. The epoch does not
 * move either, because renewal is the same holder keeping what it already holds,
 * not a takeover. The returned lease is the one every later fenced write must
 * carry (the fence matches the exact triple); `null` means this is no longer
 * the live lease, and nothing was written.
 *
 * Nothing here concerns publication: the publication lease is a different row,
 * taken and released around one mutation, and neither lease may decide the
 * other's liveness.
 */
export async function renewCheckLease(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<Lease | null> {
  const renewed = await db
    .prepare(
      `UPDATE review_checks
          SET lease_until_ms = MAX(lease_until_ms, MIN(?, execution_deadline_ms)), updated_ms = ?
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?
          AND lease_until_ms > ? AND ${NONTERMINAL_WHERE}
        RETURNING holder, lease_epoch, lease_until_ms`,
    )
    .bind(nowMs + CHECK_LEASE_MS, nowMs, id, lease.holder, lease.epoch, lease.untilMs, nowMs)
    .run<{ holder: string; lease_epoch: number; lease_until_ms: number | null }>();
  const written = renewed.results[0];
  if (
    written === undefined ||
    written.holder !== lease.holder ||
    written.lease_epoch !== lease.epoch ||
    written.lease_until_ms === null ||
    written.lease_until_ms < lease.untilMs ||
    (written.lease_until_ms !== lease.untilMs && written.lease_until_ms > nowMs + CHECK_LEASE_MS)
  ) {
    return null;
  }
  return { holder: written.holder, epoch: written.lease_epoch, untilMs: written.lease_until_ms };
}

/**
 * Release a successfully ATTACHED attempt with a due time (spec §7.9): the
 * admitted message adopts the row immediately (adoption ignores
 * `next_attempt_ms`), while the recovery lane may take it once the grace has
 * passed — so a released attach row that nobody claims is closed by the same
 * lane as every other Check instead of staying invisible until the attach
 * window expires. Writes nothing else: identity, run id, `create_state`,
 * `desired` and `recovery_state` are preserved, and no attempt is spent.
 */
export async function releaseAttachedCheck(
  db: D1Like,
  id: string,
  lease: Lease,
  nextAttemptMs: number,
  nowMs: CheckClock,
): Promise<boolean> {
  return runFenced(db, id, lease, `holder = NULL, lease_until_ms = NULL, next_attempt_ms = ?`, [nextAttemptMs], nowMs);
}

/**
 * Give the recovery claim back while WAITING for a publication proof: the row
 * keeps its frozen intent and its `recovery_state`, spends NO attempt, and is
 * due again after `nextAttemptMs`. Used when the exact scope/head still owns an
 * in-flight publication journal (spec §7.11.2): terminalizing the unconfirmed
 * fallback before that publication proves itself would close the run for good,
 * and burning the attempt budget while it waits would exhaust it for no reason.
 */
export async function deferCheckForPendingPublication(
  db: D1Like,
  id: string,
  lease: Lease,
  nextAttemptMs: number,
  nowMs: CheckClock,
): Promise<boolean> {
  return runFenced(db, id, lease, `holder = NULL, lease_until_ms = NULL, next_attempt_ms = ?`, [nextAttemptMs], nowMs);
}

/**
 * Persist the publication an attempt was handed off to, without concluding
 * anything: a `runFenced` write of `publication_id` ALONE. A hand-off attempt
 * publishes nothing itself, so the journal row it found is the only proof its
 * Check can ever be decided from — linking it keeps the proof able to decide
 * (`readProof` reads exactly this id) instead of freezing a conclusion here.
 *
 * Nothing else moves: `desired` stays `in_progress`, no title/summary is
 * frozen, and the caller releases the lease separately. `false` means the
 * fence refused — the lease died, another holder took over, or the row already
 * ended — and the row was left exactly as it was.
 */
export async function linkCheckPublication(
  db: D1Like,
  id: string,
  lease: Lease,
  publicationId: string,
  nowMs: CheckClock,
): Promise<boolean> {
  return runFenced(db, id, lease, `publication_id = COALESCE(?, publication_id)`, [publicationId], nowMs);
}

/**
 * The identity-fenced twin of `releaseCheckClaim`, for the one caller that
 * reports a refusal WITHOUT counting a request: `beginCheck` answering
 * `requests: 0`.
 *
 * §7.11.2 step 5 wants such a row left due with no attempt spent — and the
 * adapter already classified it (it learned `requests === 0` and released its own
 * claim). But `releaseCheckClaim`'s `lease_until_ms > now` condition can fail
 * on exactly this path, because a zero-request refusal is typically the
 * live-time fence itself: the lease legitimately expired while the client was
 * resolved, so a liveness-fenced release writes nothing and the recovery sweep would leave the
 * row leased and invisible to the next selector.
 *
 * Fencing on holder + epoch + lease-end equality instead proves ownership
 * without demanding the row still be unexpired. A newer claimant always bumps
 * `lease_epoch`, and a same-holder reacquire runs through `claimCheckRecovery`,
 * which also bumps it — so the epoch is the discriminator, and the exact
 * `lease_until_ms` match adds the case where an expired lease was never
 * reclaimed. Writes nothing else: no attempt, backoff, error, or identity.
 */
export async function releaseExpiredCheckClaim(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET holder = NULL, lease_until_ms = NULL, updated_ms = ?
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?
          AND ${NONTERMINAL_WHERE}`,
    )
    .bind(nowMs, id, lease.holder, lease.epoch, lease.untilMs)
    .run();
  return result.meta.changes === 1;
}


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
  nowMs: CheckClock,
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
    `(create_state IN ('sending','unknown') OR (create_state = 'known' AND check_run_id = ?))`,
    [checkRunId],
  );
}

/**
 * Move `create_state` under the live lease (spec §7.9: "persist
 * create_state=sending before create"; a lost response sets `unknown`; a
 * definitive pre-send rejection reverts to `not-sent`). `known` is reachable
 * only through `attachCheckRunId`, and no path here clears a known remote id.
 *
 * Legal transitions are enforced IN SQL, because the dangerous shape is not a
 * caller typo but a race: `sending`/`unknown` mean a create may have reached
 * GitHub. Reverting either to `not-sent` would declare the attempt createable
 * again, and a later `beginCheck` would then mint a SECOND run for the same
 * head — exactly the blind recreate RL-12 forbids. So `not-sent` (the
 * definitive pre-send rejection) is reachable only from `not-sent`; a
 * possibly-sent state is resolved by read-only adoption, never by reset.
 *
 * A `sending` mark is a TRANSITION, not an error: with no explicit `reason` it
 * leaves any existing `last_error` exactly as it found it, so marking a send
 * attempt never fabricates a diagnostic and never erases a real one. A
 * caller-supplied reason (the `unknown` leg, which genuinely records why) still
 * writes its bounded text.
 */
export async function setCheckCreateState(
  db: D1Like,
  id: string,
  lease: Lease,
  state: Exclude<CheckCreateState, "known">,
  reason: string | undefined,
  nowMs: CheckClock,
): Promise<boolean> {
  if (state === "not-sent") {
    return runFenced(
      db,
      id,
      lease,
      `create_state = 'not-sent', last_error = NULL`,
      [],
      nowMs,
      `create_state = 'not-sent' AND check_run_id IS NULL`,
    );
  }
  return runFenced(
    db,
    id,
    lease,
    `create_state = ?, last_error = COALESCE(?, last_error)`,
    [state, reason === undefined ? null : checkReason(reason)],
    nowMs,
  );
}

/**
 * Record that a terminal update is ABOUT to be sent (migration 0089, §7.9a).
 *
 * Written in the same fenced statement that holds the attempt, immediately
 * before the request: from this instant the outcome is UNKNOWN, so no lane may
 * send this action again — a second send could double a request the first one
 * already landed. Only readback may resolve it. Cleared by a validated response
 * (`recordCheckObservation`, the dispatch resolved) or by a refusal PROVEN
 * pre-send (`clearTerminalDispatch`, nothing left the Worker).
 *
 * The intent deliberately outlives `terminal_ms`: the late correction re-sends
 * on a terminal row once — and only once — because its own dispatch resolved
 * and cleared the mark.
 *
 * A dispatch recorded while a §7.9a correction is OWED also stamps the debt's
 * own `correction_dispatched_ms`: from then on that revision may be on GitHub
 * and can only be read back, never rewritten (see `replaceCheckCorrection`).
 */
export async function recordTerminalDispatch(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET terminal_dispatch_ms = ?,
              correction_dispatched_ms = CASE
                WHEN correction_desired IS NULL THEN correction_dispatched_ms
                ELSE COALESCE(correction_dispatched_ms, ?) END,
              updated_ms = ?
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?
          AND terminal_dispatch_ms IS NULL`,
    )
    .bind(nowMs, nowMs, nowMs, id, lease.holder, lease.epoch, lease.untilMs)
    .run();
  return result.meta.changes === 1;
}

/**
 * Clear the dispatch intent after a refusal PROVEN not to have left the Worker.
 * The owed revision's own dispatch bit goes with it for the same reason: the
 * request it recorded was never sent, so the revision is still rewritable.
 */
export async function clearTerminalDispatch(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET terminal_dispatch_ms = NULL, correction_dispatched_ms = NULL, updated_ms = ?
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?
          AND terminal_dispatch_ms IS NOT NULL`,
    )
    .bind(nowMs, id, lease.holder, lease.epoch, lease.untilMs)
    .run();
  return result.meta.changes === 1;
}

/** The attempt's dispatch intent, or null when no terminal update was sent. */
export async function readTerminalDispatch(db: D1Like, id: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT terminal_dispatch_ms FROM review_checks WHERE id = ?`)
    .bind(id)
    .first<{ terminal_dispatch_ms: number | null }>();
  return row?.terminal_dispatch_ms ?? null;
}

/**
 * Undo a `sending` mark for a create that provably NEVER dispatched (spec §7.9
 * / RL-12 together with the `requests: 0` contract).
 *
 * The ordinary `not-sent` transition above is fenced on a LIVE lease, because a
 * `sending` row that might have reached GitHub must never be declared
 * createable again. That reasoning does not apply here: the caller has already
 * established that the Checks callable was never invoked, so restoring
 * `not-sent` states a fact rather than erasing one.
 *
 * The fence is therefore IDENTITY, not liveness. This path is reached exactly
 * when the live-time fence may already be false — the refusal that triggers it
 * IS a failed `lease_until_ms > now` re-proof — so demanding liveness would make
 * the rollback unreachable precisely when it is needed, and the row would stay
 * `sending` forever with no request behind it. A newer claimant always bumps
 * `lease_epoch`, so holder + epoch + lease-end equality proves the row is still
 * OURS and no third party's state can be overwritten.
 *
 * Nothing else moves: no attempt, no backoff, no identity, and `check_run_id` is
 * guarded NULL so a real remote run is never disguised. `last_error` is
 * deliberately NOT touched, which is exactly correct: the `sending` mark no
 * longer fabricates a diagnostic (see `setCheckCreateState`), so whatever error
 * text the row carried before the mark is still the true one and is preserved
 * by leaving it alone.
 */
export async function rollbackCheckCreateDispatch(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET create_state = 'not-sent', updated_ms = ?
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND lease_until_ms = ?
          AND create_state = 'sending' AND check_run_id IS NULL
          AND ${NONTERMINAL_WHERE}`,
    )
    .bind(nowMs, id, lease.holder, lease.epoch, lease.untilMs)
    .run();
  return result.meta.changes === 1;
}

/**
 * Freeze the terminal intent BEFORE any remote update (spec §7.9 "Desired
 * versus observed"): conclusion, bounded title/summary, the approved failure
 * category and the publication proof link. The type excludes `in_progress`.
 *
 * Monotonic with exactly one documented exception: a `failure` decided while
 * publication was unknown may be corrected to `success`/`neutral` when positive
 * proof turns up, and the correction is honored ONLY when the caller supplies
 * that proof link (spec §7.9: "newly discovered positive publication proof may
 * correct a previously unknown failure into success/neutral on the same owned
 * run; record that correction, do not create another run") AND the frozen
 * category is absent or `unknown-failure` — a `cap-stop`/`budget-stop` names
 * why the attempt ended and is never rewritten by a proof. Any other change —
 * a downgrade, a lateral swap, a correction with no proof, or a correction of a
 * known stop — returns false.
 *
 * A re-write of the SAME desired is the idempotent replay case, and it is a
 * NO-OP on the frozen fields: the title, the text and the category that selects
 * it are what the user may already have seen, so a second writer (a recovery
 * pass, a duplicate settlement, an interrupted caller) can only link the proof
 * and refresh the recovery bookkeeping. Changing the wording is the correction
 * above — a different `desired` with proof — or nothing.
 */
export async function setCheckDesired(
  db: D1Like,
  id: string,
  lease: Lease,
  conclusion: CheckConclusion,
  publicationId: string | null,
  nowMs: CheckClock,
): Promise<boolean> {
  const current = await getCheckOwnership(db, id, lease, nowMs);
  if (current === null) return false;
  const was = current.desired;
  const replay = was === conclusion.desired;
  if (was !== "in_progress" && !replay) {
    const causeUnknown =
      current.terminalFailureStatus === null || current.terminalFailureStatus === "unknown-failure";
    const correction =
      was === "failure" &&
      causeUnknown &&
      (conclusion.desired === "success" || conclusion.desired === "neutral");
    if (!correction || publicationId === null) return false;
  }
  if (replay) {
    return runFenced(
      db,
      id,
      lease,
      `publication_id = COALESCE(?, publication_id),
              recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
      [publicationId],
      nowMs,
    );
  }
  const title = frozenTitle(conclusion.title);
  const summary = boundText(conclusion.summary, CHECK_SUMMARY_MAX_CHARS);
  return runFenced(
    db,
    id,
    lease,
    `desired = ?, desired_title = ?, desired_summary = ?, terminal_failure_status = ?,
            publication_id = COALESCE(?, publication_id),
            terminal_dispatch_ms = CASE WHEN desired = ? AND desired_summary = ? THEN terminal_dispatch_ms ELSE NULL END,
            recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
    [conclusion.desired, title, summary, conclusion.failureStatus ?? null, publicationId, conclusion.desired, summary],
    nowMs,
  );
}

/**
 * The GIVE-UP fallback intent: written ONLY while the row still wants
 * `in_progress`. The guard lives in the UPDATE (spec §7.9's fence), never in a
 * read-then-write, so a terminalize that froze proof-derived text — a success,
 * or the precise failure its proof produced — keeps BOTH its conclusion and its
 * summary even when the two writes interleave inside the same live lease.
 *
 * Used by `abandonTerminalize` only; every other intent write goes through
 * `setCheckDesired` and its monotonicity rule.
 */
export async function setCheckFallbackDesired(
  db: D1Like,
  id: string,
  lease: Lease,
  conclusion: CheckConclusion,
  nowMs: CheckClock,
): Promise<boolean> {
  const title = frozenTitle(conclusion.title);
  const summary = boundText(conclusion.summary, CHECK_SUMMARY_MAX_CHARS);
  return runFenced(
    db,
    id,
    lease,
    `desired = ?, desired_title = ?, desired_summary = ?, terminal_failure_status = ?,
            recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
    [conclusion.desired, title, summary, conclusion.failureStatus ?? null],
    nowMs,
    "desired = 'in_progress'",
  );
}

/**
 * Say on the attached run that this delivery is QUEUED behind the PR's live
 * review. The in-flight guard refuses a delivery whose PR is being reviewed and
 * that delivery retries minutes later, but its Check was attached at webhook
 * time — so the public surface showed `in_progress` for the whole backoff with
 * nothing saying why (measured on staging 2026-11-13: 41 of 49 minutes of one
 * run were queue time). This relabels it.
 *
 * Only the FROZEN TEXT moves: `desired`, the conclusion, `observed` and the recovery state
 * stay exactly as they are, so this can neither retire a head nor answer for a
 * review that never ran. The text is bounded and flattened here for the same
 * reason `setCheckDesired` bounds it — a Check summary is public — and a later
 * terminalize overwrites both fields with its own conclusion.
 *
 * Fenced on the delivery's OWN attach identity AND its ownership of the row: the
 * `attempt_key` + `attach_delivery_id` pair names the delivery that CREATED this
 * row, and the holder arm below proves nobody else is using it. A duplicate
 * delivery shares the attempt key, and a second delivery may have ADOPTED this
 * row and be running the review (adoption never clears the creator column) — in
 * both cases the live review's run must not be relabelled. The UPDATE repeats
 * every predicate, so a row that went terminal, was never created, changed
 * hands, or whose intent another lane froze between the read and the write is
 * left alone.
 *
 * Returns the relabelled row — its id is the key of the publication lease the
 * caller must take before the PATCH, and the run id is the target — or null
 * when there was nothing to label.
 */
export async function markCheckQueuedBehindInflight(
  db: D1Like,
  input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    attachDeliveryId?: string;
    title: string;
    summary: string;
    nowMs: number;
  },
): Promise<{ id: string; checkRunId: number } | null> {
  if (input.attachDeliveryId === undefined || input.attachDeliveryId.length === 0) return null;
  const key = attemptKey({
    appId: input.scope.appId,
    installationId: input.scope.installationId,
    owner: input.scope.owner,
    repo: input.scope.repo,
    prNumber: input.scope.prNumber,
    headSha: input.headSha,
    triggeredBy: input.triggeredBy,
    action: input.action,
  });
  const relabelable = `terminal_ms IS NULL
          AND create_state = 'known' AND check_run_id IS NOT NULL
          AND desired = 'in_progress'
          AND recovery_state IN ('pending','remote-unconfirmed')
          AND (holder IS NULL OR holder = 'delivery:' || ?)`;
  const candidate = await db
    .prepare(
      `SELECT id, check_run_id FROM review_checks
         WHERE attempt_key = ? AND attach_delivery_id = ? AND ${relabelable}
         ORDER BY generation DESC LIMIT 1`,
    )
    .bind(key, input.attachDeliveryId, input.attachDeliveryId)
    .first<{ id: string; check_run_id: number }>();
  if (candidate === null) return null;
  const relabeled = await db
    .prepare(
      `UPDATE review_checks SET desired_title = ?, desired_summary = ?, updated_ms = ?
         WHERE attempt_key = ? AND attach_delivery_id = ? AND ${relabelable}`,
    )
    .bind(
      frozenTitle(input.title),
      boundText(input.summary, CHECK_SUMMARY_MAX_CHARS),
      input.nowMs,
      key,
      input.attachDeliveryId,
      input.attachDeliveryId,
    )
    .run();
  return relabeled.meta.changes === 1 ? { id: candidate.id, checkRunId: candidate.check_run_id } : null;
}

/**
 * Record WHY an attempt reached (or never reached) its conclusion, on the
 * attempt itself (migration 0052).
 *
 * Diagnostic only: every exit of the terminalize hook used to report through
 * `log.warn`, which is not queryable after the fact, so a Check that only
 * closed at the 900 s execution deadline left no evidence of whether the
 * consumer ran the hook, timed it out, or never held a handle at all.
 *
 * Deliberately unfenced and WITHOUT touching `updated_ms`: the caller records
 * after a lease release or a fence refusal, exactly when a fenced write would
 * be refused, and `updated_ms` is the silence clock the stale-holder takeover
 * reads (spec §7.9) — a diagnostic write must not buy a dead holder another
 * two minutes. A store fault here never changes the Check or the review.
 */
export async function recordTerminalizeOutcome(
  db: D1Like,
  id: string,
  outcome: "completed" | "budget-exceeded" | "hook-failed" | "no-handle",
  elapsedMs: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE review_checks
          SET terminalize_outcome = CASE
                WHEN ? = 'completed'
                 AND NOT (observed = desired AND desired <> 'in_progress')
                THEN 'handed-off' ELSE ? END,
              terminalize_elapsed_ms = ?
        WHERE id = ? AND terminalize_outcome IS NULL`,
    )
    .bind(outcome, outcome, elapsedMs, id)
    .run();
}

/**
 * Advance `observed` from a remote payload whose identity ALREADY matches the
 * persisted row (spec §7.9: "Mark observed only when the response (or a
 * subsequent GET) has matching identity, status=completed and the intended
 * conclusion"). Identity = the run's `external_id`, `head_sha`, `name`, owning
 * `app.id`, and — once attached — the persisted `check_run_id`.
 *
 * A completed run is delivery only when it carries the persisted conclusion AND
 * the frozen summary: a conclusion-only match is what an earlier writer left
 * behind, so it is never an observation of this attempt. An in-progress payload
 * is recorded only while nothing terminal is observed yet. `false` means nothing
 * was written; the caller then records `remote-unconfirmed` through
 * `deferCheckRecovery`.
 */
export async function recordCheckObservation(
  db: D1Like,
  id: string,
  lease: Lease,
  remote: CheckRemote,
  nowMs: CheckClock,
  options?: { conclusionUnproven?: boolean },
): Promise<boolean> {
  const owned = await getCheckOwnership(db, id, lease, nowMs);
  if (owned === null) return false;
  const { identity } = owned;
  if (remote.external_id !== identity.externalId) return false;
  if (remote.head_sha !== identity.headSha) return false;
  if (remote.name !== CHECK_NAME) return false;
  if (remote.app === null || remote.app.id !== identity.githubAppId) return false;
  if (owned.checkRunId !== null && owned.checkRunId !== remote.id) return false;

  const agrees =
    remote.status === "completed" &&
    owned.desired !== "in_progress" &&
    remote.conclusion === owned.desired &&
    remote.summary === owned.desiredSummary;
  const running = remote.status === "queued" || remote.status === "in_progress" || remote.status === "pending";
  if (!agrees && !running) return false;
  if (running && owned.observed !== "unknown") return false;

  const observed: CheckObserved = agrees ? (owned.desired as Exclude<CheckDesired, "in_progress">) : "in_progress";
  const unproven =
    agrees && options?.conclusionUnproven === true && owned.publicationId !== null;
  const debtSettled =
    owned.correctionDesired === null ||
    (owned.correctionDesired === owned.desired &&
      owned.correctionGeneration === owned.identity.generation);
  const settles = agrees && debtSettled;
  return runFenced(
    db,
    id,
    lease,
    `observed = ?,
            check_run_id = COALESCE(check_run_id, ?),
            create_state = CASE WHEN check_run_id IS NULL THEN 'known' ELSE create_state END,
            recovery_state = CASE WHEN ? THEN 'done' WHEN ? THEN 'remote-unconfirmed' ELSE recovery_state END,
            terminal_ms = CASE WHEN ? THEN ? ELSE terminal_ms END,
            terminal_dispatch_ms = CASE WHEN ? THEN NULL ELSE terminal_dispatch_ms END,
            next_attempt_ms = CASE WHEN ? THEN NULL ELSE next_attempt_ms END,
            last_error = CASE WHEN ? THEN NULL ELSE last_error END,
            correction_desired = CASE WHEN ? THEN NULL ELSE correction_desired END,
            correction_generation = CASE WHEN ? THEN NULL ELSE correction_generation END,
            correction_dispatched_ms = CASE WHEN ? THEN NULL ELSE correction_dispatched_ms END`,
    [
      observed,
      remote.id,
      settles && !unproven ? 1 : 0,
      settles && unproven ? 1 : 0,
      settles ? 1 : 0,
      nowMs ?? lease.untilMs,
      agrees ? 1 : 0,
      agrees ? 1 : 0,
      agrees ? 1 : 0,
      settles ? 1 : 0,
      settles ? 1 : 0,
      settles ? 1 : 0,
    ],
    nowMs,
  );
}

const CORRECTABLE_NOW_SQL = `EXISTS (
            SELECT 1 FROM review_publications pub
             WHERE pub.id = review_checks.publication_id
               AND pub.proof_json IS NOT NULL
               AND json_valid(pub.proof_json)
               AND json_extract(pub.proof_json, '$.publicationId') = review_checks.publication_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_checks n
             WHERE n.attempt_key = review_checks.attempt_key
               AND n.${NONTERMINAL_WHERE}
               AND n.generation > review_checks.generation
          )
          AND EXISTS (
            SELECT 1 FROM bot_installations ai
              JOIN review_bots ga ON ga.id = ai.bot_id
             WHERE ai.bot_id = review_checks.bot_id
               AND ai.installation_id = review_checks.installation_id
               AND ga.status = 'active' AND ga.deleted_at IS NULL
          )`;

/**
 * Reopen a TERMINAL unconfirmed failure for its own publication's confirmed
 * outcome — the one revision a terminal Check record permits (spec §7.9a: the
 * record asserts an outcome; evidence that contradicts it means the record is
 * not proof).
 *
 * The row is only reachable through the shape `recordCheckObservation` writes
 * for a proof-free update (`recovery_state = 'remote-unconfirmed'` while
 * terminal). Reopening CLEARS that mark in the same statement, so the
 * revision is available exactly once: the guard is the write's own predicate,
 * never a read-then-write in the caller. It also clears the finished lease,
 * because the consumer that terminalized the row is gone and the correction
 * must be immediately claimable.
 *
 * `publicationId` must be the row's OWN link, and that linked row must CARRY a
 * proof (the same test the store's proof reader applies). The caller reads it
 * through the link first, so this guard binds the revision to that exact
 * publication's confirmed outcome (spec §7.9a conditions 1-3): a different
 * publication's confirmation, an unlinked unconfirmed row, or a link still
 * without proof all match nothing. `attempts` resets because the revision is a
 * new obligation carrying new evidence, not another try of the failed one; its
 * own sends are then bounded by the ordinary recovery cap.
 *
 * The SAME statement records the obligation as OWED: `conclusion` (decided from
 * that proof) plus the generation it targets. A pass the request budget defers
 * before dispatch therefore leaves the correction durable, and the pass that
 * finally sends it clears the record through `recordCheckObservation` — the
 * same fenced write that resolves a successful send. One pair of columns is one
 * slot, so a row can never queue a second correction behind an owed one.
 *
 * `false` means the row is no longer that shape — already reopened (a second
 * caller, or a second confirmation), already corrected, or never marked.
 */
export async function reopenTerminalCorrection(
  db: D1Like,
  id: string,
  publicationId: string,
  conclusion: Exclude<CheckDesired, "in_progress">,
  nowMs: CheckClock,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_checks
         SET terminal_ms = NULL, recovery_state = 'pending', attempts = 0,
             next_attempt_ms = NULL, last_error = NULL, holder = NULL,
             lease_until_ms = NULL,
             correction_desired = ?, correction_generation = generation,
             correction_dispatched_ms = NULL,
             updated_ms = ?
       WHERE id = ? AND terminal_ms IS NOT NULL
         AND recovery_state = 'remote-unconfirmed'
         AND desired = 'failure' AND observed = 'failure'
         AND publication_id = ?
         AND ${CORRECTABLE_NOW_SQL}`,
    )
    .bind(conclusion, nowMs, id, publicationId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Re-decide an owed revision IN PLACE — the authorization to correct the
 * original failure is separate from the conclusion it currently owes, and only
 * a send consumes the authorization.
 *
 * Used when the same linked proof now decides a different conclusion (an
 * operator lowered or raised the score floor) and the revision has provably not
 * left the Worker: rewriting it cannot double a request. The generation is
 * unchanged (the debt still targets this row); the frozen intent is overwritten
 * with the new conclusion because the old one was never sent, and the guard
 * refuses the write the moment `correction_dispatched_ms` is set.
 */
export async function replaceCheckCorrection(
  db: D1Like,
  id: string,
  lease: Lease,
  conclusion: CheckConclusion,
  nowMs: CheckClock,
): Promise<boolean> {
  const title = frozenTitle(conclusion.title);
  const summary = boundText(conclusion.summary, CHECK_SUMMARY_MAX_CHARS);
  return runFenced(
    db,
    id,
    lease,
    `correction_desired = ?, correction_dispatched_ms = NULL,
            desired = ?, desired_title = ?, desired_summary = ?, terminal_failure_status = ?,
            terminal_dispatch_ms = NULL,
            recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
    [conclusion.desired, conclusion.desired, title, summary, conclusion.failureStatus ?? null],
    nowMs,
    "correction_desired IS NOT NULL AND correction_dispatched_ms IS NULL",
  );
}

/**
 * Drop a correction this row can no longer owe because the EVIDENCE moved.
 * The obligation goes AND so does the intent the owed revision froze: leaving a
 * positive `success` behind would let the ordinary lane send a conclusion this
 * attempt no longer establishes, because the monotonic freeze refuses to lower
 * it again. The row stays SELECTABLE (`pending`, due now) so the next pass
 * decides from CURRENT evidence — unlike `parkCheckCorrection`, whose target
 * generation can never conclude.
 */
export async function dropCheckCorrection(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<boolean> {
  return runFenced(
    db,
    id,
    lease,
    `correction_desired = NULL, correction_generation = NULL,
            desired = 'in_progress', desired_title = NULL, desired_summary = NULL,
            terminal_failure_status = NULL,
            recovery_state = 'pending', next_attempt_ms = ?, last_error = NULL`,
    [nowMs],
    nowMs,
  );
}

/**
 * The generation-moved end, as ONE fenced transition: drop the debt, unfreeze
 * the intent it wrote, and park the row (`local-error` + `terminal_ms`).
 *
 * The three facts must land together. Dropping first and parking second — two
 * statements — leaves a window (a crash, or a lease that dies between them) in
 * which the row is again a non-terminal, selectable attempt whose frozen
 * conclusion no longer has a debt to justify it, so the ordinary lane could
 * send a conclusion this generation does not own. One UPDATE makes that state
 * unobservable: after it, the row is outside both selection branches (the
 * non-terminal one and the `remote-unconfirmed` reopen one) forever.
 */
export async function parkCheckCorrection(
  db: D1Like,
  id: string,
  lease: Lease,
  reason: string,
  nowMs: CheckClock,
): Promise<boolean> {
  return runFenced(
    db,
    id,
    lease,
    `correction_desired = NULL, correction_generation = NULL,
            desired = 'in_progress', desired_title = NULL, desired_summary = NULL,
            terminal_failure_status = NULL,
            recovery_state = 'local-error', terminal_ms = ?,
            next_attempt_ms = NULL, attempts = attempts + 1, last_error = ?`,
    [nowMs, checkReason(reason)],
    nowMs,
  );
}


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
 *
 * Also the honest end for a row that can NEVER conclude: a §7.9a correction
 * whose target generation moved. `parkCheckCorrection` performs that end as ONE
 * transition (drop, unfreeze and this park together) so no intermediate
 * selectable state exists.
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
 * Bounded pause deferral (P68-QC-006). A paused App's never-sent row has
 * proved (complete adoption walk, no remote run) that it must NOT create, but
 * §7.11.2 step 5 forbids spending an attempt for work that did not run. The
 * row therefore leaves the immediately-due batch through the SAME durable
 * `suspended` state the credential path uses — with the `paused` kind recorded
 * — and is returned by the ordinary re-enable scan.
 *
 * That is exactly the "fenced owned-row suspension/deferral" the finding asks
 * for: one statement under the live lease, no bulk write racing the release,
 * `attempts` untouched, and every identity field retained. `next_attempt_ms`
 * is cleared for the same reason `suspendCheckRecovery` clears it — a suspended
 * row is not "due later", it is out of the batch until its pair is re-enabled.
 *
 * The trade-off is deliberate and is the safer half of the finding: while the
 * App is paused the row costs ONE D1 read per pass (the re-enable scan) and
 * ZERO credential or adoption requests, instead of re-minting a client and
 * re-walking `listForRef` every cron window.
 */
export async function suspendCheckForPause(
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
    `recovery_state = 'suspended', holder = NULL, lease_until_ms = NULL,
            next_attempt_ms = NULL, last_error = ?`,
    [checkReason(checkSuspensionReason("paused", reason))],
    nowMs,
  );
}

/**
 * Durable App-lifecycle suspension for the Check lane (spec §7.6): rows keep
 * their identities while suspended and return to `pending` on re-enable. The
 * pair binds BOTH durable App ids through the registry's own columns — never a
 * repository-wide scan.
 *
 * Fenced to FREE rows only, exactly like the M8 suspension helpers
 * (`suspendPublicationRecovery` / `suspendResolutionRecovery`): a row under a
 * live lease belongs to an invocation that is mid-operation, and clearing its
 * holder/lease would erase ownership this lane never had — it would also make
 * that invocation's next fenced write silently a no-op. Only expired/null
 * leases are suspended; a live one is left for its owner to finish, and the
 * pair is re-examined on a later pass.
 *
 * `suspended` is INCLUDED in the state predicate, matching M8 verbatim. That is
 * what makes a re-stamp work: when an operator corrects the credentials and the
 * pair still fails, the pass must be able to overwrite the recorded digest on
 * the already-suspended row. Without it the stale digest would survive, every
 * later pass would see "credentials changed" again, and the pair would churn
 * exactly as P68-QC-003 describes — the finding the digest exists to close.
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
        WHERE bot_id = ? AND installation_id = ? AND ${NONTERMINAL_WHERE}
          AND recovery_state IN ('pending','remote-unconfirmed','suspended')
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
    )
    .bind(checkReason(reason), nowMs, pair.appId, pair.installationId, nowMs)
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
          WHERE bot_id = ? AND installation_id = ? AND recovery_state = 'suspended'`,
      )
      .bind(nowMs, pair.appId, pair.installationId)
      .run();
  }
}

/**
 * The pairs the re-enable scan may resume (P68-QC-003). This is the Check
 * lane's translation of the M8 no-churn contract, and it is deliberately a
 * READ, not a write: the worker decides, the store only answers.
 *
 * A suspended pair is resumable when EITHER
 *  - its recorded suspension is `disabled` and the App row is now active and
 *    not deleted (status alone is legitimate proof for that kind), OR
 *  - the caller proved a fresh live credential identity for the pair
 *    (`proven`), which is the operator-correction path.
 *
 * Everything else keeps its suspension. That is what stops an unchanged
 * `identity-mismatch` / `decrypt-failed` / `missing` pair from being re-probed
 * and re-suspended on every pass forever: the rows stop occupying the bounded
 * due batch, and no remote probe is issued while the credentials are
 * demonstrably unchanged.
 *
 * `currentFingerprint` is the digest of the encrypted envelope currently stored
 * for the pair, re-read by the caller. The probe reads EVERY suspended row of
 * the pair, because the resume write flips them all: one row of an unreleasable
 * kind keeps the pair suspended. The rule is M8's own comparison
 * (`currentFingerprint !== recorded`), and it is deliberately asymmetric about
 * which side may be absent:
 *
 *  - a READABLE current digest that differs from the recorded one — INCLUDING
 *    the "recorded digest absent" case, where a stored null compares unequal —
 *    means the operator changed something, so the pair earns ONE bounded proof;
 *  - an identical current digest proves the credentials untouched, so the pair
 *    is skipped with no probe (the no-churn rule);
 *  - NO readable current digest proves nothing about the credentials at all, so
 *    the pair stays suspended. That is the fail-closed direction, and it is also
 *    what keeps a pair whose routing row is still missing from being resumed.
 *
 * A `paused` row (kill switch) resumes only once the switch is lifted, and a
 * `disabled` row on App status alone; neither owes a credential proof. Every
 * other kind needs the digest comparison above.
 *
 * Without the first case a suspension recorded with no digest — a `missing`
 * installation mapping, or a row written before this encoding existed — could
 * never be resumed by anything: not by comparison, and not by the operator
 * retry (which refuses suspended rows). Repairing the mapping would leave the
 * rows durably stranded with no
 * operator path, which is the defect F-005 names.
 */
export async function listReenableableCheckPairs(
  db: D1Like,
  candidates: { appId: string; installationId: number; currentFingerprint: string | null }[],
): Promise<{ appId: string; installationId: number }[]> {
  if (candidates.length === 0) return [];
  const resumable: { appId: string; installationId: number }[] = [];
  for (const candidate of candidates) {
    const rows = await db
      // shortcut: tenant-bypass — per-pair Check resume probe selecting status
      // flags only; no tenant-facing field. Upgrade: tenant-filter it once the
      // check store becomes workspace-scoped.
      .prepare(
        `SELECT rc.holder, rc.last_error, ga.status AS app_status, ga.deleted_at AS app_deleted,
                ga.review_enabled AS review_enabled
           FROM review_checks rc
           JOIN review_bots ga ON ga.id = rc.bot_id
          WHERE rc.bot_id = ? AND rc.installation_id = ? AND rc.recovery_state = 'suspended'`,
      )
      .bind(candidate.appId, candidate.installationId)
      .all<{
        holder: string | null;
        last_error: string | null;
        app_status: string;
        app_deleted: string | null;
        review_enabled: number;
      }>();
    const suspended = rows.results;
    if (suspended.length === 0) continue;
    const everyRowReleasable = suspended.every((row) => {
      if (row.app_status !== "active" || row.app_deleted !== null) return false;
      if (row.holder !== null) return false;
      const kind = checkSuspensionKindOf(row.last_error);
      if (kind === "paused") return row.review_enabled !== 0;
      if (kind === "disabled") return true;
      const recorded = suspensionCredentialOf(row.last_error);
      return candidate.currentFingerprint !== null && recorded !== candidate.currentFingerprint;
    });
    if (everyRowReleasable) {
      resumable.push({ appId: candidate.appId, installationId: candidate.installationId });
    }
  }
  return resumable;
}


/**
 * Due Check-reconcile batch (spec §7.11.2): ONE bound `nowMs` at every
 * predicate position, `attempts < maxAttempts`, ORDER BY
 * `COALESCE(next_attempt_ms, created_ms), id`, LIMIT.
 *
 * A row still wanting `in_progress` with NO recorded due time is the live-work
 * shape: neither bookkeeping nor a renewed recovery lease makes it eligible
 * before its EXECUTION deadline. A row RELEASED to recovery carries its own
 * due time (`releaseForRecovery` writes the first backoff rung), so it is due
 * on `next_attempt_ms` — the proof it was released for may already be
 * persisted, and waiting out the deadline would freeze the released state for
 * up to fifteen minutes. The deadline stays in the predicate for the rows
 * nobody released.
 *
 * A lease is authority over a row that still wants `in_progress`; it stops
 * being authority once the intent is frozen. `claimAttempt` writes the lease as
 * the whole 900 s execution window, and every lease-clearing writer is fenced
 * on a LIVE lease — so an invocation that froze `desired` (`setCheckDesired`)
 * and then died leaves a live lease behind that nothing releases. That row's
 * conclusion is already decided, so it no longer waits: a nonzero `holder`
 * whose `updated_ms` is at least `CHECK_STALE_HOLDER_MS` old is taken over.
 * Taking over is safe because the taker bumps `lease_epoch`, which fences the
 * old holder's late writes. A row that still wants `in_progress` never matches
 * this disjunct: it keeps waiting out its deadline, or — when its attempt's
 * paid result is already durable — is due as soon as no live lease holds it
 * (never taken while one does).
 */
export async function listCheckReconcileBatch(
  db: D1Like,
  nowMs: number,
  maxAttempts: number,
  limit: number,
): Promise<CheckAttempt[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM review_checks
        WHERE (
          ${NONTERMINAL_WHERE}
          AND ${CHECK_DUE_PREDICATE}
        )
        -- §7.9a late correction: a Check that already reached its terminal
        -- record as an UNCONFIRMED failure linked to a staged publication owes
        -- one revision when that publication confirms. No other terminal row is
        -- selected, and the mark is retained indefinitely: nothing observable
        -- ever proves a publication will not confirm, so a time bound here
        -- would silently make a late confirmation unable to correct the record
        -- (the same platform limit as I-000670). It costs one indexed proof
        -- read per pass and no writes.
        OR (
          terminal_ms IS NOT NULL
          AND recovery_state = 'remote-unconfirmed'
          AND desired = 'failure' AND observed = 'failure'
          AND publication_id IS NOT NULL
        )
        -- PARTITION the batch so a mark that cannot be corrected costs a read
        -- and never displaces work that can. Class 0 is the transition's OWN
        -- precondition (CORRECTABLE_NOW_SQL), not an approximation of it:
        -- a record with a valid proof, no newer open generation and an usable
        -- pair is actionable NOW and comes first; due rows keep their place;
        -- every other mark (still awaiting proof, corrupt proof, superseded,
        -- unusable pair) fills only the remainder.
        ORDER BY
          CASE
            WHEN terminal_ms IS NOT NULL AND ${CORRECTABLE_NOW_SQL} THEN 0
            WHEN terminal_ms IS NULL THEN 1
            ELSE 2
          END,
          COALESCE(next_attempt_ms,created_ms),id
        LIMIT ?`,
    )
    .bind(maxAttempts, nowMs, nowMs, nowMs - CHECK_STALE_HOLDER_MS, nowMs, nowMs, nowMs, nowMs, limit)
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
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET recovery_state = 'pending', attempts = 0, next_attempt_ms = NULL,
              last_error = NULL, holder = NULL, lease_until_ms = NULL,
              terminal_ms = NULL, updated_ms = ?
        WHERE id = ? AND bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
          AND observed IN ('unknown','in_progress')
          AND recovery_state <> 'suspended'
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM review_checks n
             WHERE n.attempt_key = review_checks.attempt_key
               AND n.${NONTERMINAL_WHERE}
               AND n.generation > review_checks.generation
          )`,
    )
    .bind(
      input.nowMs,
      input.attemptId, input.scope.appId, input.scope.installationId,
      input.scope.owner, input.scope.repo, input.scope.prNumber,
      input.nowMs,
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * Proof reader for the Check lane (spec §7.9: "Read proof by exact App/scope/SHA,
 * preferring this attempt's publication ID"). The journal stays in
 * `src/store/finding-lifecycle.ts`, so exactly one reader exists; this
 * re-export is the Check lifecycle's integration point. `null` means UNPROVEN — never
 * "not published".
 */
export { readPublicationProof } from "./finding-lifecycle";

/**
 * The review a Check is judged by (spec §7.9 gate read): the envelope the
 * attempt itself PUBLISHED.
 *
 * `publicationId` is the proof's publication id, and it ALONE decides: that
 * payload is the envelope this attempt published, and an unreadable payload →
 * `null` (the gate-unreadable failure) — never a fallback to the scope/SHA
 * `reviews` row. `reviews` is a projection of the local apply: first write
 * wins, it can lag a confirmed publication (apply still due, or failed) or
 * belong to an earlier attempt for the same head SHA, which RL-12 allows, and
 * it carries no proof identity, so it must never decide an attempt that
 * published something else. Without a publication id there is no review to
 * judge at all: `null`, never the projected row.
 *
 * A readable payload whose tally is missing keeps its verdict with
 * `scorePct: null` (unreadable gate input, never a fallback to another
 * attempt's score). Missing row → `null`. Read-only: it never mutates or
 * fabricates an outcome.
 */
export async function readPublishedReview(
  db: D1Like,
  input: { scope: Scope; headSha: string; publicationId?: string },
): Promise<PublishedReview | null> {
  if (input.publicationId === undefined) return null;
  return readPublicationReview(db, {
    scope: input.scope,
    headSha: input.headSha,
    publicationId: input.publicationId,
  });
}

/**
 * The review an EMPTY increment inherits (spec §7.9): the persisted v1
 * envelope of the reviewed head this round diffs against, read by the same
 * per-App identity `findIncrementBase` selected that head with — the scope/SHA
 * `reviews` row is the projection of the apply, and that head's own Check was
 * judged from it. `null` when the row, its envelope or its verdict cannot be
 * read; the caller then fails the check closed instead of inventing a result. A
 * readable verdict without a tally keeps `scorePct: null`, exactly like a
 * published payload without a tally. Read-only.
 */
export async function readInheritedReview(
  db: D1Like,
  input: { scope: Scope; headSha: string },
): Promise<PublishedReview | null> {
  const row = await db
    .prepare(
      `SELECT envelope FROM reviews
       WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND head_sha = ?`,
    )
    .bind(
      input.scope.appId,
      input.scope.installationId,
      input.scope.owner,
      input.scope.repo,
      input.scope.prNumber,
      input.headSha,
    )
    .first<{ envelope: string | null }>();
  if (row === null || row.envelope === null) return null;
  const envelope = recordOf(parseJson(row.envelope));
  if (envelope === null || typeof envelope.verdict !== "string") return null;
  return { verdict: envelope.verdict, scorePct: tallyScore(envelope) };
}

async function readPublicationReview(
  db: D1Like,
  input: { scope: Scope; headSha: string; publicationId: string },
): Promise<PublishedReview | null> {
  const row = await db
    .prepare(
      `SELECT payload_json FROM review_publications
       WHERE id = ? AND bot_id = ? AND installation_id = ? AND owner = ? AND repo = ?
         AND pr_number = ? AND head_sha = ?`,
    )
    .bind(
      input.publicationId,
      input.scope.appId,
      input.scope.installationId,
      input.scope.owner,
      input.scope.repo,
      input.scope.prNumber,
      input.headSha,
    )
    .first<{ payload_json: string }>();
  if (row === null) return null;
  const artifact = recordOf(recordOf(parseJson(row.payload_json))?.artifact);
  const envelope = recordOf(artifact?.payload);
  if (envelope === null || typeof envelope.verdict !== "string") return null;
  return { verdict: envelope.verdict, scorePct: tallyScore(envelope) };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tallyScore(envelope: unknown): number | null {
  const tally = recordOf(recordOf(envelope)?.tally);
  if (tally === null) return null;
  const { scorePct } = tally;
  return typeof scorePct === "number" && Number.isInteger(scorePct) && scorePct >= 0 && scorePct <= 100 ? scorePct : null;
}
