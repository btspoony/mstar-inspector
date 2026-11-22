import { mock } from "bun:test";
import { DEFAULT_CHECK_MIN_SCORE } from "../../src/contracts/review-gate";
import type { ReviewOutput } from "../../src/review/schema";
import type { ConsumerLog, ConsumerLogFields } from "../../src/pipeline/consumer";
import {
  boundedFileReadCommand,
  buildGitOpsCommands,
  CLONE_DIR,
  compareGateCommand,
  DIFF_PATH,
  DIFF_PREFETCH_MAX_BYTES,
  fetchDepthOneCommand,
  incrementDiffCommand,
  issueViewCommand,
  localDiffCommand,
  mergeBaseCommand,
  prBodyCommand,
  pullRequestBaseRefCommand,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
  RUNNER_INPUT_PATH,
  RUNNER_PATH,
  runnerCommand,
  writeJsonCommand,
} from "../../src/pipeline/gitops";
import type { GitOpsCommands } from "../../src/pipeline/gitops";
import { REVIEW_LEVELS } from "../../packages/shared/src/runtime";
import { RECHECK_OUTPUT_PATH, RECHECK_STATUS_PATH } from "../../packages/shared/src/recheck-wire";
import { REPORT_OUTPUT_PATH } from "../../packages/shared/src/report-wire";
import { APPLIED_MODEL_PATH } from "../../packages/shared/src/runtime";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import type { D1Like, D1StatementLike } from "../../src/store/types";
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
const TEST_APP_PRIVATE_KEY_ENC = await createSecretbox(TEST_KEY).encryptSecret(
  TEST_APP_PEM,
  `github_apps.private_key_enc:${TEST_APP_ID}`,
);
const TEST_APP_WEBHOOK_SECRET_ENC = await createSecretbox(TEST_KEY).encryptSecret(
  "whsec-consumer-test",
  `github_apps.webhook_secret_enc:${TEST_APP_ID}`,
);

/**
 * A SECOND App row (`reviews.bot_id`'s FK needs a real one) whose id no test
 * payload carries: the cross-App increment-base cases attribute a review to it
 * and prove the read stays inside the reviewing App.
 */
export const TEST_OTHER_APP_ID = "99999999-8888-7777-6666-555555555555";

/**
 * A SECOND App a payload may be attributed to: its own row, workspace mapping
 * and AI config, so one consumer serves two Apps in a single test.
 */
export const TEST_SECOND_APP_ID = "22222222-3333-4444-5555-666666666666";

export function seedOtherApp(db: TestD1): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 434343, 'consumer-test-other-app', ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(TEST_OTHER_APP_ID, TEST_APP_PRIVATE_KEY_ENC, TEST_APP_WEBHOOK_SECRET_ENC);
}

/**
 * Fully-migrated D1 with the default App row seeded — the consumer's
 * per-App credential resolution needs a real active row on every message
 * (appRef is required, the env-App branch is retired).
 * AL-24-5: the App is also given its AI-config health
 * baseline — a model chain (`ark/deepseek-v4-flash`, the in-image
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
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 424242, 'consumer-test-app', ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(TEST_APP_ID, TEST_APP_PRIVATE_KEY_ENC, TEST_APP_WEBHOOK_SECRET_ENC);
  db.raw
    .prepare(`INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')`)
    .run(TEST_APP_ID);
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          check_min_score, created_by, created_at, updated_at)
       VALUES (?, 'default', ?, 'consumer-test-app', ?, ?, ?, ?, 'tester', datetime('now'), datetime('now'))`,
    )
    .run(
      `target-${TEST_APP_ID}`,
      TEST_APP_ID,
      TEST_REPO_ID,
      TEST_OWNER,
      TEST_REPO,
      DEFAULT_CHECK_MIN_SCORE,
    );
  await seedAppConfig(db, TEST_APP_ID);
  return db;
}

/**
 * The seeded double with ONE statement class rejecting: every `run()` whose SQL
 * contains `fragment` rejects with `message`, while reads and `batch` delegate
 * to the real double. It models a D1 reply lost AFTER the write may have
 * landed, so a caller must report the attempt as unknown instead of settling,
 * retrying or destroying on it.
 */
export function failingDb(db: TestD1, fragment: string, message = "D1 write reply lost"): D1Like {
  const wrap = (sql: string, statement: D1StatementLike): D1StatementLike => ({
    bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
    first: <T = Record<string, unknown>>() => statement.first<T>(),
    all: <T = Record<string, unknown>>() => statement.all<T>(),
    run: <T = Record<string, unknown>>() =>
      sql.includes(fragment) ? Promise.reject(new Error(message)) : statement.run<T>(),
  });
  return {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: (statements: D1StatementLike[]) => db.batch(statements),
  };
}

/**
 * A D1 double where an EARLIER entry already claimed this attempt: the
 * provisioning INSERT lands a `pending` row for the attempt id it is given and
 * answers zero changes, so the caller's prepare takes the replay path against a
 * container it may not provision. Every other statement — the launch claim, the
 * result write, the stores — delegates to the real double.
 */
export function preclaimedDb(db: TestD1): D1Like {
  return {
    prepare: (sql: string) => {
      if (!sql.includes("INSERT INTO review_launches")) return db.prepare(sql);
      let bound: unknown[] = [];
      const claim: D1StatementLike = {
        bind: (...values: unknown[]) => {
          bound = values;
          return claim;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => {
          db.raw
            .prepare(
              "INSERT OR IGNORE INTO review_launches (attempt_id, state, claimed_at_ms, sandbox_id, activated_ms) VALUES (?, 'provisioned', ?, ?, ?)",
            )
            .run(String(bound[0]), Number(bound[1]), String(bound[4]), Number(bound[5]));
          return { results: [], meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return claim;
    },
    batch: (statements: D1StatementLike[]) => db.batch(statements),
  };
}

/**
 * Seed one App's per-App AI config through the REAL store (composite-PK AAD
 * path): model chain + provider keys. Default = the ark base chain with
 * the `ark` BYOK key; `extraKeys` adds per-App keys for chains that need
 * more providers.
 */
export async function seedAppConfig(
  db: TestD1,
  appId: string,
  modelChain = "ark/deepseek-v4-flash",
  extraKeys: Record<string, string> = {},
): Promise<void> {
  const store = createAppConfigStore(db, TEST_KEY);
  await store.setModelChain(appId, modelChain);
  await store.addProviderKey(appId, "ark", "ark-key");
  for (const [provider, key] of Object.entries(extraKeys)) {
    await store.addProviderKey(appId, provider, key);
  }
}

/**
 * Seed the review depth on an App's TARGET. `null` is the "follow the operator
 * default" face; both faces are stored verbatim.
 */
export function setAppReviewLevel(db: TestD1, appId: string, level: string | null): void {
  db.raw.prepare("UPDATE review_targets SET review_level = ? WHERE bot_id = ?").run(level, appId);
}

/**
 * Seed a SECOND reviewing App with its own review depth: row + workspace
 * mapping + AI config, i.e. the shape `createSeededTestD1` gives the default
 * App. The envelopes are sealed under THIS App's id (the decrypt AAD is
 * per-App), so one consumer can serve both within a single test.
 */
export async function seedReviewingApp(
  db: TestD1,
  appId: string,
  githubAppId: number,
  reviewLevel: string | null,
): Promise<void> {
  const box = createSecretbox(TEST_KEY);
  const privateKeyEnc = await box.encryptSecret(TEST_APP_PEM, `github_apps.private_key_enc:${appId}`);
  const webhookSecretEnc = await box.encryptSecret(
    "whsec-consumer-test",
    `github_apps.webhook_secret_enc:${appId}`,
  );
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(
      appId,
      githubAppId,
      `consumer-test-app-${githubAppId}`,
      privateKeyEnc,
      webhookSecretEnc,
    );
  db.raw
    .prepare(`INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')`)
    .run(appId);
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, review_level, check_min_score, created_by, created_at, updated_at)
       VALUES (?, 'default', ?, ?, ?, ?, 'tester', datetime('now'), datetime('now'))`,
    )
    .run(
      `target-${appId}`,
      appId,
      `consumer-test-app-${githubAppId}`,
      reviewLevel,
      DEFAULT_CHECK_MIN_SCORE,
    );
  await seedAppConfig(db, appId);
}

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


/**
 * The fixed review job every consumer suite sends. The double derives its
 * expected commands from THESE through the builders, so a payload change
 * fails loudly (`unrecognized command`) instead of silently answering the
 * wrong command.
 */
export const TEST_INSTALLATION_ID = 123;
export const TEST_OWNER = "acme";
export const TEST_REPO = "widgets";
/** GitHub's numeric id for `acme/widgets` — the target's identity (0067). */
export const TEST_REPO_ID = 4242;
export const TEST_PR_NUMBER = 42;

function gitOpsCommandsFor(payload: {
  owner: string;
  repo: string;
  pr_number: number;
}): Map<string, keyof GitOpsCommands> {
  const commands = buildGitOpsCommands({
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
    cloneDir: CLONE_DIR,
    diffPath: DIFF_PATH,
  });
  return new Map(
    Object.entries(commands).map(([kind, command]) => [command, kind as keyof GitOpsCommands] as const),
  );
}

export function registerGitOpsCommands(
  state: FakeSandboxState,
  payload: { owner: string; repo: string; pr_number: number },
): void {
  for (const [command, kind] of gitOpsCommandsFor(payload)) state.gitOps.set(command, kind);
}

const DEFAULT_GITOPS = gitOpsCommandsFor({
  owner: TEST_OWNER,
  repo: TEST_REPO,
  pr_number: TEST_PR_NUMBER,
});
const RUNNER_CMDS: ReadonlySet<string> = new Set(
  REVIEW_LEVELS.flatMap((level) => [
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH),
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH, RECHECK_OUTPUT_PATH),
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH, undefined, REPORT_OUTPUT_PATH),
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH, RECHECK_OUTPUT_PATH, REPORT_OUTPUT_PATH),
  ]),
);
const DIFF_READ = boundedFileReadCommand(DIFF_PATH, DIFF_PREFETCH_MAX_BYTES);
const RECHECK_DOC_READ = readRecheckCommand(RECHECK_OUTPUT_PATH);
const RECHECK_STATUS_READ = readRecheckStatusCommand(RECHECK_STATUS_PATH);
const REPORT_READ = readReportCommand();
const APPLIED_MODEL_READ = readReportCommand(APPLIED_MODEL_PATH);
const PR_BODY_READ = prBodyCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER);
const SHA_PROBE = "0".repeat(40);
function aroundSha(command: string): { head: string; tail: string } {
  return {
    head: command.slice(0, command.indexOf(SHA_PROBE)),
    tail: command.slice(command.lastIndexOf(SHA_PROBE) + SHA_PROBE.length),
  };
}
const COMPARE = aroundSha(compareGateCommand(TEST_OWNER, TEST_REPO, SHA_PROBE, SHA_PROBE));
const INCREMENT_DIFF = aroundSha(
  incrementDiffCommand(TEST_OWNER, TEST_REPO, SHA_PROBE, SHA_PROBE, DIFF_PATH),
);
const FETCH_DEPTH_ONE = aroundSha(fetchDepthOneCommand(CLONE_DIR, SHA_PROBE));
const LOCAL_DIFF = aroundSha(localDiffCommand(CLONE_DIR, SHA_PROBE, SHA_PROBE, DIFF_PATH));
const WRITE_INPUT_PROBE = writeJsonCommand(RUNNER_INPUT_PATH);

export type FakeSandboxState = {
  calls: Array<{ cmd: string; opts?: unknown }>;
  gitOps: Map<string, keyof GitOpsCommands>;
  resolvedSha: string;
  revParseExitCode: number;
  cloneExitCode: number;
  diffStdout: string;
  diffExitCode: number;
  diffStderr: string;
  diffBaseRef: string;
  mergeBaseSha: string;
  baseRefExitCode: number;
  mergeBaseExitCode: number;
  fetchExitCode: number;
  fetchStderr: string;
  localDiffExitCode: number;
  diffReadStdout: string | null;
  numstatStdout: string;
  numstatExitCode: number;
  numstatStderr: string;
  compareStatus: string;
  compareMerges: number;
  compareExitCode: number;
  incrementDiffStdout: string;
  incrementDiffExitCode: number;
  incrementDiffStderr: string;
  writeInputExitCode: number;
  writtenInputJson: string | undefined;
  prBodyContent: string;
  prBodyExitCode: number;
  prBodyRaw: string | null;
  issueBodies: Map<number, { title: string; body: string }>;
  issueViewExitCode: number;
  recheckFileContent: string;
  recheckFileOverflow: string;
  recheckFileExitCode: number;
  recheckStatusContent: string | null;
  recheckStatusOverflow: string;
  recheckStatusExitCode: number;
  reportFileContent: string;
  reportFileOverflow: string;
  reportFileExitCode: number;
  runnerStdout: string;
  runnerStderr: string;
  runnerExitCode: number;
  error: Error | undefined;
  runnerError: Error | undefined;
  destroyCalls: number;
  destroyError: Error | undefined;
  markerClaim: "written" | "matched" | "unknown";
  markerError: Error | undefined;
  markedUnknown: boolean;
  markedCalls: string[];
  markedError: Error | undefined;
  markedErrorFromCall: number;
  destroyMarkedUnknown: boolean;
  probe: (() => void) | undefined;
  gate: { released: Promise<void>; markReached: () => void } | undefined;
};

export function initialFakeSandboxState(): FakeSandboxState {
  return {
    calls: [],
    gitOps: new Map(DEFAULT_GITOPS),
    resolvedSha: SHA,
    revParseExitCode: 0,
    cloneExitCode: 0,
    diffStdout: VALID_DIFF,
    diffExitCode: 0,
    diffStderr: "gh failed",
    diffBaseRef: "main",
    mergeBaseSha: "c".repeat(40),
    baseRefExitCode: 0,
    mergeBaseExitCode: 0,
    fetchExitCode: 0,
    fetchStderr: "fatal: fetch failed",
    localDiffExitCode: 0,
    diffReadStdout: null,
    numstatStdout: "10\t2\tsrc/auth.ts\n5\t0\tdocs/readme.md\n",
    numstatExitCode: 0,
    numstatStderr: "",
    compareStatus: "identical",
    compareMerges: 0,
    compareExitCode: 0,
    incrementDiffStdout: "",
    incrementDiffExitCode: 0,
    incrementDiffStderr: "",
    writeInputExitCode: 0,
    writtenInputJson: undefined,
    prBodyContent: "",
    prBodyExitCode: 1,
    prBodyRaw: null,
    issueBodies: new Map(),
    issueViewExitCode: 0,
    recheckFileContent: "",
    recheckFileOverflow: "0",
    recheckFileExitCode: 0,
    recheckStatusContent: null,
    recheckStatusOverflow: "0",
    recheckStatusExitCode: 0,
    reportFileContent: "",
    reportFileOverflow: "0",
    reportFileExitCode: 0,
    runnerStdout: "",
    runnerStderr: "",
    runnerExitCode: 0,
    error: undefined,
    runnerError: undefined,
    destroyCalls: 0,
    destroyError: undefined,
    markerClaim: "written",
    markerError: undefined,
    markedUnknown: false,
    markedCalls: [],
    markedError: undefined,
    markedErrorFromCall: 1,
    destroyMarkedUnknown: false,
    probe: undefined,
    gate: undefined,
  };
}

/** Reset the state IN PLACE, so the double keeps reading the same object. */
export function resetFakeSandboxState(state: FakeSandboxState): void {
  Object.assign(state, initialFakeSandboxState());
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function answerCommand(cmd: string, opts: unknown, state: FakeSandboxState): ExecResult {
  if (cmd === "true") return { stdout: "", stderr: "", exitCode: 0 };
  switch (state.gitOps.get(cmd)) {
    case "clone":
      return { stdout: "", stderr: "", exitCode: state.cloneExitCode };
    case "checkedOutSha":
      return { stdout: `${state.resolvedSha}\n`, stderr: "", exitCode: state.revParseExitCode };
    case "diff": {
      if (state.diffExitCode !== 0) {
        return { stdout: "", stderr: state.diffStderr, exitCode: state.diffExitCode };
      }
      if (!cmd.endsWith(DIFF_READ)) {
        throw new Error(`fake sandbox: diff command without its bounded read: ${cmd}`);
      }
      if (state.diffReadStdout !== null) {
        return { stdout: state.diffReadStdout, stderr: "", exitCode: 0 };
      }
      const bytes = Buffer.from(state.diffStdout);
      const head = bytes.subarray(0, DIFF_PREFETCH_MAX_BYTES).toString();
      const overflow = bytes.byteLength > DIFF_PREFETCH_MAX_BYTES ? "1" : "0";
      return { stdout: `${head}\n${overflow}\n`, stderr: "", exitCode: 0 };
    }
    case "numstat":
      return { stdout: state.numstatStdout, stderr: state.numstatStderr, exitCode: state.numstatExitCode };
    default:
      break;
  }
  if (cmd === WRITE_INPUT_PROBE) {
    const stdin = (opts as { stdin?: string } | undefined)?.stdin;
    if (stdin === undefined) {
      throw new Error("fake sandbox: runner-input write arrived without a stdin payload");
    }
    state.writtenInputJson = Buffer.from(stdin, "base64").toString("utf8");
    return { stdout: "", stderr: "", exitCode: state.writeInputExitCode };
  }
  if (cmd === RECHECK_DOC_READ) {
    if (state.recheckFileExitCode !== 0) {
      return { stdout: "", stderr: "read failed", exitCode: state.recheckFileExitCode };
    }
    return { stdout: `${state.recheckFileContent}\n${state.recheckFileOverflow}\n`, stderr: "", exitCode: 0 };
  }
  if (cmd === PR_BODY_READ) {
    if (state.prBodyExitCode !== 0) return { stdout: "", stderr: "gh failed", exitCode: state.prBodyExitCode };
    if (state.prBodyRaw !== null) return { stdout: state.prBodyRaw, stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ body: state.prBodyContent }), stderr: "", exitCode: 0 };
  }
  for (const [issueNumber, issue] of state.issueBodies) {
    if (cmd !== issueViewCommand(TEST_OWNER, TEST_REPO, issueNumber)) continue;
    if (state.issueViewExitCode !== 0) return { stdout: "", stderr: "gh failed", exitCode: state.issueViewExitCode };
    return {
      stdout: JSON.stringify({ number: issueNumber, title: issue.title, body: issue.body }),
      stderr: "",
      exitCode: 0,
    };
  }
  if (cmd === RECHECK_STATUS_READ) {
    if (state.recheckStatusExitCode !== 0) {
      return { stdout: "", stderr: "read failed", exitCode: state.recheckStatusExitCode };
    }
    if (state.recheckStatusContent === null) return { stdout: "", stderr: "no such file", exitCode: 1 };
    return { stdout: `${state.recheckStatusContent}\n${state.recheckStatusOverflow}\n`, stderr: "", exitCode: 0 };
  }
  if (cmd.startsWith(COMPARE.head) && cmd.endsWith(COMPARE.tail)) {
    if (state.compareExitCode !== 0) return { stdout: "", stderr: "gh failed", exitCode: state.compareExitCode };
    return {
      stdout: JSON.stringify({
        status: state.compareStatus,
        merges: state.compareMerges,
        listed: 1,
        total: 1,
      }),
      stderr: "",
      exitCode: 0,
    };
  }
  if (cmd.startsWith(INCREMENT_DIFF.head) && cmd.endsWith(INCREMENT_DIFF.tail)) {
    if (state.incrementDiffExitCode !== 0) {
      return { stdout: "", stderr: state.incrementDiffStderr, exitCode: state.incrementDiffExitCode };
    }
    const bytes = Buffer.from(state.incrementDiffStdout);
    const head = bytes.subarray(0, DIFF_PREFETCH_MAX_BYTES).toString();
    const overflow = bytes.byteLength > DIFF_PREFETCH_MAX_BYTES ? "1" : "0";
    return { stdout: `${head}\n${overflow}\n`, stderr: state.incrementDiffStderr, exitCode: state.incrementDiffExitCode };
  }
  if (cmd === pullRequestBaseRefCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER)) {
    if (state.baseRefExitCode !== 0) {
      return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: state.baseRefExitCode };
    }
    return { stdout: `${state.diffBaseRef}\n`, stderr: "", exitCode: 0 };
  }
  if (cmd === mergeBaseCommand(TEST_OWNER, TEST_REPO, state.diffBaseRef, state.resolvedSha)) {
    if (state.mergeBaseExitCode !== 0) {
      return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: state.mergeBaseExitCode };
    }
    return { stdout: `${state.mergeBaseSha}\n`, stderr: "", exitCode: 0 };
  }
  if (cmd.startsWith(FETCH_DEPTH_ONE.head) && cmd.endsWith(FETCH_DEPTH_ONE.tail)) {
    return { stdout: "", stderr: state.fetchExitCode === 0 ? "" : state.fetchStderr, exitCode: state.fetchExitCode };
  }
  if (cmd.startsWith(LOCAL_DIFF.head) && cmd.endsWith(LOCAL_DIFF.tail)) {
    if (state.localDiffExitCode !== 0) {
      return { stdout: "", stderr: "diff failed", exitCode: state.localDiffExitCode };
    }
    const bytes = Buffer.from(state.diffStdout);
    const head = bytes.subarray(0, DIFF_PREFETCH_MAX_BYTES).toString();
    const overflow = bytes.byteLength > DIFF_PREFETCH_MAX_BYTES ? "1" : "0";
    return { stdout: `${head}\n${overflow}\n`, stderr: "", exitCode: 0 };
  }
  if (cmd === APPLIED_MODEL_READ) {
    return { stdout: "\n2\n", stderr: "", exitCode: 0 };
  }
  if (cmd === REPORT_READ) {
    if (state.reportFileExitCode !== 0) {
      return { stdout: "", stderr: "read failed", exitCode: state.reportFileExitCode };
    }
    return { stdout: `${state.reportFileContent}\n${state.reportFileOverflow}\n`, stderr: "", exitCode: 0 };
  }
  if (RUNNER_CMDS.has(cmd)) {
    return { stdout: state.runnerStdout, stderr: state.runnerStderr, exitCode: state.runnerExitCode };
  }
  throw new Error(`fake sandbox: unrecognized command — declare it in tests/helpers/consumer-fixtures.ts: ${cmd}`);
}

/**
 * The marker RPCs over a sandbox's own `runCommand`/`destroy` — the shape an
 * attempt-owned sandbox must answer. A case that needs a refusal sets the
 * state knobs instead of replacing these.
 */
export function markerGate(sandbox: {
  runCommand: (cmd: string, opts?: unknown) => Promise<ExecResult>;
  destroy: () => Promise<void>;
}) {
  return {
    claimMarker: async () => "written" as const,
    runMarked: async (_marker: string, cmd: string, opts?: unknown) => ({
      kind: "ran" as const,
      ...(await sandbox.runCommand(cmd, opts)),
    }),
    destroyMarked: async () => {
      await sandbox.destroy();
      return "destroyed" as const;
    },
  };
}

/** The injected sandbox double: `state` carries every per-test knob. */
export function createFakeSandbox(state: FakeSandboxState = initialFakeSandboxState()) {
  const sandbox = {
    state,
    runCommand: mock(async (cmd: string, opts?: unknown) => {
      const first = state.calls.length === 0;
      state.calls.push({ cmd, opts });
      if (first && state.probe !== undefined) state.probe();
      if (state.error !== undefined) throw state.error;
      if (state.runnerError !== undefined && RUNNER_CMDS.has(cmd)) throw state.runnerError;
      if (cmd.includes("--input") && state.gate !== undefined) {
        const gate = state.gate;
        state.gate = undefined;
        gate.markReached();
        await gate.released;
      }
      return answerCommand(cmd, opts, state);
    }),
    claimMarker: mock(async (_marker: string) => {
      if (state.markerError !== undefined) throw state.markerError;
      return state.markerClaim;
    }),
    runMarked: mock(async (_marker: string, cmd: string, opts?: unknown) => {
      state.markedCalls.push(cmd);
      if (state.markedError !== undefined && state.markedCalls.length >= state.markedErrorFromCall) {
        throw state.markedError;
      }
      return state.markedUnknown
        ? { kind: "unknown" as const }
        : { kind: "ran" as const, ...(await sandbox.runCommand(cmd, opts)) };
    }),
    destroyMarked: mock(async (_marker: string) => {
      if (state.destroyMarkedUnknown) return "unknown" as const;
      await sandbox.destroy();
      return "destroyed" as const;
    }),
    destroy: mock(async () => {
      state.destroyCalls += 1;
      if (state.destroyError !== undefined) throw state.destroyError;
    }),
  };
  return sandbox;
}


export type TestLogLine = {
  level: "info" | "warn" | "error";
  fields: ConsumerLogFields;
  msg: string;
};

export function createTestLog(): { lines: TestLogLine[]; log: ConsumerLog } {
  const lines: TestLogLine[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg: msg ?? "" }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg: msg ?? "" }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg: msg ?? "" }),
    },
  };
}


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
         (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, created_ms, updated_ms, recovery_state)
       VALUES (?, ?, 123, 'acme', 'widgets', 42, ?, 'review', 'applied', ?, ?, ?, 'done')`,
    )
    .run(PRIOR_PUB_ID, TEST_APP_ID, PRIOR_SHA, "{}", nowMs, nowMs);
}

/**
 * One open lifecycle row for the seeded target, or a variant of it: a case that
 * needs another row (its own id, finding id, original body or rotation clock)
 * passes the override instead of hand-copying the INSERT.
 */
export async function seedOpenTarget(
  db: TestD1,
  {
    state = "open",
    nowMs = 2_000,
    rowId = TARGET_ROW_ID,
    findingId = TARGET_ORIGINAL.fingerprintHint,
    original = {},
  }: {
    state?: string;
    nowMs?: number;
    rowId?: string;
    findingId?: string;
    original?: Partial<typeof TARGET_ORIGINAL>;
  } = {},
): Promise<void> {
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms)
       VALUES (?, ?, 123, 'acme', 'widgets', 42, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(
      rowId,
      TEST_APP_ID,
      findingId,
      JSON.stringify({ ...TARGET_ORIGINAL, ...original }),
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
         (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
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
