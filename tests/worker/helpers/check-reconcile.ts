/**
 * Shared fixtures for the Check recovery suites (`check-reconcile.test.ts` and
 * `check-reconcile-journal.test.ts`): the migrated D1 double with its seeded
 * Apps, the claim/publication/review builders, the scripted adapter double with
 * its real dispatch meter, and the run helper.
 *
 * Extracted verbatim from the reconciler suite so a second suite can drive the
 * same production surface without a copy — the fixtures are the contract, and
 * two copies would be free to drift.
 */
import { DEFAULT_CHECK_MIN_SCORE } from "../../../src/contracts/review-gate";
import type { Scope } from "../../../packages/shared/src/recheck-wire";
import {
  CHECK_NAME,
  claimAttempt,
  rollbackCheckCreateDispatch,
  setCheckCreateState,
  type CheckAttempt,
  type CheckConclusion,
  type CheckIdentity,
  type CheckRemote,
  type Lease,
  type PublicationProof,
} from "../../../src/store/review-checks";
import {
  reconcileReviewChecks,
  type CheckCredentialFactory,
  type CheckReconcileDeps,
  type CheckTransport,
} from "../../../src/worker/check-reconcile";
import type { ChecksAdapter } from "../../../src/pipeline/checks";
import type { ScheduledEnv } from "../../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../../store/helpers";

export const APP = "11111111-2222-3333-4444-555555555555";
export const APP_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const NUMERIC_APP = 1001;
export const NUMERIC_APP_B = 1002;
export const SCOPE: Scope = { appId: APP, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
export const SCOPE_B: Scope = { appId: APP_B, installationId: 456, owner: "other", repo: "gadgets", prNumber: 7 };
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const T0 = 1_700_000_000_000;
/** The consumer's claim happened an hour before T0; its lease died 30 min before. */
export const CLAIM_AT = T0 - 3_600_000;
export const EXPIRED_DEADLINE = T0 - 1_800_000;

export const SILENT_LOG = { warn: () => {}, info: () => {} };

/** The cron's queue binding (comment-claim outbox): these suites re-send nothing. */
export const NOOP_QUEUE = { send: async () => {} } as unknown as ScheduledEnv["REVIEW_QUEUE"];

/** `CHECK_SUMMARIES.unconfirmed` — the give-up fallback the consumer freezes. */
export const UNCONFIRMED = "Review attempt could not be confirmed complete; publication status is unknown.";

export function asEnv(db: TestD1): ScheduledEnv {
  return { DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE };
}

export function seedApp(
  db: TestD1,
  id: string,
  githubAppId: number,
  options: { install?: boolean; installationId?: number; status?: string } = {},
): void {
  const { install = true, installationId = 123, status = "active" } = options;
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          check_min_score, created_by, status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc-pem', 'enc-secret', ?, 'tester', ?, NULL, 1, datetime('now'), datetime('now'))`,
    )
    .run(id, `checks-${id}`, githubAppId, `checks-${id}`, DEFAULT_CHECK_MIN_SCORE, status);
  if (install) {
    db.raw
      .prepare(
        `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES (?, ?, ?, 'acme', datetime('now'))`,
      )
      .run(`inst-${id}-${installationId}`, id, installationId);
  }
}

export function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  seedApp(db, APP, NUMERIC_APP);
  seedApp(db, APP_B, NUMERIC_APP_B, { installationId: SCOPE_B.installationId });
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export async function claim(
  db: TestD1,
  overrides: Partial<Parameters<typeof claimAttempt>[1]> = {},
): Promise<{ attempt: CheckAttempt; lease: Lease }> {
  const result = await claimAttempt(db, {
    scope: SCOPE,
    githubAppId: NUMERIC_APP,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    holder: "consumer-run",
    nowMs: CLAIM_AT,
    executionDeadlineMs: EXPIRED_DEADLINE,
    ...overrides,
  });
  if (result.kind !== "claimed") {
    throw new Error(`expected a claimed attempt, got ${result.kind}`);
  }
  return { attempt: result.attempt, lease: result.lease };
}

export function remoteFor(identity: CheckIdentity, overrides: Partial<CheckRemote> = {}): CheckRemote {
  return {
    id: overrides.id ?? 4242,
    name: overrides.name ?? CHECK_NAME,
    head_sha: overrides.head_sha ?? identity.headSha,
    external_id: overrides.external_id === undefined ? identity.externalId : overrides.external_id,
    app: overrides.app === undefined ? { id: identity.githubAppId } : overrides.app,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined ? "success" : overrides.conclusion,
  };
}

/** A self-consistent persisted publication proof for the attempt's scope/SHA. */
export function proofFor(identity: CheckIdentity, kind: "review" | "degraded" = "review"): PublicationProof {
  return {
    publicationId: `pub-${identity.attemptId}`,
    scope: identity.scope,
    headSha: identity.headSha,
    kind,
    round: 3,
    commentId: 77,
    bodySha256: "a".repeat(64),
    confirmedMs: T0 - 10_000,
  };
}

/**
 * A journal row carrying persisted proof. It is staged BEFORE `T0` by default
 * (an earlier generation's publication); pass `stagedAtMs` for a row staged
 * after an attempt was admitted — the abandoned-attempt-then-published shape.
 */
export function seedPublication(
  db: TestD1,
  scope: Scope,
  headSha: string,
  proof: PublicationProof,
  phase = "confirmed",
  payload: unknown = {},
  stagedAtMs: number = T0 - 20_000,
): void {
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms, confirmed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'done', ?, ?, ?)`,
    )
    .run(
      proof.publicationId,
      scope.appId,
      scope.installationId,
      scope.owner,
      scope.repo,
      scope.prNumber,
      headSha,
      proof.kind,
      phase,
      JSON.stringify(payload),
      JSON.stringify(proof),
      stagedAtMs,
      stagedAtMs + 10_000,
      stagedAtMs + 10_000,
    );
}

/**
 * Attach a publication to the attempt — the link the attempt's OWN intent write
 * records in `review_checks.publication_id`. Only a linked publication's proof
 * can decide that attempt's Check (spec §7.9): another generation's publication
 * for the same head proves nothing about this attempt.
 */
export function linkPublication(db: TestD1, attemptId: string, publicationId: string): void {
  db.raw.prepare(`UPDATE review_checks SET publication_id = ? WHERE id = ?`).run(publicationId, attemptId);
}

/**
 * An in-flight (or given-phase) publication-journal row for the exact
 * scope/head with NO persisted proof — the journal hand-off state. It is
 * staged by default AFTER an attempt claimed at `T0`, as production does (the
 * message that publishes stages the row itself); pass `stagedAtMs` to place it
 * elsewhere, e.g. before an attempt's admission for a previous generation.
 */
export function seedJournal(
  db: TestD1,
  scope: Scope,
  headSha: string,
  phase: string,
  stagedAtMs: number = T0 + 1_000,
): string {
  const id = `journal-${phase}`;
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'review', ?, '{}', NULL, 0, 'pending', ?, ?)`,
    )
    .run(
      id,
      scope.appId,
      scope.installationId,
      scope.owner,
      scope.repo,
      scope.prNumber,
      headSha,
      phase,
      stagedAtMs,
      stagedAtMs,
    );
  return id;
}

/** An `mstar.review/v1` envelope with the given verdict and tally score. */
export function reviewEnvelope(verdict: string, scorePct: number | null): Record<string, unknown> {
  return {
    schema: "mstar.review/v1",
    verdict,
    findings: [],
    ...(scorePct === null
      ? {}
      : { tally: { verdict, scorePct, tally: { mustFix: 0, shouldFix: 0, nit: 0, unverified: 0 }, chatHeader: "h" } }),
  };
}

/**
 * A staged `kind: "review"` publication payload carrying its own envelope —
 * the second attempt's journal row, distinct from any `reviews` row.
 */
export function reviewPayload(scope: Scope, headSha: string, verdict: string, scorePct: number): unknown {
  return {
    version: 1,
    scope,
    headSha,
    kind: "review",
    round: 3,
    targetCommentId: null,
    body: `## Review\n\n${verdict}`,
    bodySha256: "a".repeat(64),
    artifact: {
      kind: "review",
      key: {
        installation_id: scope.installationId,
        owner: scope.owner,
        repo: scope.repo,
        pr_number: scope.prNumber,
        head_sha: headSha,
      },
      schema: "mstar.review/v1",
      payload: reviewEnvelope(verdict, scorePct),
      appId: scope.appId,
      model: null,
      provider: null,
    },
    lifecycle: null,
    lineIntents: [],
  };
}

/** The applied review the gate reads (verdict + envelope tally); `scorePct` null = no tally. */
export function seedReview(db: TestD1, scope: Scope, headSha: string, verdict: string, scorePct: number | null): void {
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, envelope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      scope.installationId,
      scope.owner,
      scope.repo,
      scope.prNumber,
      headSha,
      verdict,
      JSON.stringify(reviewEnvelope(verdict, scorePct)),
    );
}

export async function rawRow(db: TestD1, id: string): Promise<Record<string, string | number | null>> {
  return (await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(id).first()) as Record<
    string,
    string | number | null
  >;
}

// ---------------------------------------------------------------------------
// Scripted adapter double + real dispatch meter
// ---------------------------------------------------------------------------

export type AdoptOutcome = { kind: "found"; remote: CheckRemote } | { kind: "absent" | "incomplete" | "ambiguous" };
export type BeginOutcome =
  | { kind: "ready"; remote: CheckRemote }
  | { kind: "unavailable"; reason: string; requests?: number };
export type FetchOutcome = { kind: "found"; remote: CheckRemote } | { kind: "absent" } | { kind: "unavailable"; reason: string };
export type CompleteOutcome =
  | { kind: "completed"; remote: CheckRemote }
  | { kind: "unavailable"; reason: string; requests?: number };

export type AdapterScript = {
  /**
   * REAL requests each adapter call issues through the run transport before
   * answering. 1 mirrors a single-request operation; a higher value simulates
   * the multi-request shapes the live adapter can produce (a paginated
   * adoption walk, a token mint plus a call), which is what the per-row
   * bound has to absorb.
   */
  requestsPerCall?: number;
  adopt?: (identity: CheckIdentity) => Promise<AdoptOutcome>;
  begin?: (identity: CheckIdentity) => Promise<BeginOutcome>;
  fetch?: (identity: CheckIdentity, checkRunId: number) => Promise<FetchOutcome>;
  complete?: (identity: CheckIdentity, checkRunId: number, conclusion: CheckConclusion) => Promise<CompleteOutcome>;
};

/** Counts real dispatches — the transport is the only path to `fetch`. */
export function stubFetch(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * The injected credential factory: one purpose-scoped "adapter" per App pair
 * whose operations issue real requests through the run's own transport, so
 * every assertion about budgets counts genuine dispatches rather than
 * simulated ones. `scopeFor` is the one pair the script serves; every other
 * pair resolves `unavailable`, exactly like a routing miss.
 *
 * `beginCheck` deliberately writes the durable `sending` transition through
 * the REAL store, because that is what the live adapter does before it lets a
 * create request leave — a double that skipped it would make the row's
 * `not-sent` state contradict the run it just created.
 */
export function scriptedCredentials(
  db: TestD1,
  script: AdapterScript = {},
  capture?: { transport?: CheckTransport },
  scopeFor: Scope = SCOPE,
  paused = false,
): CheckCredentialFactory {
  return async ({ scope, transport }) => {
    if (capture !== undefined) capture.transport = transport;
    if (scope.appId !== scopeFor.appId || scope.installationId !== scopeFor.installationId) {
      return { kind: "unavailable", reason: "missing" };
    }
    return { kind: "ok", paused, adapter: scriptedAdapter(db, script, transport) };
  };
}

/**
 * The adapter double itself, for tests that need to serve an ARBITRARY scope
 * (a run-budget case spread over many pairs) rather than one pinned pair. Each
 * operation issues its scripted real requests through the run's transport, so
 * every budget assertion counts genuine dispatches.
 *
 * `beginCheck` deliberately writes the durable `sending` transition through
 * the REAL store, because that is what the live adapter does before it lets a
 * create request leave — a double that skipped it would make the row's
 * `not-sent` state contradict the run it just created.
 */
export function scriptedAdapter(db: TestD1, script: AdapterScript, transport: CheckTransport): ChecksAdapter {
  const perCall = script.requestsPerCall ?? 1;
  /** True when every scripted request for this call actually dispatched. */
  const spend = async (): Promise<boolean> => {
    for (let i = 0; i < perCall; i += 1) {
      try {
        await transport.fetchImpl("https://api.github.com/checks");
      } catch {
        // Refused BEFORE dispatch. The live adapter surfaces this as
        // `unavailable` and never would have reached GitHub, so the script must
        // not run either: a double that answered anyway would fake a request
        // the budget already refused.
        return false;
      }
    }
    return true;
  };
  return {
    adoptCheckRun: async ({ identity }) => {
      if (!(await spend())) return { kind: "incomplete" };
      return script.adopt === undefined ? { kind: "absent" } : script.adopt(identity);
    },
    beginCheck: async ({ identity, lease }) => {
      // Mirror the live adapter: `sending` is persisted BEFORE the request.
      // One millisecond inside the recovery lease is a valid fence instant for
      // every clock these tests use.
      const markedAt = lease.untilMs - 1;
      await setCheckCreateState(db, identity.attemptId, lease, "sending", undefined, markedAt);
      if (!(await spend())) {
        // The transport refused BEFORE dispatch — the live adapter's
        // `refused(...)` shape, which reports zero invoked Checks calls. (The
        // caller short-circuits on `budget.refused` before reading a count.)
        return { kind: "unavailable", reason: "request budget refused before dispatch", requests: 0 };
      }
      if (script.begin === undefined) return { kind: "unavailable", reason: "no create scripted", requests: 1 };
      const begun = await script.begin(identity);
      if (begun.kind !== "unavailable") return begun;
      // Mirror the live adapter's additive contract: a script that does not say
      // otherwise describes a dispatched call, so it reports a positive count.
      const requests = begun.requests ?? 1;
      if (requests === 0) {
        // A provably undispatched create: the adapter undoes its own mark.
        await rollbackCheckCreateDispatch(db, identity.attemptId, lease, markedAt);
      }
      // `requests` LAST so the declared `number` wins over the script type's
      // optional field — identical value at runtime.
      return { ...begun, requests };
    },
    fetchCheckRun: async ({ identity, checkRunId }) => {
      if (!(await spend())) return { kind: "unavailable", reason: "request budget refused before dispatch" };
      return script.fetch === undefined
        ? { kind: "unavailable", reason: "no fetch scripted" }
        : script.fetch(identity, checkRunId);
    },
    completeCheck: async ({ identity, checkRunId, conclusion }) => {
      if (!(await spend())) {
        return { kind: "unavailable", reason: "request budget refused before dispatch", requests: 0 };
      }
      if (script.complete === undefined) return { kind: "unavailable", reason: "no complete scripted", requests: 1 };
      const completed = await script.complete(identity, checkRunId, conclusion);
      if (completed.kind !== "unavailable") return completed;
      // Same additive contract as `beginCheck`: a script that does not say
      // otherwise describes a dispatched update, so it reports a positive count.
      return { ...completed, requests: completed.requests ?? 1 };
    },
  };
}

/**
 * The ordinary healthy flow: nothing is observable yet, the create lands, and
 * the run then reads back terminal and in agreement with the frozen intent.
 */
export function agreeingScript(
  conclusion: CheckConclusion["desired"] = "failure",
  checkRunId = 4242,
): AdapterScript {
  return {
    adopt: async () => ({ kind: "absent" }),
    begin: async (identity) => ({
      kind: "ready",
      remote: remoteFor(identity, { id: checkRunId, status: "in_progress", conclusion: null }),
    }),
    fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { id: checkRunId, status: "completed", conclusion }) }),
  };
}

export function run(db: TestD1, deps: CheckReconcileDeps = {}) {
  // The caller's log wins when supplied (tests that assert on warn events);
  // silence is only the default.
  return reconcileReviewChecks(asEnv(db), { log: SILENT_LOG, ...deps });
}

/**
 * The same database with the SELECTs matching `matcher` throwing, i.e. a
 * persistent read failure on exactly those statements (everything else —
 * including the durable writes and `raw` assertions — still works).
 */
export function withFailingReads(db: TestD1, matcher: RegExp): TestD1 {
  return {
    prepare(sql: string) {
      if (matcher.test(sql)) throw new Error("d1 read failed");
      return db.prepare(sql);
    },
    batch: (statements: Parameters<TestD1["batch"]>[0]) => db.batch(statements),
    raw: db.raw,
  } as TestD1;
}
