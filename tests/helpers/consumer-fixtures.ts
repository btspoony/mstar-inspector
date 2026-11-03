/**
 * Fixtures shared by the consumer test files (tests/pipeline/consumer.test.ts
 * and consumer-recheck.test.ts): the App-seeded D1 double, the envelope/diff
 * fixtures and the finding-lifecycle seeds the recheck cases hang off.
 *
 * Every suite keeps its OWN sandbox/commenter/log doubles — those carry
 * per-test mutable state — while everything here is pure data or a function of
 * `db`, so one copy is safe to import from every file.
 */
import type { ReviewOutput } from "../../src/review/schema";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { fakePem } from "./fake-secrets";

export const SHA = "0123456789abcdef0123456789abcdef01234567";

export const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "Two issues found in the diff.",
  findings: [
    {
      mergeClass: "should-fix",
      category: "logic",
      file_path: "src/auth.ts",
      line_start: 21,
      line_end: 21,
      title: "Fractional expiry comparison",
      body: "`claims.exp < Date.now() / 1000` compares against a fractional value.",
    },
  ],
};

/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** Fixed App id every consumer-test payload is attributed to. */
export const TEST_APP_ID = "11111111-2222-3333-4444-555555555555";
export const TEST_APP_PEM = fakePem("FAKE-CONSUMER-TEST-PEM");
// Pre-computed secretbox envelopes for the default App row (top-level await:
// this module is ESM and the consumer suites import it after their mocks).
const TEST_APP_PRIVATE_KEY_ENC = await createSecretbox(TEST_KEY).encryptSecret(
  TEST_APP_PEM,
  `github_apps.private_key_enc:${TEST_APP_ID}`,
);
const TEST_APP_WEBHOOK_SECRET_ENC = await createSecretbox(TEST_KEY).encryptSecret(
  "whsec-consumer-test",
  `github_apps.webhook_secret_enc:${TEST_APP_ID}`,
);

/**
 * Fully-migrated D1 with the default App row seeded — the consumer's
 * per-App credential resolution needs a real active row on every message
 * (appRef is required, the env-App branch is retired).
 * AL-24-5: the App is also given its AI-config health
 * baseline — a model chain (`ark-plan/deepseek-v4-flash`, the in-image
 * base provider) + the `ark` BYOK key carried in the provider's credential
 * payload pool the chain's provider reads — so a zero-extra-env
 * message passes the fail-closed gate and every success-path test sees the
 * ark pool + OMP_REVIEW_MODEL from the App config (no Worker-env
 * OMP_MODEL_KEY / OMP_REVIEW_MODEL exists).
 */
export async function createSeededTestD1(): Promise<TestD1> {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 424242, 'consumer-test-app', ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(TEST_APP_ID, TEST_APP_PRIVATE_KEY_ENC, TEST_APP_WEBHOOK_SECRET_ENC);
  // Production shape (migration 0026): createApp writes the App row and its
  // `app_workspaces` mapping in ONE batch, so no App exists unmapped — the
  // consumer's strict read face resolves a real App. A test that needs an
  // orphan deletes this row explicitly.
  db.raw
    .prepare(`INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')`)
    .run(TEST_APP_ID);
  // The default App's per-App AI config (AL-24-5 health baseline). AWAITED
  // so the seed completes before any caller re-seeds the same app_id with a
  // different chain (Rev24T6 Important-2: the fire-and-forget seed raced
  // later awaited re-seeds — last-writer-wins could flake success paths).
  await seedAppConfig(db, TEST_APP_ID);
  return db;
}

/**
 * Seed one App's per-App AI config through the REAL store (composite-PK AAD
 * path): model chain + provider keys. Default = the ark-plan base chain with
 * the `ark` BYOK key; `extraKeys` adds per-App keys for chains that need
 * more providers.
 */
export async function seedAppConfig(
  db: TestD1,
  appId: string,
  modelChain = "ark-plan/deepseek-v4-flash",
  extraKeys: Record<string, string> = {},
): Promise<void> {
  const store = createAppConfigStore(db, TEST_KEY);
  await store.setModelChain(appId, modelChain);
  await store.addProviderKey(appId, "ark", "ark-key");
  for (const [provider, key] of Object.entries(extraKeys)) {
    await store.addProviderKey(appId, provider, key);
  }
}

// line comments: the prefetched diff fixture (now the
// WORKER-CAPTURED sandbox diff — same text, one capture).
/** Default diff fixture: a src/auth.ts hunk whose right range covers line 21. */
export const VALID_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -18,4 +18,6 @@ export function verify() {",
  " const header = req.headers;",
  " const claims = decode(token);",
  "-if (claims.exp < Date.now() / 1000) throw 401;",
  "+if (!Number.isInteger(claims.exp)) throw 401;",
  "+if (claims.exp < Math.floor(Date.now() / 1000)) throw 401;",
  "+audit(claims.sub);",
  " return claims;",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Finding recheck & closure (spec §7.7 order / §7.4 conservative
// reconciliation / §7.10 closure). Seeds only — the assertions live in the
// suites that use them.
// ---------------------------------------------------------------------------

/** The prior round's publication row every lifecycle fixture hangs off. */
export const PRIOR_PUB_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const PRIOR_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const TARGET_ROW_ID = "bbbbbbbb-0000-4000-8000-000000000002";
export const ASSOC_ID = "cccccccc-0000-4000-8000-000000000003";

/** The §7.3 OriginalFinding the seeded lifecycle row carries (different title/hint from the current finding). */
export const TARGET_ORIGINAL = {
  title: "Old null deref on the config path",
  body: "The original published concern body — never reduced to a title.",
  filePath: "src/auth.ts",
  lineStart: 21,
  lineEnd: 21,
  mergeClass: "should-fix",
  category: "logic",
  fingerprintHint: "old-fp-1",
};

export async function seedPriorPublication(db: TestD1, nowMs = 1_000): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, created_ms, updated_ms, recovery_state)
       VALUES (?, ?, 123, 'acme', 'widgets', 42, ?, 'review', 'applied', ?, ?, ?, 'done')`,
    )
    .run(PRIOR_PUB_ID, TEST_APP_ID, PRIOR_SHA, "{}", nowMs, nowMs);
}

export async function seedOpenTarget(db: TestD1, state = "open", nowMs = 2_000): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms)
       VALUES (?, ?, 123, 'acme', 'widgets', 42, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(
      TARGET_ROW_ID,
      TEST_APP_ID,
      TARGET_ORIGINAL.fingerprintHint,
      JSON.stringify(TARGET_ORIGINAL),
      PRIOR_PUB_ID,
      PRIOR_PUB_ID,
      PRIOR_SHA,
      PRIOR_SHA,
      state,
      nowMs,
      nowMs,
    );
}

export async function seedAssociation(db: TestD1, threadId: string | null, nowMs = 3_000): Promise<void> {
  const intent = {
    associationId: ASSOC_ID,
    findingRowId: TARGET_ROW_ID,
    publicationId: PRIOR_PUB_ID,
    scope: { appId: TEST_APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 },
    originalSha: PRIOR_SHA,
    round: 1,
    path: "src/auth.ts",
    line: 21,
    body: "old comment body",
    bodySha256: "digest-old",
  };
  db.raw
    .prepare(
      `INSERT INTO review_threads
         (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
          original_sha, round, intent_json, resolution_state, thread_id, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, 123, 'acme', 'widgets', 42, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(ASSOC_ID, TARGET_ROW_ID, PRIOR_PUB_ID, TEST_APP_ID, PRIOR_SHA, 1, JSON.stringify(intent), threadId, nowMs, nowMs);
}

/** A current-code `addressed` recheck result for the seeded target (cites the trusted catalog slice). */
export const ADDRESSED_QUOTE =
  "if (!Number.isInteger(claims.exp)) throw 401;\nif (claims.exp < Math.floor(Date.now() / 1000)) throw 401;";

export function recheckDocWith(result: Record<string, unknown>, rowId = TARGET_ROW_ID): string {
  return JSON.stringify({
    schema: "mstar.recheck/v1",
    headSha: SHA,
    results: [
      {
        rowId,
        disposition: "addressed",
        reason: "verified-fix",
        evidence: {
          kind: "current-code",
          sliceId: "ev-1",
          startLine: 20,
          endLine: 21,
          quote: ADDRESSED_QUOTE,
          explanation: "The comparison now guards the fractional expiry.",
        },
        relatedCurrentFindingIndexes: [],
        ...result,
      },
    ],
  });
}
