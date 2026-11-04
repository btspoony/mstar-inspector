/**
 * Fixtures shared by every consumer suite: the App-seeded D1 double, the
 * sandbox exec and log doubles, the envelope/diff fixtures and the
 * finding-lifecycle seeds the recheck cases hang off.
 *
 * Consumers, post-split: `tests/pipeline/consumer.test.ts` (the round itself)
 * and the three per-concern recheck files — `consumer-recheck-catalog`,
 * `consumer-recheck-precedence`, `consumer-recheck-status`. The runtime
 * harness (injected doubles, message/payload builders, `reset()`) lives in
 * `./consumer-harness`, which imports from here; a suite that needs a double
 * imports it from there.
 *
 * Each double reads its behavior from a caller-owned mutable STATE object, so
 * one copy serves every suite and tests still switch it per case.
 */
import { mock } from "bun:test";
import type { ReviewOutput } from "../../src/review/schema";
import type { ConsumerLog, ConsumerLogFields } from "../../src/pipeline/consumer";
import {
  boundedFileReadCommand,
  buildGitOpsCommands,
  CLONE_DIR,
  DIFF_PATH,
  DIFF_PREFETCH_MAX_BYTES,
  issueViewCommand,
  prBodyCommand,
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
// Sandbox exec double (spec §7.7 steps 1–8). It answers ONLY the commands
// consumer.ts issues: anything else throws, so a new/renamed product command
// fails the suite instead of reading as an empty success. Every expected
// string is BUILT by the production builders from the same path constants the
// consumer passes, so a command-shape change edits the product, not this
// double — re-typing the strings here would turn the lockstep edit into a
// contract assertion that never fails.
// ---------------------------------------------------------------------------

/**
 * The fixed review job every consumer suite sends. The double derives its
 * expected commands from THESE through the builders, so a payload change
 * fails loudly (`unrecognized command`) instead of silently answering the
 * wrong command.
 */
export const TEST_INSTALLATION_ID = 123;
export const TEST_OWNER = "acme";
export const TEST_REPO = "widgets";
export const TEST_PR_NUMBER = 42;
/** Review tier the harness env leaves unset (resolveReviewLevel's landing tier). */
const TEST_REVIEW_LEVEL = "default";

/**
 * The payload-derived commands the consumer WILL issue for this job, built by
 * the production builders and keyed by the command string the double sees.
 * Tests that assemble a batch inline (without `makeBatch`) still run the
 * canonical payload, so its commands are declared by default below; `makeBatch`
 * adds the commands for its own payload.
 */
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
    runnerPath: RUNNER_PATH,
    level: TEST_REVIEW_LEVEL,
    inputPath: RUNNER_INPUT_PATH,
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

/** The canonical test job's commands, declared for every sandbox state. */
const DEFAULT_GITOPS = gitOpsCommandsFor({
  owner: TEST_OWNER,
  repo: TEST_REPO,
  pr_number: TEST_PR_NUMBER,
});
/**
 * The runner exec for EVERY legal tier, with and without the optional
 * `--recheck-out`: the consumer forwards REVIEW_LEVEL verbatim.
 */
const RUNNER_CMDS: ReadonlySet<string> = new Set(
  REVIEW_LEVELS.flatMap((level) => [
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH),
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH, RECHECK_OUTPUT_PATH),
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH, undefined, REPORT_OUTPUT_PATH),
    runnerCommand(RUNNER_PATH, level, RUNNER_INPUT_PATH, RECHECK_OUTPUT_PATH, REPORT_OUTPUT_PATH),
  ]),
);
/**
 * The diff capture's bounded READ half, built by the same production builder
 * the command composes — so a transport change edits the product, not this
 * double. The redirect (`gh pr diff … > file`) is the part that never changes.
 */
const DIFF_READ = boundedFileReadCommand(DIFF_PATH, DIFF_PREFETCH_MAX_BYTES);
/** The audited bounded reads, built by production code from the fixed paths. */
const RECHECK_DOC_READ = readRecheckCommand(RECHECK_OUTPUT_PATH);
const RECHECK_STATUS_READ = readRecheckStatusCommand(RECHECK_STATUS_PATH);
const REPORT_READ = readReportCommand();
const PR_BODY_READ = prBodyCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER);
/**
 * The input write is the one command with a per-round payload; its fixed head
 * and tail come from the builder itself, so only the base64 body is asserted
 * by shape.
 */
const WRITE_INPUT_PLACEHOLDER = "QUJD"; // base64("ABC")
const WRITE_INPUT_PROBE = writeJsonCommand(RUNNER_INPUT_PATH, WRITE_INPUT_PLACEHOLDER);
const WRITE_INPUT_HEAD = WRITE_INPUT_PROBE.slice(0, WRITE_INPUT_PROBE.indexOf(WRITE_INPUT_PLACEHOLDER));
const WRITE_INPUT_TAIL = WRITE_INPUT_PROBE.slice(
  WRITE_INPUT_PROBE.indexOf(WRITE_INPUT_PLACEHOLDER) + WRITE_INPUT_PLACEHOLDER.length,
);

export type FakeSandboxState = {
  calls: Array<{ cmd: string; opts?: unknown }>;
  /** Commands built by the production builders for the batch's payload. */
  gitOps: Map<string, keyof GitOpsCommands>;
  /** Authoritative sha the checkout reports (becomes the round's HEAD). */
  resolvedSha: string;
  revParseExitCode: number;
  cloneExitCode: number;
  /** The diff FILE the production command writes; the double streams it back bounded. */
  diffStdout: string;
  diffExitCode: number;
  /**
   * Raw stdout a BROKEN transport answers the bounded read with, replacing the
   * command's own `<content>\n<flag>\n` reply (an empty one has no flag line).
   * `null` = answer like the real command.
   */
  diffReadStdout: string | null;
  numstatStdout: string;
  numstatExitCode: number;
  /** The `gh api .../compare/base...head` verdict (`ahead` starts an increment round). */
  compareStatus: string;
  compareExitCode: number;
  /** The increment round's base...head diff FILE content + its command's exit. */
  incrementDiffStdout: string;
  incrementDiffExitCode: number;
  writeInputExitCode: number;
  /** Decoded runner --input JSON written via the base64 write step. */
  writtenInputJson: string | undefined;
  /** `gh pr view`/`gh issue view` answers for the report seat's PR context. */
  prBodyContent: string;
  prBodyExitCode: number;
  issueBodies: Map<number, { title: string; body: string }>;
  issueViewExitCode: number;
  /** The runner's recheck document and the `wc -c` overflow flag of its read. */
  recheckFileContent: string;
  recheckFileOverflow: string;
  recheckFileExitCode: number;
  /** The seat's status document; `null` = the runner wrote none. */
  recheckStatusContent: string | null;
  recheckStatusOverflow: string;
  recheckStatusExitCode: number;
  /** The runner's report document (mstar.report/v1) and its read's overflow flag. */
  reportFileContent: string;
  reportFileOverflow: string;
  reportFileExitCode: number;
  runnerStdout: string;
  runnerStderr: string;
  runnerExitCode: number;
  /** Thrown from every exec instead of answering (sandbox transport failure). */
  error: Error | undefined;
  destroyCalls: number;
  destroyError: Error | undefined;
  /** Runs at the FIRST sandbox command of a test (ordering probes). */
  probe: (() => void) | undefined;
  /** Holds the FIRST runner exec; `reached` resolves once it is parked. */
  gate: { released: Promise<void>; markReached: () => void } | undefined;
};

export function initialFakeSandboxState(): FakeSandboxState {
  return {
    calls: [],
    gitOps: new Map(DEFAULT_GITOPS),
    resolvedSha: SHA,
    revParseExitCode: 0,
    cloneExitCode: 0,
    // A HEALTHY capture by default: an empty diff next to the non-empty numstat
    // below is a capture FAILURE, so an untouched case would silently take the
    // context-incomplete path. Cases that need a lost capture opt in explicitly.
    diffStdout: VALID_DIFF,
    diffExitCode: 0,
    diffReadStdout: null,
    numstatStdout: "10\t2\tsrc/auth.ts\n5\t0\tdocs/readme.md\n",
    numstatExitCode: 0,
    compareStatus: "ahead",
    compareExitCode: 0,
    incrementDiffStdout: "",
    incrementDiffExitCode: 0,
    writeInputExitCode: 0,
    writtenInputJson: undefined,
    // Default: gh cannot answer, so no prContext is captured and the runner
    // gets no `--report-out` — every pre-report call sequence stays intact.
    // A report-path case sets this to 0 and scripts `prBodyContent`.
    prBodyContent: "",
    prBodyExitCode: 1,
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
    destroyCalls: 0,
    destroyError: undefined,
    probe: undefined,
    gate: undefined,
  };
}

/** Reset the state IN PLACE, so the double keeps reading the same object. */
export function resetFakeSandboxState(state: FakeSandboxState): void {
  Object.assign(state, initialFakeSandboxState());
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/** The declared command set; an unlisted command is a test failure, not a pass. */
function answerCommand(cmd: string, state: FakeSandboxState): ExecResult {
  switch (state.gitOps.get(cmd)) {
    case "clone":
      return { stdout: "", stderr: "", exitCode: state.cloneExitCode };
    case "checkedOutSha":
      return { stdout: `${state.resolvedSha}\n`, stderr: "", exitCode: state.revParseExitCode };
    case "diff": {
      // Production shape (`diffCommand`): gh redirects the diff into the file,
      // then its READ HALF streams it back — first DIFF_PREFETCH_MAX_BYTES
      // bytes, `\n`, then the `wc -c` overflow flag. DIFF_READ is built by the
      // production builder, so a transport change edits the product, never
      // this double. (The retired redirect-only shape carries no read half and
      // is not a command any builder emits, so it never reaches this case.)
      if (state.diffExitCode !== 0) {
        // `gh` fails the chain BEFORE the read half runs: no bounded payload
        // can accompany a failed exit.
        return { stdout: "", stderr: "gh failed", exitCode: state.diffExitCode };
      }
      if (!cmd.endsWith(DIFF_READ)) {
        throw new Error(`fake sandbox: diff command without its bounded read: ${cmd}`);
      }
      // The command ALWAYS terminates its reply with the flag line; only a
      // broken transport does not, which `diffReadStdout` reproduces.
      if (state.diffReadStdout !== null) {
        return { stdout: state.diffReadStdout, stderr: "", exitCode: 0 };
      }
      // `diffStdout` is the FILE content here, so returning it raw (the defect
      // this replaced) could never exercise the transport.
      const bytes = Buffer.from(state.diffStdout);
      const head = bytes.subarray(0, DIFF_PREFETCH_MAX_BYTES).toString();
      const overflow = bytes.byteLength > DIFF_PREFETCH_MAX_BYTES ? "1" : "0";
      return { stdout: `${head}\n${overflow}\n`, stderr: "", exitCode: 0 };
    }
    case "numstat":
      return { stdout: state.numstatStdout, stderr: "", exitCode: state.numstatExitCode };
    case "runner":
      return { stdout: state.runnerStdout, stderr: state.runnerStderr, exitCode: state.runnerExitCode };
    default:
      break;
  }
  if (cmd.startsWith(WRITE_INPUT_HEAD) && cmd.endsWith(WRITE_INPUT_TAIL)) {
    const payload = cmd.slice(WRITE_INPUT_HEAD.length, cmd.length - WRITE_INPUT_TAIL.length);
    state.writtenInputJson = Buffer.from(payload, "base64").toString("utf8");
    return { stdout: "", stderr: "", exitCode: state.writeInputExitCode };
  }
  if (cmd === RECHECK_DOC_READ) {
    if (state.recheckFileExitCode !== 0) {
      return { stdout: "", stderr: "read failed", exitCode: state.recheckFileExitCode };
    }
    return { stdout: `${state.recheckFileContent}\n${state.recheckFileOverflow}\n`, stderr: "", exitCode: 0 };
  }
  // The report seat's PR context reads. The PR body is OPTIONAL (`null` = gh
  // failed), so a case that does not script one sees the real "no context"
  // path: no prContext, no --report-out, `none` headings.
  if (cmd === PR_BODY_READ) {
    // `gh pr view` failing (non-zero exit) is the real "no PR context" path.
    if (state.prBodyExitCode !== 0) return { stdout: "", stderr: "gh failed", exitCode: state.prBodyExitCode };
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
    // A missing status file fails the head chain, exactly like the real one.
    if (state.recheckStatusContent === null) return { stdout: "", stderr: "no such file", exitCode: 1 };
    return { stdout: `${state.recheckStatusContent}\n${state.recheckStatusOverflow}\n`, stderr: "", exitCode: 0 };
  }
  // Increment rounds: the compare verdict, then base...head replacing the diff
  // file. Both are identified by their stable command shape (the shas are
  // per-round), so the double stays payload-agnostic exactly like the diff read.
  if (cmd.startsWith("gh api 'repos/") && cmd.includes("/compare/") && cmd.endsWith(".status'")) {
    return { stdout: `${state.compareStatus}\n`, stderr: "", exitCode: state.compareExitCode };
  }
  if (cmd.startsWith("gh api -H 'Accept: application/vnd.github.v3.diff'")) {
    const bytes = Buffer.from(state.incrementDiffStdout);
    const head = bytes.subarray(0, DIFF_PREFETCH_MAX_BYTES).toString();
    const overflow = bytes.byteLength > DIFF_PREFETCH_MAX_BYTES ? "1" : "0";
    return { stdout: `${head}\n${overflow}\n`, stderr: "", exitCode: state.incrementDiffExitCode };
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

/** The injected sandbox double: `state` carries every per-test knob. */
export function createFakeSandbox(state: FakeSandboxState = initialFakeSandboxState()) {
  return {
    state,
    runCommand: mock(async (cmd: string, opts?: unknown) => {
      const first = state.calls.length === 0;
      state.calls.push({ cmd, opts });
      if (first && state.probe !== undefined) state.probe();
      if (state.error !== undefined) throw state.error;
      if (cmd.includes("--input") && state.gate !== undefined) {
        const gate = state.gate;
        state.gate = undefined; // only the first runner exec is held
        gate.markReached();
        await gate.released;
      }
      return answerCommand(cmd, state);
    }),
    destroy: mock(async () => {
      state.destroyCalls += 1;
      if (state.destroyError !== undefined) throw state.destroyError;
    }),
  };
}

// ---------------------------------------------------------------------------
// Log sink double (injected via the consumer's optional log param).
// ---------------------------------------------------------------------------

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
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
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
