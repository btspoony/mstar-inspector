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

import type { Scope } from "../contracts/recheck";
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
 * Flatten and bound frozen terminal text before it is persisted (spec §7.9).
 * A Check title/summary is PUBLIC: collapsing newlines/tabs and dropping
 * control characters keeps an injected multi-line payload from restructuring
 * the rendered Check, and the cut happens on the already-flattened string so
 * no split can re-introduce one. Redaction is the pipeline's choke point
 * (model text is redacted before it reaches this store, SEC-02); the store's
 * job is the deterministic bound — the plan 67 `recoveryReason` precedent.
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
      WHERE p.attempt_key = ? AND p.observed IN ('success','neutral')) = 0
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
          terminal_ms, created_ms, updated_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ${NEXT_GENERATION_SQL},
              ${EXTERNAL_ID_SQL},
              NULL, 'not-sent', ?, 1, ?, ?,
              'in_progress', NULL, NULL, 'unknown',
              'pending', NULL, 0, NULL, NULL, NULL, ?, ?
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
      nowMs, nowMs,
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
 * taken. `execution_deadline_ms` is untouched and the recovery lease runs
 * `CHECK_RECOVERY_LEASE_MS` from `nowMs`, so expiry always still means the
 * execution deadline (spec §7.9/§7.11.2).
 *
 * Repeating the selector is not redundancy: selection alone grants no
 * ownership (§7.11.2 step 1), and a row selected as due can stop being due
 * before this statement runs — a backoff moved forward, the attempt cap
 * reached, or `desired` becoming `in_progress` under a still-live execution
 * deadline. Every one of those is re-checked HERE, at the claim, against the
 * SAME claim-time `nowMs` the selector would use.
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
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
          AND (desired <> 'in_progress' OR execution_deadline_ms <= ?)`,
    )
    .bind(holder, nowMs + CHECK_RECOVERY_LEASE_MS, nowMs, id, maxAttempts, nowMs, nowMs, nowMs)
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
 * The identity-fenced twin of `releaseCheckClaim`, for the one caller that
 * reports a refusal WITHOUT counting a request: T2's `beginCheck` answering
 * `requests: 0`.
 *
 * §7.11.2 step 5 wants such a row left due with no attempt spent — and T2
 * already classified it (it learned `requests === 0` and released its own
 * claim). But `releaseCheckClaim`'s `lease_until_ms > now` condition can fail
 * on exactly this path, because a zero-request refusal is typically the
 * live-time fence itself: the lease legitimately expired while the client was
 * resolved, so a liveness-fenced release writes nothing and T3 would leave the
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
 * / RL-12 together with the T2 `requests: 0` contract).
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
 * for the pair, re-read by the caller. The rule is M8's own comparison
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
 * Without the first case a suspension recorded with no digest — a `missing`
 * installation mapping, or a row written before this encoding existed — could
 * never be resumed by anything: not by proof (`proven` is false on this path),
 * not by comparison, and not by the operator retry (which refuses suspended
 * rows). Repairing the mapping would leave the rows durably stranded with no
 * operator path, which is the defect F-005 names.
 */
export async function listReenableableCheckPairs(
  db: D1Like,
  candidates: { appId: string; installationId: number; currentFingerprint: string | null; proven: boolean }[],
): Promise<{ appId: string; installationId: number }[]> {
  if (candidates.length === 0) return [];
  const resumable: { appId: string; installationId: number }[] = [];
  for (const candidate of candidates) {
    const row = await db
      .prepare(
        `SELECT rc.holder, rc.last_error, ga.status AS app_status, ga.deleted_at AS app_deleted,
                ga.review_enabled AS review_enabled
           FROM review_checks rc
           JOIN github_apps ga ON ga.id = rc.app_id
          WHERE rc.app_id = ? AND rc.installation_id = ? AND rc.recovery_state = 'suspended'
          LIMIT 1`,
      )
      .bind(candidate.appId, candidate.installationId)
      .first<{
        holder: string | null;
        last_error: string | null;
        app_status: string;
        app_deleted: string | null;
        review_enabled: number;
      }>();
    if (row === null) continue;
    // A live holder is never yanked out from under its owner.
    if (row.holder !== null) continue;
    const kind = checkSuspensionKindOf(row.last_error);
    const active = row.app_status === "active" && row.app_deleted === null;
    if (!active) continue;
    // A `paused` hold (P68-QC-006) is released by exactly one event: the kill
    // switch being lifted. Until then the row stays out of the due batch, and —
    // unlike every credential kind — no proof is owed, because nothing about
    // the credentials was ever in question.
    if (kind === "paused") {
      if (row.review_enabled !== 0) {
        resumable.push({ appId: candidate.appId, installationId: candidate.installationId });
      }
      continue;
    }
    // A disabled App resumes on status alone: no credential was in question.
    if (kind === "disabled") {
      resumable.push({ appId: candidate.appId, installationId: candidate.installationId });
      continue;
    }
    // A live credential proof is the ONLY other legitimate resume.
    if (candidate.proven) {
      resumable.push({ appId: candidate.appId, installationId: candidate.installationId });
      continue;
    }
    // No proof: resume when the CURRENT digest is readable and disagrees with
    // the recorded one — M8's comparison, where a stored null compares unequal
    // (F-005). An unreadable current digest proves nothing, so the pair stays
    // suspended rather than being resumed on a guess.
    const recorded = suspensionCredentialOf(row.last_error);
    if (candidate.currentFingerprint !== null && recorded !== candidate.currentFingerprint) {
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
 * re-export is plan 68's integration point. `null` means UNPROVEN — never
 * "not published".
 */
export { readPublicationProof } from "./finding-lifecycle";
