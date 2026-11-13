/**
 * Review Check attempt registry (spec review-lifecycle §7.1
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
 * UPDATE — repeating the selector's full eligibility predicate — and never
 * takes a live one. The recovery lease (120s) never moves
 * `execution_deadline_ms`, and expiry always means the execution deadline.
 * `releaseCheckClaim` gives a claim back without spending an attempt (budget
 * deferral, paused not-sent work), leaving the row immediately selector-due.
 *
 * Desired versus observed: `setCheckDesired` freezes the terminal intent
 * (conclusion, bounded title/summary, publication proof link) BEFORE any remote
 * update, and is monotonic except for the one documented correction;
 * `recordCheckObservation` advances `observed` only from a remote payload whose
 * persisted identity already matches. An `unavailable` outcome flows through
 * `deferCheckRecovery`, which touches recovery status/error/backoff only —
 * never `desired`, never `observed`. Suspension is fenced to free rows, so it
 * can never clear a live holder's lease.
 *
 * Storage layer: no `src/pipeline/**` or `src/worker/**` imports, no GitHub
 * call, no clock of its own (one supplied `nowMs` per transaction, §7.0).
 */

import type { Scope } from "../../packages/shared/src/recheck-wire";
import { suspensionCredentialOf, type Lease, type SuspensionKind } from "./finding-lifecycle";
import type { D1Like, ReviewCheckRow } from "./types";

// ---------------------------------------------------------------------------
// Suspension encoding (spec §7.6 — one grammar, shared with the M8 lane)
// ---------------------------------------------------------------------------

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
  /** The proof link the row already carries — the selector's copy of it. */
  publicationId: string | null;
  createState: CheckCreateState;
  desired: CheckDesired;
  observed: CheckObserved;
  recoveryState: CheckRecoveryState;
  executionDeadlineMs: number;
  attempts: number;
  terminalMs: number | null;
  /**
   * When this attempt was ADMITTED. The proof wait uses it to attribute a
   * publication: only a journal row staged at or after this instant can be the
   * publication this attempt set in motion.
   */
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
};

/** A terminal intent: `in_progress` is structurally excluded (spec §7.11.2). */
export type CheckConclusion = {
  desired: Exclude<CheckDesired, "in_progress">;
  title: string;
  summary: string;
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
/**
 * The delivery-side attach window (spec §7.9). The run is created when the
 * delivery is ACCEPTED, but the queue may only hand the message to a consumer
 * minutes later, so the attach row's deadline has to outlive that delay. It is
 * NOT an execution window: the consumer narrows the row to
 * `CHECK_EXECUTION_WINDOW_MS` the moment it adopts it, and a row nobody ever
 * adopts is closed by the reconciler when this window expires.
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
/**
 * Frozen title cap. The spec bounds the summary explicitly; the title is the
 * short line GitHub renders above it, so it is bounded by the same rule — a
 * caller must not be able to smuggle unbounded text into the public surface.
 */
export const CHECK_TITLE_MAX_CHARS = 120;

/** Canonical lowercase UUID syntax — the only Worker-generated ids (spec §7.0). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A nonterminal attempt is one that has not locally completed or given up. */
const NONTERMINAL_WHERE = "terminal_ms IS NULL";

// ---------------------------------------------------------------------------
// Identity helpers (spec §7.9)
// ---------------------------------------------------------------------------

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
    publicationId: row.publication_id,
    createState: row.create_state as CheckCreateState,
    desired: row.desired as CheckDesired,
    observed: row.observed as CheckObserved,
    recoveryState: row.recovery_state as CheckRecoveryState,
    executionDeadlineMs: row.execution_deadline_ms,
    attempts: row.attempts,
    terminalMs: row.terminal_ms,
    createdAtMs: row.created_ms,
  };
}

/** Bound a durable reason (spec §7.9: error ≤300). Never payload content. */
export function checkReason(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return flat.length <= CHECK_ERROR_MAX_CHARS ? flat : flat.slice(0, CHECK_ERROR_MAX_CHARS);
}

/**
 * Flatten and bound frozen terminal text before it is persisted (spec §7.9).
 * A Check title/summary is PUBLIC: collapsing newlines/tabs and dropping
 * control characters keeps an injected multi-line payload from restructuring
 * the rendered Check, and the cut happens on the already-flattened string so
 * no split can re-introduce one. Redaction is the pipeline's choke point
 * (model text is redacted before it reaches this store, SEC-02); the store's
 * job is the deterministic bound — the `recoveryReason` precedent.
 */
function boundText(text: string, max: number): string {
  const flat = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

/** Never persist an empty title: GitHub renders it verbatim above the summary. */
function frozenTitle(title: string): string {
  const bounded = boundText(title, CHECK_TITLE_MAX_CHARS);
  return bounded.length === 0 ? CHECK_NAME : bounded;
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
  nowMs: CheckClock,
  /**
   * Extra state predicate a transition additionally requires, bound with
   * `guardValues` AFTER the lease params. Every legal-transition rule belongs
   * in the statement itself: proving legality by a read-then-write window
   * would let a concurrent transition land in between.
   */
  guard?: string,
  guardValues: unknown[] = [],
): Promise<boolean> {
  // The live-lease fence is MANDATORY (spec §7.9/§7.0): `lease_until_ms` is
  // bound twice — once as the exact triple match, once as the `> now`
  // liveness test — so an expired-but-not-yet-reassigned lease cannot write.
  // There is no unclocked variant: the clock is the caller's single supplied
  // transaction time (§7.0), never a value this module invents.
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
  publicationId: string | null;
};

/** Null when the row is gone, the fence is not the caller's live lease, or the attempt already ended. */
export async function getCheckOwnership(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: CheckClock,
): Promise<CheckOwnership | null> {
  // Clock REQUIRED: an ownership read that skipped `lease_until_ms > now`
  // would authorise a send the spec forbids (§7.9 "remote sends require the
  // same check") — the adapter's send fence reads through here.
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
    /**
     * The DELIVERY that created this row (spec §7.9), recorded so a later skip
     * settlement can tell its own released row from another delivery's. Absent
     * for claims that are not the delivery attach (the consumer's admission
     * claim, recovery) — such a row is only ever closed by the recovery lane.
     */
    attachDeliveryId?: string;
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
  // no generation of this key ended WITH a proven publication. If two claims
  // pass the gates in the same instant, the partial unique index rejects
  // exactly one, and because a failed statement rolls back the batch, the
  // loser owns nothing: it surfaces through the reread below as `busy`, never
  // as its own generation.
  //
  // Dedup reads PROOF, not Check observation (spec §7.9: a terminal
  // successfully published attempt is the `terminal` answer, and the §7.9
  // matrix makes confirmed publication authoritative even when Check side
  // effects fail). A row can hold a positive proof link and still carry
  // `observed = 'unknown'` — e.g. `markCheckLocalError` after a successful
  // publication — so gating on `observed` would mint generation N+1 for a head
  // that is durably published.
  //
  // `neutral` ALONE no longer blocks a claim. A skip SETTLEMENT closes its row
  // `neutral` with no publication link, because nothing was published: retiring
  // the head there would leave a later, ADMITTED delivery of the same head
  // unable to run its own review (a retried guard refusal, a paused-then-resumed
  // App) — a published review with no in-progress run and no final Check. Only a
  // PROVEN outcome blocks: `observed = 'success'` here, plus the EXACT-proof
  // subquery below (a link alone never suppresses a claim — an unproven, foreign
  // or malformed link is not a publication). The new generation gets a fresh row
  // and run id, so the remote surface shows the newest run, which is the honest
  // one. `failure` was always retryable for the same reason.
  //
  // The proof test is EXACT, because suppressing a claim is itself a claim of
  // success: a merely non-null FK would let a foreign-scope publication id, a
  // prepared payload, or malformed JSON silently dedup a head that was never
  // published (spec §7.9 reads proof by exact App/scope/SHA). The gate
  // therefore requires, for the linked publication of some generation of this
  // key:
  //   - the journal row's own scope columns to equal the ATTEMPT's scope and
  //     head SHA (never another App, installation, repo, PR or commit);
  //   - the proof to be a COMPLETE closed §7.7 shape: every required
  //     PublicationProof field present with its JSON type, the embedded
  //     identity agreeing with the row, kind in ('review','degraded'), and
  //     usable values (round >= 1, commentId > 0, a positive Unix-ms
  //     confirmedMs, a 64-hex body digest). Syntactically valid but incomplete
  //     JSON is unproven, not authoritative.
  //     Deliberately NOT gated on `phase`: proof is recorded only on a
  //     confirmed response, and the row legitimately moves on to `applied` (or
  //     is `superseded` by a later round) afterwards. Those heads WERE
  //     published, so keying on a phase the row passes through would wrongly
  //     mint a new generation for them. An unproven row is exactly the one with
  //     `proof_json IS NULL` — the prepared/as-yet-unconfirmed case;
  //   - the EMBEDDED proof identity (scope + headSha + kind) to agree with the
  //     journal row as well, so a payload whose JSON disagrees with its own row
  //     is unproven rather than authoritative.
  // Both a normal and a degraded proof dedup (§7.9's matrix gives confirmed
  // degraded publication `neutral`, still a closed outcome); malformed,
  // prepared, foreign or ambiguous proof does not, and the head stays
  // retryable.
  const provenPublication = `(
    SELECT COUNT(*) FROM review_checks p
      JOIN review_publications pub ON pub.id = p.publication_id
     WHERE p.attempt_key = ?
       AND pub.app_id = p.app_id
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
       AND json_extract(pub.proof_json, '$.scope.appId') = pub.app_id
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
         (id, app_id, github_app_id, installation_id, owner, repo, pr_number,
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
 * with NO due time has not been released to recovery and stays withheld until
 * the deadline.
 *
 * Deliberately spends NO attempt: a budget deferral must not burn a retry
 * (§7.11.2 step 5) — the caller releases the claim instead.
 */
export async function claimCheckRecovery(
  db: D1Like,
  id: string,
  holder: string,
  nowMs: number,
  maxAttempts: number = CHECK_MAX_ATTEMPTS,
): Promise<Lease | null> {
  // Suspension is a CLAIM FENCE, not merely a selector filter (spec §7.6): a
  // disabled/deleted App's rows are recoverable again only after the explicit
  // re-enable that returns them to `pending`. Without this predicate a stale
  // selector result — or a direct caller — could lease a suspended App's row
  // while the App is still disabled.
  const claim = await db
    .prepare(
      `UPDATE review_checks
          SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?, updated_ms = ?
        WHERE id = ? AND ${NONTERMINAL_WHERE}
          AND recovery_state IN ('pending','remote-unconfirmed')
          AND attempts < ?
          AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?
               OR (desired <> 'in_progress' AND holder IS NOT NULL AND updated_ms <= ?))
          AND (desired <> 'in_progress' OR execution_deadline_ms <= ?
               OR (recovery_state IN ('pending','remote-unconfirmed') AND next_attempt_ms <= ?))`,
    )
    .bind(holder, nowMs + CHECK_RECOVERY_LEASE_MS, nowMs, id, maxAttempts, nowMs, nowMs, nowMs - CHECK_STALE_HOLDER_MS, nowMs, nowMs)
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
 * execution window is whatever the caller passes as `executionDeadlineMs`
 * (the consumer's `now + 900,000`).
 */
export async function adoptReleasedCheckAttempt(
  db: D1Like,
  input: {
    attemptId: string;
    /** The App these credentials authenticate as — never a foreign App's row. */
    githubAppId: number;
    holder: string;
    /** The execution deadline the adopting invocation owns (`now + 900,000`). */
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
    /**
     * THIS delivery's attach identity (`payload.attachDeliveryId`): the id its
     * attach holder was written under. Absent → the delivery created no row of
     * its own, so nothing is claimable.
     */
    attachDeliveryId?: string;
    holder: string;
    /** The settling invocation's execution deadline (`now + 900,000`). */
    executionDeadlineMs: number;
    nowMs: number;
  },
): Promise<{ attempt: CheckAttempt; lease: Lease } | null> {
  if (input.holder.length === 0) {
    throw new Error("review-checks: settlement requires a nonblank holder identity");
  }
  // Defensive: a message enqueued before the identity existed carries none, and
  // the predicate below could not match its row anyway (`attach_delivery_id`
  // is NULL). The busy/terminal rule is the PREDICATE's, not this guard's: such
  // a delivery DOES carry an id, it just has no row recording it.
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
  // Shared by both statements: the row must be attached, unfrozen and inside
  // its window, and it must either be held by THIS delivery's own attach or be
  // RELEASED **and created by** it (`attach_delivery_id`). The column is what
  // makes the budget-expiry arm recoverable: the attach may still be running
  // when the message is enqueued, so its row is released only later — the
  // holder alone cannot name the creator by then. Bound order matches the
  // UPDATE.
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
  nowMs: CheckClock,
): Promise<boolean> {
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
    throw new Error(`review-checks: check_run_id must be a positive integer, got ${String(checkRunId)}`);
  }
  // An id may only be attached to a send that was ACTUALLY attempted
  // (`sending`/`unknown`). `not-sent` proving nothing was sent, and an
  // already-`known` id being idempotently re-attached, are the two legal
  // shapes — anything else would record a run this attempt never created.
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
    // Definitive pre-send rejection: only a state that never sent may claim it.
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
  // `sending`/`unknown` record that a create was attempted — always legal, and
  // never reachable backwards, so the row can only move toward resolution.
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
  nowMs: CheckClock,
): Promise<boolean> {
  const current = await getCheckOwnership(db, id, lease, nowMs);
  if (current === null) return false;
  const was = current.desired;
  if (was !== "in_progress" && was !== conclusion.desired) {
    const correction = was === "failure" && (conclusion.desired === "success" || conclusion.desired === "neutral");
    if (!correction || publicationId === null) return false;
  }
  // Freeze BOUNDED text: the persisted row is the only source the send reads,
  // so an oversized or newline-injected title/summary cannot reach the public
  // Check surface later (spec §7.9).
  const title = frozenTitle(conclusion.title);
  const summary = boundText(conclusion.summary, CHECK_SUMMARY_MAX_CHARS);
  return runFenced(
    db,
    id,
    lease,
    `desired = ?, desired_title = ?, desired_summary = ?,
            publication_id = COALESCE(?, publication_id),
            recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
    [conclusion.desired, title, summary, publicationId],
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
    `desired = ?, desired_title = ?, desired_summary = ?,
            recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL`,
    [conclusion.desired, title, summary],
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
 * Returns the attached run id — the caller then sends exactly one
 * `checks.update` — or null when there was nothing to label.
 */
export async function markCheckQueuedBehindInflight(
  db: D1Like,
  input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    /** THIS delivery's attach identity — absent means it created no row. */
    attachDeliveryId?: string;
    title: string;
    summary: string;
    nowMs: number;
  },
): Promise<number | null> {
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
  // The relabelable row: still running, attached, wanting in_progress and not
  // suspended. Identical in both statements — the SELECT only learns the run id.
  //
  // The HOLDER arm is what keeps this honest: `attach_delivery_id` names the
  // delivery that CREATED the row, not the one now using it. A second delivery
  // for the same head can ADOPT this row (`adoptReleasedCheckAttempt` does not
  // clear the creator column) and start the review — then the creator's next
  // `pr-held` retry would relabel a run it does not own as "Queued". Only a
  // RELEASED row, or one still under this delivery's OWN attach holder, may be
  // relabelled; a `consumer:*` holder and `delivery:<other>` are refused by the
  // same predicate, exactly as `claimAttachedCheckForSettlement` refuses them.
  const relabelable = `terminal_ms IS NULL
          AND create_state = 'known' AND check_run_id IS NOT NULL
          AND desired = 'in_progress'
          AND recovery_state IN ('pending','remote-unconfirmed')
          AND (holder IS NULL OR holder = 'delivery:' || ?)`;
  const candidate = await db
    .prepare(
      `SELECT check_run_id FROM review_checks
         WHERE attempt_key = ? AND attach_delivery_id = ? AND ${relabelable}
         ORDER BY generation DESC LIMIT 1`,
    )
    .bind(key, input.attachDeliveryId, input.attachDeliveryId)
    .first<{ check_run_id: number }>();
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
  return relabeled.meta.changes === 1 ? candidate.check_run_id : null;
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
  // `completed` is decided HERE, from the row, not from "the hook's promise
  // resolved": a hook that froze nothing (fence refused) or handed the attempt
  // to recovery resolves just as normally, and only `observed = desired` proves
  // a terminal send landed. Those rows record `handed-off`.
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
  nowMs: CheckClock,
): Promise<boolean> {
  const owned = await getCheckOwnership(db, id, lease, nowMs);
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
// Recovery bookkeeping (spec §7.9 / §7.11.2 — consumed by the reconciler)
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
        WHERE app_id = ? AND installation_id = ? AND ${NONTERMINAL_WHERE}
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
          WHERE app_id = ? AND installation_id = ? AND recovery_state = 'suspended'`,
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
           JOIN github_apps ga ON ga.id = rc.app_id
          WHERE rc.app_id = ? AND rc.installation_id = ? AND rc.recovery_state = 'suspended'`,
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
    // The resume write flips EVERY suspended row of the pair, so the decision
    // must hold for every one of them too: one row of an unreleasable kind (a
    // credential suspension whose envelope is unchanged, or a row still held)
    // keeps the whole pair suspended. A mixed-kind pair is reachable — a
    // kill-switch hold is written per row, a credential suspension covers the
    // pair — so an unordered single-row probe cannot speak for the rest.
    const everyRowReleasable = suspended.every((row) => {
      if (row.app_status !== "active" || row.app_deleted !== null) return false;
      // A live holder is never yanked out from under its owner.
      if (row.holder !== null) return false;
      const kind = checkSuspensionKindOf(row.last_error);
      // A `paused` hold (P68-QC-006) is released by exactly one event: the
      // kill switch being lifted. No credential proof is owed.
      if (kind === "paused") return row.review_enabled !== 0;
      // A disabled App resumes on status alone: no credential was in question.
      if (kind === "disabled") return true;
      // Credential kinds: resume only when the CURRENT digest is readable and
      // disagrees with the recorded one — M8's comparison, where a stored null
      // compares unequal (F-005). An unreadable digest proves nothing.
      const recorded = suspensionCredentialOf(row.last_error);
      return candidate.currentFingerprint !== null && recorded !== candidate.currentFingerprint;
    });
    if (everyRowReleasable) {
      resumable.push({ appId: candidate.appId, installationId: candidate.installationId });
    }
  }
  return resumable;
}

// ---------------------------------------------------------------------------
// Reconcile selection (spec §7.11.2 predicate, verbatim)
// ---------------------------------------------------------------------------

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
 * this disjunct and keeps waiting out its deadline.
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
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?
               OR (desired <> 'in_progress' AND holder IS NOT NULL AND updated_ms <= ?))
          AND (desired <> 'in_progress' OR execution_deadline_ms <= ?
               OR (recovery_state IN ('pending','remote-unconfirmed') AND next_attempt_ms <= ?))
        ORDER BY COALESCE(next_attempt_ms,created_ms),id
        LIMIT ?`,
    )
    .bind(maxAttempts, nowMs, nowMs, nowMs - CHECK_STALE_HOLDER_MS, nowMs, nowMs, limit)
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
  // ONE conditional statement, not read-then-write (spec §7.9/§7.11.2 step 6).
  // Every precondition is repeated inside the UPDATE so a concurrent
  // terminalization, a live lease, a newer active generation or a newer
  // observation landing between a preliminary read and the write can never be
  // overwritten. The old shape re-read the row first and then updated
  // `WHERE id = ?`, which could clear `terminal_ms` on a row another worker
  // had just finished — erasing terminal history the spec requires be retained.
  //
  // Reopening clears the local give-up mark, because the selector only ever
  // considers `terminal_ms IS NULL` rows: a `local-error` row that kept its
  // mark could never be reconciled and the operator retry would be a silent
  // no-op. Nothing else moves — generation, external id, check run id, desired,
  // observed and the proof link are all retained, and `observed` is NOT
  // rewritten, so this never pretends the remote run completed.
  //
  // A TERMINAL observation (`success`/`neutral`/`failure`) is refused: that
  // row already carries its finished evidence and reopening it would relaunder
  // a settled result. A NON-terminal observation — `unknown` or `in_progress`
  // — is retryable, which is exactly the "external run still pending" state
  // §7.11.2 step 6 names: the spec fences retry on identity, liveness and
  // generation, and never on the observation being unrecorded. The recorded
  // observation is preserved either way, so a retried `in_progress` row still
  // shows the running Check it actually saw.
  //
  // Suspension is excluded: an operator retry must not be able to resume work
  // for a disabled/deleted App (spec §7.6). Only the explicit App re-enable —
  // which proves the App is live again — may return that identity to
  // `pending`. A suspended row therefore stays put, exactly like the recovery
  // claim fence in `claimCheckRecovery`.
  //
  // The "no newer active generation" precondition is a correlated EXISTS over
  // the same key: the row being reopened must still be the newest unfinished
  // identity for its key, so an old superseded row stays put for inspection.
  const result = await db
    .prepare(
      `UPDATE review_checks
          SET recovery_state = 'pending', attempts = 0, next_attempt_ms = NULL,
              last_error = NULL, holder = NULL, lease_until_ms = NULL,
              terminal_ms = NULL, updated_ms = ?
        WHERE id = ? AND app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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

/**
 * The envelope THIS publication carried, by exact App/scope/SHA identity (a
 * row of another attempt or another App must never decide this one). `null`
 * means the payload is unreadable, not "no review was published".
 */
async function readPublicationReview(
  db: D1Like,
  input: { scope: Scope; headSha: string; publicationId: string },
): Promise<PublishedReview | null> {
  const row = await db
    .prepare(
      `SELECT payload_json FROM review_publications
       WHERE id = ? AND app_id = ? AND installation_id = ? AND owner = ? AND repo = ?
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

/** `envelope.tally.scorePct` when it is an integer inside the schema's 0..100 domain. */
function tallyScore(envelope: unknown): number | null {
  const tally = recordOf(recordOf(envelope)?.tally);
  if (tally === null) return null;
  const { scorePct } = tally;
  return typeof scorePct === "number" && Number.isInteger(scorePct) && scorePct >= 0 && scorePct <= 100 ? scorePct : null;
}
