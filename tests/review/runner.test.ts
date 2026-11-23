
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { MstarReviewV1 } from "@mstar-harness/engine";
import { APPLIED_MODEL_PATH } from "../../packages/shared/src/runtime";
import { FAILURE_BLOCK_BUDGET_CHARS } from "../../packages/runner/src/seat-failover-probe";
import type { AgentRuntime, AgentRuntimeRunInput, CustomProviderDeclaration, ReviewRunResult } from "../../packages/shared/src/runtime";
import type { CapabilityHost } from "../../packages/shared/src/runtime";
import { encodeCredentialPayload } from "../../packages/shared/src/credential-payload";
import type { RecheckStatus } from "../../packages/shared/src/recheck-wire";
import { RunnerBudgetExhausted } from "../../packages/shared/src/budget-exhausted-wire";
import { readRecheckStatusCommand } from "../../src/pipeline/gitops";
import {
  chainAttributionBlock,
  createInMemoryAuthStorage,
  main,
  parseRunnerInput,
  readCredentialStdin,
  writeRecheckStatus,
} from "../../packages/runner/src/runner";
import { sk } from "../helpers/fake-secrets";

let fakeEnvelope: Record<string, unknown> | undefined;
let fakeRecheck: Record<string, unknown> | null = null;
let fakeRecheckStatus: RecheckStatus | undefined;
let fakeReport: Record<string, unknown> | null = null;
let runtimeError: Error | undefined;
let fakeAppliedModel: string | undefined;
const CHAIN = "commandcode/deepseek/deepseek-v4.1-flash, opencode-go/deepseek-v4.1-flash";
const runInputs: AgentRuntimeRunInput[] = [];
const runDirs: string[] = [];
let inFlight: { dir: string; hadStore: boolean } | undefined;
const runStores: unknown[] = [];
const preserved: { dir: string; parent: string }[] = [];

function preserveAgentDir(dir: string): void {
  const parent = mkdtempSync(join(tmpdir(), "runner-preserved-"));
  const copy = join(parent, "omp-agent-preserved");
  cpSync(dir, copy, { recursive: true });
  preserved.push({ dir: copy, parent });
}

function preservedAgentDir(): string {
  const latest = preserved.at(-1);
  if (latest === undefined) throw new Error("no per-run directory was captured");
  return latest.dir;
}

const fakeRuntime: AgentRuntime = {
  runReview: mock(async (input: AgentRuntimeRunInput): Promise<ReviewRunResult> => {
    runInputs.push(input);
    runDirs.push(input.agentDir);
    runStores.push(input.authStorage);
    inFlight = { dir: input.agentDir, hadStore: existsSync(join(input.agentDir, "agent.db")) };
    preserveAgentDir(input.agentDir);
    if (runtimeError) throw runtimeError;
    return {
      envelope: fakeEnvelope as MstarReviewV1,
      recheck: fakeRecheck as ReviewRunResult["recheck"],
      ...(fakeRecheckStatus !== undefined ? { recheckStatus: fakeRecheckStatus } : {}),
      report: fakeReport as ReviewRunResult["report"],
      ...(fakeAppliedModel !== undefined ? { appliedModel: fakeAppliedModel } : {}),
    };
  }),
};

const ENVELOPE = {
  schema: "mstar.review/v1",
  verdict: "blocked",
  summary_md: "summary",
  findings: [],
};

const OMP_HOSTS: CapabilityHost[] = [];

const HELPER_STORE_PROBE = `
import { createInMemoryAuthStorage } from "./packages/runner/src/runner";
const storage = await createInMemoryAuthStorage();
await storage.credentials.set("openai", [{ type: "api_key", key: "__KEY__", source: "login" }]);
console.log("KEY=" + (await storage.keys.get("openai")));
storage.close();
`;

function writeInput(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-input-"));
  const path = join(dir, "input.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

function statusPathForRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "recheck-status-"));
  statusDirs.push(dir);
  return join(dir, "status.json");
}

async function runCli(
  argv: string[],
  payload = encodeCredentialPayload({}),
  appliedModelPath = APPLIED_MODEL_PATH,
): Promise<{ code: number; stdout: string; stderr: string; statusPath: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const statusPath = statusPathForRun();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const code = await main(argv, fakeRuntime, async () => payload, statusPath, appliedModelPath);
    return { code, stdout: logs.join("\n"), stderr: errors.join("\n"), statusPath };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

type PtyRun = {
  ended: boolean;
  code: number | null;
  isTTY: boolean | null;
  dir: string | null;
  hadStore: boolean | null;
  dirAfterRun: boolean | null;
  output: string;
};

function parseFixtureResult(value: unknown): Omit<PtyRun, "ended" | "output"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("code" in value) || !("isTTY" in value) || !("dir" in value)) return undefined;
  if (!("hadStore" in value) || !("dirAfterRun" in value)) return undefined;
  const { code, isTTY, dir, hadStore, dirAfterRun } = value;
  if (code !== null && typeof code !== "number") return undefined;
  if (typeof isTTY !== "boolean") return undefined;
  if (dir !== null && typeof dir !== "string") return undefined;
  if (typeof hadStore !== "boolean") return undefined;
  if (typeof dirAfterRun !== "boolean") return undefined;
  return { code, isTTY, dir, hadStore, dirAfterRun };
}

/**
 * why: Drive the REAL runner entry (the default stdin reader) inside a real pty, so
 * the child genuinely sees `process.stdin.isTTY === true` — the documented
 * local `bun run packages/runner/src/runner.ts …` path, which has no pipe and therefore
 * no EOF. The fixture reports the resulting exit code, that the stdin really
 * was a terminal, and what the per-run credential directory held while the
 * runtime ran versus after main() returned. A run that never ends (the pre-fix
 * read waiting for Ctrl-D) reports `ended: false`.
 * Shortcut limit: POSIX pty only — the interactive path this guards exists on
 * macOS/Linux; upgrade: if a Windows CI target ever appears.
 */
async function runRealStdinInPty(inputPath: string): Promise<PtyRun> {
  const chunks: string[] = [];
  const fixture = [
    `import { existsSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `const { main } = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "packages", "runner", "src", "runner.ts"))});`,
    `const seen = { dir: null, hadStore: false };`,
    `const runtime = { runReview: async (input) => {`,
    `  seen.dir = input.agentDir;`,
    `  seen.hadStore = existsSync(join(input.agentDir, "agent.db"));`,
    `  return { envelope: { schema: "mstar.review/v1", verdict: "blocked", summary_md: "s", findings: [] }, recheck: null };`,
    `} };`,
    `const code = await main(["--level", "quick", "--input", ${JSON.stringify(inputPath)}], runtime);`,
    `console.log("FIXTURE_RESULT " + JSON.stringify({ code, isTTY: process.stdin.isTTY,`,
    `  dir: seen.dir, hadStore: seen.hadStore, dirAfterRun: seen.dir === null ? false : existsSync(seen.dir) }));`,
    `process.exit(0);`,
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", fixture], {
    cwd: join(import.meta.dir, "..", ".."),
    terminal: { cols: 120, rows: 40, data: (_terminal, data) => chunks.push(data.toString()) },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 10_000);
    }),
  ]);
  clearTimeout(timer);
  const output = chunks.join("");
  if (!exited) {
    proc.terminal?.close();
    return { ended: false, code: null, isTTY: null, dir: null, hadStore: null, dirAfterRun: null, output };
  }
  proc.terminal?.close();
  const line = output.split("\n").find((candidate) => candidate.includes("FIXTURE_RESULT "));
  const raw = line?.slice(line.indexOf("FIXTURE_RESULT ") + "FIXTURE_RESULT ".length).replace(/\r/g, "");
  const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw);
  const result = parseFixtureResult(parsed);
  if (result === undefined) throw new Error(`pty fixture reported no result: ${JSON.stringify(output)}`);
  return { ended: true, ...result, output };
}

function agentDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("omp-agent-"))
    .map((name) => join(tmpdir(), name));
}

async function runCliWithoutStore(
  argv: string[],
  payload: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const before = new Set(agentDirs());
  const result = await runCli(argv, payload);
  const created = agentDirs().filter((dir) => !before.has(dir));
  expect(created.filter((dir) => existsSync(join(dir, "agent.db")))).toEqual([]);
  return result;
}

function cleanupAgentDirs(): void {
  for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
  runDirs.length = 0;
}

const statusDirs: string[] = [];

afterEach(() => {
  fakeEnvelope = ENVELOPE;
  fakeRecheck = null;
  fakeRecheckStatus = undefined;
  fakeReport = null;
  runtimeError = undefined;
  fakeAppliedModel = undefined;
  cleanupAgentDirs();
  runInputs.length = 0;
  runStores.length = 0;
  inFlight = undefined;
  for (const copy of preserved) rmSync(copy.parent, { recursive: true, force: true });
  preserved.length = 0;
  for (const dir of statusDirs) rmSync(dir, { recursive: true, force: true });
  statusDirs.length = 0;
  delete process.env.OMP_REVIEW_MODEL;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("MSTAR_POOL_")) delete process.env[name];
  }
});

const RECHECK_INPUT_DOC = {
  schema: "mstar.recheck-input/v1",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  targets: [],
  evidence: [],
  discussion: { items: [], issueCoverage: "complete", issueModelCoverage: "complete", issueDigest: "d", capturedMs: 1, threads: [] },
};

const RECHECK_RESULT_DOC = {
  schema: "mstar.recheck/v1",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  results: [],
};

describe("runner entry (packages/runner/src/runner.ts)", () => {
  test("valid invocation → exit 0, stdout is ONLY the envelope JSON", async () => {
    fakeEnvelope = ENVELOPE;
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      worktreePath: "/workspace/clone",
      reconFacts: ["acme/widgets#7"],
    });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(stderr).toBe("");
    expect(runInputs).toHaveLength(1);
    const input = runInputs[0]!;
    expect(input.level).toBe("quick");
    expect(input.worktreePath).toBe("/workspace/clone");
    expect(input.reconFacts).toEqual(["acme/widgets#7"]);
    expect(input.modelSelectors).toEqual([]);
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
  });

  test("defaults: worktreePath = cwd, reconFacts = [], model chain from env parsing", async () => {
    process.env.OMP_REVIEW_MODEL = "acme/fast-model, acme/backup-model";
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code } = await runCli(["--level", "default", "--input", inputPath]);

    expect(code).toBe(0);
    const input = runInputs[0]!;
    expect(input.level).toBe("default");
    expect(input.worktreePath).toBe(process.cwd());
    expect(input.reconFacts).toEqual([]);
    expect(input.modelSelectors).toEqual(["acme/fast-model", "acme/backup-model"]);
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
  });

  test("usage errors → exit 2, stdout empty", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    for (const argv of [
      [],
      ["--level", "quick"],
      ["--input", inputPath],
      ["--level", "quick", "--input"],
      ["--level", "quick", "--input", inputPath, "--extra"],
      ["--level", "9000", "--input", inputPath],
    ]) {
      const { code, stdout } = await runCli(argv);
      expect(code).toBe(2);
      expect(stdout).toBe("");
    }
    expect(runInputs).toHaveLength(0);
  });

  test("--level deep parses and reaches the runtime — forwarded into runReview", async () => {
    fakeEnvelope = ENVELOPE;
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "deep", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(runInputs[0]).toMatchObject({ level: "deep", worktreePath: "/workspace/clone" });
  });

  test("unknown level → exit 2; message lists every tier from REVIEW_LEVELS", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stdout, stderr } = await runCli(["--level", "9000", "--input", inputPath]);

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("quick, default, deep");
  });

  test("unreadable input file → exit 1, stdout empty, stderr diagnostic", async () => {
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", "/nonexistent/input.json"]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("cannot read runner input");
  });

  test("malformed input JSON → exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-input-"));
    const path = join(dir, "input.json");
    writeFileSync(path, "{ not json");
    const { code, stdout } = await runCli(["--level", "quick", "--input", path]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
  });

  test("input shape violations → exit 1", async () => {
    for (const bad of [
      [1, 2, 3],
      {},
      { capabilityHosts: "not-an-array" },
      { capabilityHosts: [42] },
      { capabilityHosts: [{}] },
      { capabilityHosts: [{ id: 42, catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey" }] },
      { capabilityHosts: [{ id: "h", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey", models: "nope" }] },
      { capabilityHosts: [{ id: "h", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey", models: [42] }] },
      { capabilityHosts: [{ id: "h", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey", models: [{ id: "m", name: "M", reasoning: "yes", input: ["text"], contextWindow: 1, maxTokens: 2 }] }] },
      { worktreePath: 42 },
      { reconFacts: "not-an-array" },
      { reconFacts: [1, 2] },
      { modelOverrides: "not-an-object" },
      { modelOverrides: [] },
      { modelOverrides: null },
      { modelOverrides: { "mstar-review-seat": 42 } },
      { modelOverrides: { "code-reviewer": { nested: "object" } } },
      { customProviders: "not-an-array" },
      { customProviders: [42] },
      { customProviders: [{}] },
      { customProviders: [{ provider_id: 42, base_url: "u", api: "a", model_ids: ["m"] }] },
      { customProviders: [{ provider_id: "p", base_url: "u", api: "a", model_ids: "nope" }] },
      { customProviders: [{ provider_id: "p", base_url: "u", api: "a", model_ids: [1, 2] }] },
      { recheck: "nope" },
      { recheck: 42 },
      { recheck: [] },
      { recheck: {} },
      { recheck: { schema: "mstar.review/v1" } },
      { recheck: { ...RECHECK_INPUT_DOC, schema: "other/v1" } },
      { recheck: { ...RECHECK_INPUT_DOC, headSha: "" } },
      { recheck: { ...RECHECK_INPUT_DOC, headSha: 42 } },
      { recheck: { ...RECHECK_INPUT_DOC, targets: "not-an-array" } },
      { recheck: { ...RECHECK_INPUT_DOC, evidence: "not-an-array" } },
      { recheck: { ...RECHECK_INPUT_DOC, discussion: null } },
      { recheck: { ...RECHECK_INPUT_DOC, discussion: [] } },
    ]) {
      const inputPath = writeInput(bad);
      const { code, stdout } = await runCli(["--level", "quick", "--input", inputPath]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
    }
  });

  test("customProviders.models_meta: every malformed shape exits 1 naming the field", async () => {
    const malformed: Array<[unknown, RegExp]> = [
      ["nope", /models_meta must be an object keyed by model id/],
      [[], /models_meta must be an object keyed by model id/],
      [{ "m": 42 }, /models_meta\["m"\] must be an object/],
      [{ "ghost": { contextWindow: 1, maxTokens: 2 } }, /models_meta\["ghost"\] names a model that is not in model_ids/],
      [{ "m": { contextWindow: 0, maxTokens: 8 } }, /\.contextWindow must be a positive integer/],
      [{ "m": { contextWindow: 1.5, maxTokens: 8 } }, /\.contextWindow must be a positive integer/],
      [{ "m": { contextWindow: "128000", maxTokens: 8 } }, /\.contextWindow must be a positive integer/],
      [{ "m": { contextWindow: 8, maxTokens: -1 } }, /\.maxTokens must be a positive integer/],
      [{ "m": { contextWindow: 8, maxTokens: true } }, /\.maxTokens must be a positive integer/],
      [{ "m": { name: 42 } }, /\.name must be a string/],
      [{ "m": { reasoning: "yes" } }, /\.reasoning must be a boolean/],
      [{ "m": { input: "text" } }, /\.input must be an array of strings/],
      [{ "m": { input: ["text", 42] } }, /\.input must be an array of strings/],
      [{ "m": { contextwindow: 8 } }, /is not a known model-metadata field/],
      [{ "m": { contextWindow: null, maxTokens: 8 } }, /\.contextWindow must be a positive integer/],
      [{ "m": { contextWindow: 8, maxTokens: 8, name: null } }, /\.name must be a string/],
      [{ "m": { contextWindow: 8, maxTokens: 8, input: null } }, /\.input must be an array of strings/],
    ];
    for (const [modelsMeta, message] of malformed) {
      const inputPath = writeInput({
        capabilityHosts: OMP_HOSTS,
        customProviders: [
          {
            provider_id: "p",
            base_url: "https://p.example.com/v1",
            api: "openai-completions",
            model_ids: ["m"],
            models_meta: modelsMeta,
          },
        ],
      });
      const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(message);
    }
  });

  test("non-finite model numbers → exit 1 (QC fix wave 1: typeof alone admits ±Infinity)", async () => {
    const rawCases = [
      '{"capabilityHosts":[{"id":"h","catalogProviderId":"ark","apiKeyEnv":"K","baseUrl":"u","api":"a","auth":"apiKey","models":[{"id":"m","name":"M","reasoning":true,"input":["text"],"contextWindow":1e999,"maxTokens":2}]}]}',
      '{"capabilityHosts":[{"id":"h","catalogProviderId":"ark","apiKeyEnv":"K","baseUrl":"u","api":"a","auth":"apiKey","models":[{"id":"m","name":"M","reasoning":true,"input":["text"],"contextWindow":1,"maxTokens":-1e999}]}]}',
    ];
    for (const raw of rawCases) {
      const dir = mkdtempSync(join(tmpdir(), "runner-input-"));
      const path = join(dir, "input.json");
      writeFileSync(path, raw);
      const { code, stdout } = await runCli(["--level", "quick", "--input", path]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
    }
  });

  test("modelOverrides rides into the runtime input verbatim", async () => {
    const overrides = {
      "mstar-review-seat": "acme/fast-model:high",
      "code-reviewer": "openai/gpt-5:thinking, anthropic/claude-x",
      "unknown-agent": "whatever/provider",
    };
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      worktreePath: "/workspace/clone",
      modelOverrides: overrides,
    });
    const { code, stderr } = await runCli(["--level", "deep", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const input = runInputs[0]!;
    expect(input.modelOverrides).toEqual(overrides);
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
  });

  test("a failed round names every chain selector and the gate that dropped it", async () => {
    process.env.OMP_REVIEW_MODEL = CHAIN;
    runtimeError = new Error("seat 0 failed: 400 You have insufficient credits");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stdout, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ commandcode: [sk("probe-first")] }),
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("400 You have insufficient credits");
    expect(stderr).toContain("commandcode/deepseek/deepseek-v4.1-flash");
    expect(stderr).toContain("opencode-go/deepseek-v4.1-flash");
    expect(stderr).toContain("pool_key");
    expect(stderr).toContain("the App stores no credential for provider opencode-go");
    expect(stderr).not.toContain("served");
    expect(stderr.trim().length).toBeLessThanOrEqual(FAILURE_BLOCK_BUDGET_CHARS);
    expect(stderr).not.toContain(sk("probe-first"));
  });

  test("a pre-prompt failure claims no provider served — every entry reports its own verdict", async () => {
    process.env.OMP_REVIEW_MODEL = CHAIN;
    runtimeError = new Error("seat 0 failed: model provider unreachable during setup");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ commandcode: [sk("probe-first")], "opencode-go": [sk("probe-second")] }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("unreachable during setup");
    expect(stderr).toContain("commandcode/deepseek/deepseek-v4.1-flash eligible");
    expect(stderr).toContain("opencode-go/deepseek-v4.1-flash eligible");
    expect(stderr).not.toContain("served");
    expect(stderr).not.toContain("observed serving this round");
  });

  test("a run whose seat override replaced the chain does not name the configured head as served", async () => {
    process.env.OMP_REVIEW_MODEL = CHAIN;
    runtimeError = new Error("seat 0 failed: 429 rate limited");
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      modelOverrides: { "mstar-review-seat": "my-custom/model-a" },
      customProviders: [
        {
          provider_id: "my-custom",
          base_url: "https://custom.example.invalid/v1",
          api: "openai-completions",
          model_ids: ["model-a"],
        },
      ],
    });
    const { code, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ "my-custom": [sk("probe-third")] }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("429 rate limited");
    expect(stderr).toContain("chain attribution (configured)");
    expect(stderr).not.toContain("served");
  });

  test("a chain longer than the persisted tail keeps the cause and folds the overflow with a count", async () => {
    const longChain = Array.from({ length: 20 }, (_, i) => `provider-with-a-long-id-${i}/model-with-a-long-id-${i}`).join(", ");
    process.env.OMP_REVIEW_MODEL = longChain;
    runtimeError = new Error("seat 0 failed: 400 You have insufficient credits");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath], encodeCredentialPayload({}));

    expect(code).toBe(1);
    expect(stderr.trim().length).toBeLessThanOrEqual(FAILURE_BLOCK_BUDGET_CHARS);
    expect(stderr).toContain("400 You have insufficient credits");
    expect(stderr).toContain("provider-with-a-long-id-0/model-with-a-long-id-0");
    expect(stderr).toMatch(/\+\d+ more chain entries omitted/);
    expect(stderr).not.toContain("served");
  });

  test("an attribution failure keeps the provider cause and stays inside the budget", async () => {
    const cause = "seat 0 failed: 400 You have insufficient credits";
    const diagnostic = `x`.repeat(3000);
    const explodingAuth = new Proxy({} as never, {
      get(): never {
        throw new Error(diagnostic);
      },
    });
    const block = chainAttributionBlock(cause, [CHAIN], "/nonexistent-agent-dir", explodingAuth);

    expect(block).toContain(cause);
    expect(block.indexOf(cause)).toBeLessThan(block.indexOf("attribution unavailable"));
    expect(block.length).toBeLessThanOrEqual(FAILURE_BLOCK_BUDGET_CHARS);
    expect(block).toContain("chain attribution unavailable");
    expect(block).not.toContain(diagnostic);
  });
  test("a fully-keyed failed round names no gate as the cause", async () => {
    process.env.OMP_REVIEW_MODEL = CHAIN;
    runtimeError = new Error("seat 0 failed: 400 You have insufficient credits");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ commandcode: [sk("probe-first")], "opencode-go": [sk("probe-second")] }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("opencode-go/deepseek-v4.1-flash");
    expect(stderr).not.toContain("dropped at");
    expect(stderr).toContain("eligible");
    expect(stderr).not.toContain("served");
  });

  test("a served round writes the applied-model side document; a round with none removes any leftover", async () => {
    fakeEnvelope = ENVELOPE;
    const target = join(mkdtempSync(join(tmpdir(), "applied-model-")), "review-applied-model.json");
    try {
      writeFileSync(target, JSON.stringify({ appliedModel: "stale/leftover" }));
      fakeAppliedModel = "anthropic/claude-app";
      const servedPath = writeInput({ capabilityHosts: OMP_HOSTS });
      const served = await runCli(["--level", "quick", "--input", servedPath], undefined, target);
      expect(served.code).toBe(0);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
        appliedModel: "anthropic/claude-app",
      });
      const published = JSON.parse(served.stdout) as Record<string, unknown>;
      expect(published.appliedModel).toBeUndefined();
      expect(published.schema).toBe("mstar.review/v1");

      fakeAppliedModel = undefined;
      const idlePath = writeInput({ capabilityHosts: OMP_HOSTS });
      const idle = await runCli(["--level", "quick", "--input", idlePath], undefined, target);
      expect(idle.code).toBe(0);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(APPLIED_MODEL_PATH, { force: true });
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });

  test("runtime failure → exit 1, stdout empty, stderr diagnostic", async () => {
    runtimeError = new Error("seat 0 failed: provider boom");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("runtime failed");
    expect(stderr).toContain("provider boom");
  });

  test("runner budget stop → exit 0 and stdout is ONLY the mstar.review-budget-exhausted/v1 signal", async () => {
    runtimeError = new RunnerBudgetExhausted(2, 1);
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stdout } = await runCli(["--level", "default", "--input", inputPath]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schema: "mstar.review-budget-exhausted/v1",
      seatsDispatched: 2,
      seatsStopped: 1,
    });
  });

  test("a budget stop still writes its side documents: applied model, recheck doc and status", async () => {
    const exhausted = new RunnerBudgetExhausted(1, 1);
    exhausted.appliedModel = "ark/claude-opus-4-7";
    exhausted.recheck = {
      schema: "mstar.recheck/v1",
      headSha: "abc123",
      results: [],
    };
    exhausted.recheckStatus = {
      schema: "mstar.recheck-status/v1",
      headSha: "abc123",
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: null,
    };
    runtimeError = exhausted;
    const dir = mkdtempSync(join(tmpdir(), "runner-budget-side-"));
    const outPath = join(dir, "recheck.json");
    const appliedPath = join(dir, "applied.json");
    try {
      const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
      const { code, stdout, statusPath } = await runCli(
        ["--level", "quick", "--input", inputPath, "--recheck-out", outPath],
        undefined,
        appliedPath,
      );

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        schema: "mstar.review-budget-exhausted/v1",
        seatsDispatched: 1,
        seatsStopped: 1,
      });
      expect(JSON.parse(readFileSync(appliedPath, "utf8"))).toEqual({ appliedModel: "ark/claude-opus-4-7" });
      expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({
        schema: "mstar.recheck/v1",
        headSha: "abc123",
        results: [],
      });
      expect(JSON.parse(readFileSync(statusPath, "utf8"))).toEqual({
        schema: "mstar.recheck-status/v1",
        headSha: "abc123",
        outcome: "ok",
        reason: null,
        rejected: 0,
        rejected_row_ids: [],
        rejected_unnamed: 0,
        error: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a --recheck-out write failure still emits the budget signal: exit 0 + stderr diagnostic", async () => {
    const exhausted = new RunnerBudgetExhausted(1, 1);
    exhausted.recheck = {
      schema: "mstar.recheck/v1",
      headSha: "abc123",
      results: [],
    };
    runtimeError = exhausted;
    const dir = mkdtempSync(join(tmpdir(), "runner-budget-side-"));
    try {
      const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
      const { code, stdout, stderr } = await runCli([
        "--level",
        "quick",
        "--input",
        inputPath,
        "--recheck-out",
        join(dir, "missing", "recheck.json"),
      ]);

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        schema: "mstar.review-budget-exhausted/v1",
        seatsDispatched: 1,
        seatsStopped: 1,
      });
      expect(stderr).toContain("cannot write recheck output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ALWAYS synthesizes: a zero-custom run rides an agentDir whose models.yml is a bare providers header", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(runInputs).toHaveLength(1);
    const input = runInputs[0]!;
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    const yaml = readFileSync(join(preservedAgentDir(), "models.yml"), "utf8");
    expect(yaml).toBe("providers:\n");
  });

  test("customProviders: the declarations are the whole models.yml and ride agentDir into the runtime input", async () => {
    fakeEnvelope = ENVELOPE;
    const decls: CustomProviderDeclaration[] = [
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["my-model-1"],
      },
    ];
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      worktreePath: "/workspace/clone",
      customProviders: decls,
    });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(runInputs).toHaveLength(1);
    const input = runInputs[0]!;
    expect(Object.keys(input)).not.toContain("customProviders");
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    expect(input.worktreePath).toBe("/workspace/clone");
    const yaml = readFileSync(join(preservedAgentDir(), "models.yml"), "utf8");
    expect(yaml).toMatch(/^providers:\n/);
    expect(yaml).not.toMatch(/^\s*apiKey:/m);
    expect(yaml).toContain('"my-provider":');
    expect(yaml).toContain("auth: oauth");
    expect(yaml).not.toContain(sk("live"));
  });

  test("customProviders.models_meta: the parsed input keeps every stated fact and no absent one", () => {
    const input = parseRunnerInput({
      capabilityHosts: OMP_HOSTS,
      customProviders: [
        {
          provider_id: "with-meta",
          base_url: "https://with-meta.example.com/v1",
          api: "openai-completions",
          model_ids: ["m1"],
          models_meta: {
            m1: { contextWindow: 128_000, maxTokens: 8_192, name: "M1", reasoning: true, input: ["text", "image"] },
          },
        },
        {
          provider_id: "id-only",
          base_url: "https://id-only.example.com/v1",
          api: "anthropic-messages",
          model_ids: ["m2"],
        },
      ],
    });
    expect(input.customProviders).toEqual([
      {
        provider_id: "with-meta",
        base_url: "https://with-meta.example.com/v1",
        api: "openai-completions",
        model_ids: ["m1"],
        models_meta: {
          m1: { contextWindow: 128_000, maxTokens: 8_192, name: "M1", reasoning: true, input: ["text", "image"] },
        },
      },
      {
        provider_id: "id-only",
        base_url: "https://id-only.example.com/v1",
        api: "anthropic-messages",
        model_ids: ["m2"],
      },
    ]);
    expect(Object.keys(input.customProviders![1]!)).toEqual(["provider_id", "base_url", "api", "model_ids"]);
  });
});

describe("runner entry — --recheck-out channel", () => {
  test("recheck result + flag → file written BEFORE stdout; stdout stays envelope-only", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = RECHECK_RESULT_DOC;
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const outPath = join(outDir, "recheck.json");
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      worktreePath: "/workspace/clone",
      recheck: RECHECK_INPUT_DOC,
    });
    const { code, stdout, stderr } = await runCli([
      "--level",
      "quick",
      "--input",
      inputPath,
      "--recheck-out",
      outPath,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(RECHECK_RESULT_DOC);
    expect(runInputs[0]).toMatchObject({ recheck: RECHECK_INPUT_DOC });
  });

  test("recheck result without the flag → exit 0, input still forwarded, nothing written", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = RECHECK_RESULT_DOC;
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(runInputs[0]).toMatchObject({ recheck: RECHECK_INPUT_DOC });
  });

  test("null recheck result → no doc file, but the STATUS file is written (the whole point)", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = null;
    fakeRecheckStatus = {
      schema: "mstar.recheck-status/v1",
      headSha: RECHECK_INPUT_DOC.headSha,
      outcome: "failed",
      reason: "seat-failed",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: "provider boom",
    };
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const outPath = join(outDir, "recheck.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
    const { code, stdout, statusPath } = await runCli(["--level", "quick", "--input", inputPath, "--recheck-out", outPath]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(existsSync(outPath)).toBe(false);
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toEqual(fakeRecheckStatus);
  });

  test("the written status file is the seat's status, field for field", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = RECHECK_RESULT_DOC;
    fakeRecheckStatus = {
      schema: "mstar.recheck-status/v1",
      headSha: RECHECK_INPUT_DOC.headSha,
      outcome: "ok",
      reason: null,
      rejected: 3,
      rejected_row_ids: ["row-1", "row-2"],
      rejected_unnamed: 1,
      error: null,
    };
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const outPath = join(outDir, "recheck.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
    const { code, statusPath } = await runCli(["--level", "quick", "--input", inputPath, "--recheck-out", outPath]);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toEqual(fakeRecheckStatus);
  });

  test("status write is best-effort: an unwritable status path never fails the run", () => {
    const dir = mkdtempSync(join(tmpdir(), "recheck-status-"));
    statusDirs.push(dir);
    const target = join(dir, "status.json");
    mkdirSync(target);
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      expect(() =>
        writeRecheckStatus({
          schema: "mstar.recheck-status/v1",
          headSha: RECHECK_INPUT_DOC.headSha,
          outcome: "skipped",
          reason: "budget",
          rejected: 0,
          rejected_row_ids: [],
          rejected_unnamed: 0,
          error: null,
        }, target),
      ).not.toThrow();
      expect(errors.join("\n")).toContain("cannot write recheck status");
    } finally {
      console.error = original;
    }
  });

  test("the status file's default target is the file the consumer's read command targets (round-trip)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recheck-status-"));
    statusDirs.push(dir);
    const statusFile = join(dir, "status.json");
    const priorEnv = process.env.MSTAR_RECHECK_STATUS_PATH;
    process.env.MSTAR_RECHECK_STATUS_PATH = ` ${statusFile} `;
    try {
      const status: RecheckStatus = {
        schema: "mstar.recheck-status/v1",
        headSha: RECHECK_INPUT_DOC.headSha,
        outcome: "ok",
        reason: null,
        rejected: 0,
        rejected_row_ids: [],
        rejected_unnamed: 2,
        error: null,
      };
      writeRecheckStatus(status);
      const readBack = async (): Promise<unknown> => {
        const proc = Bun.spawn(["sh", "-c", readRecheckStatusCommand(statusFile)]);
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        const trimmed = stdout.trimEnd();
        expect(trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim()).toBe("0");
        return JSON.parse(trimmed.slice(0, trimmed.lastIndexOf("\n")));
      };
      expect(await readBack()).toEqual(status);

      fakeEnvelope = ENVELOPE;
      fakeRecheck = null;
      fakeRecheckStatus = status;
      const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
      const outPath = join(outDir, "recheck.json");
      const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
      const originalLog = console.log;
      const originalError = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        const code = await main(["--level", "quick", "--input", inputPath, "--recheck-out", outPath], fakeRuntime);
        expect(code).toBe(0);
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
      expect(await readBack()).toEqual(status);
    } finally {
      if (priorEnv === undefined) delete process.env.MSTAR_RECHECK_STATUS_PATH;
      else process.env.MSTAR_RECHECK_STATUS_PATH = priorEnv;
    }
  });

  test("legacy input (no recheck field) → runtime input carries no recheck key, no file written", async () => {
    fakeEnvelope = ENVELOPE;
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const outPath = join(outDir, "recheck.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code } = await runCli(["--level", "quick", "--input", inputPath, "--recheck-out", outPath]);

    expect(code).toBe(0);
    expect(Object.keys(runInputs[0]!)).not.toContain("recheck");
    expect(existsSync(outPath)).toBe(false);
  });

  test("--recheck-out write failure → exit 1, stdout empty, stderr diagnostic", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = RECHECK_RESULT_DOC;
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
    const { code, stdout, stderr } = await runCli([
      "--level",
      "quick",
      "--input",
      inputPath,
      "--recheck-out",
      join(outDir, "missing", "recheck.json"),
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("cannot write recheck output");
  });

  test("--recheck-out without a value → usage error (exit 2)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code, stdout } = await runCli(["--level", "quick", "--input", inputPath, "--recheck-out"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
  });
});

describe("runner entry — --report-out channel", () => {
  const REPORT_DOC = {
    schema: "mstar.report/v1",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    overview: "Adds an expiry guard.",
    linkedIssueAc: "none",
    verified: "none",
    rejected: "none",
    planToFix: "none",
  };
  const PR_CONTEXT = { prBody: "Closes #7", issues: [{ number: 7, title: "Guard", body: "reject expired" }] };

  test("report + flag → file written BEFORE stdout; prContext forwarded verbatim", async () => {
    fakeEnvelope = ENVELOPE;
    fakeReport = REPORT_DOC;
    const outDir = mkdtempSync(join(tmpdir(), "report-out-"));
    const outPath = join(outDir, "report.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, prContext: PR_CONTEXT });
    const { code, stdout, stderr } = await runCli([
      "--level",
      "quick",
      "--input",
      inputPath,
      "--report-out",
      outPath,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(REPORT_DOC);
    expect(runInputs[0]).toMatchObject({ prContext: PR_CONTEXT });
  });

  test("no report result → nothing written, exit 0 (the sections degrade to `none`)", async () => {
    fakeEnvelope = ENVELOPE;
    fakeReport = null;
    const outDir = mkdtempSync(join(tmpdir(), "report-out-"));
    const outPath = join(outDir, "report.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, prContext: PR_CONTEXT });
    const { code } = await runCli(["--level", "quick", "--input", inputPath, "--report-out", outPath]);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(false);
  });

  test("a stale side-channel file is cleared before the runtime starts, so a failed seat publishes nothing", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "report-out-"));
    const reportPath = join(outDir, "report.json");
    const recheckPath = join(outDir, "recheck.json");
    const statusPath = join(outDir, "status.json");
    writeFileSync(reportPath, '{"schema":"mstar.report/v1","overview":"stale narrative"}');
    writeFileSync(recheckPath, '{"schema":"mstar.recheck/v1"}');
    writeFileSync(statusPath, '{"schema":"mstar.recheck-status/v1"}');
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, prContext: PR_CONTEXT });
    let atStart: boolean[] | undefined;
    const runtime: AgentRuntime = {
      runReview: async () => {
        atStart = [existsSync(reportPath), existsSync(recheckPath), existsSync(statusPath)];
        return { envelope: ENVELOPE as MstarReviewV1, recheck: null, report: null };
      },
    };
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const code = await main(
        ["--level", "quick", "--input", inputPath, "--recheck-out", recheckPath, "--report-out", reportPath],
        runtime,
        async () => encodeCredentialPayload({}),
        statusPath,
      );
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(atStart).toEqual([false, false, false]);
    expect([existsSync(reportPath), existsSync(recheckPath), existsSync(statusPath)]).toEqual([false, false, false]);
  });

  test("a side-channel path that cannot be cleared is a hard exit (exit 1, no run)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "report-out-"));
    const blocked = join(outDir, "report.json");
    mkdirSync(blocked);
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, prContext: PR_CONTEXT });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath, "--report-out", blocked]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("cannot remove stale side-channel file");
    expect(runInputs).toHaveLength(0);
  });

  test("input without prContext stays byte-identical: no `prContext` key reaches the runtime", async () => {
    fakeEnvelope = ENVELOPE;
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code } = await runCli(["--level", "quick", "--input", inputPath]);
    expect(code).toBe(0);
    expect(Object.keys(runInputs[0]!)).not.toContain("prContext");
  });

  test("--report-out write failure → structured warn, envelope still printed, exit 0", async () => {
    fakeEnvelope = ENVELOPE;
    fakeReport = REPORT_DOC;
    const outDir = mkdtempSync(join(tmpdir(), "report-out-"));
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, prContext: PR_CONTEXT });
    const { code, stdout, stderr } = await runCli([
      "--level",
      "quick",
      "--input",
      inputPath,
      "--report-out",
      join(outDir, "missing", "report.json"),
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    const warn = stderr
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === "report_write_failed");
    expect(warn?.reason).toContain("ENOENT");
  });

  test("a malformed prContext is a usage-level input error (exit 1, no run)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, prContext: { prBody: 7, issues: [] } });
    const { code, stdout } = await runCli(["--level", "quick", "--input", inputPath]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
  });
});

describe("runner entry — transported credential pool", () => {
  function storedPool(provider: string) {
    const storage = runStores.at(-1) as AuthStorage;
    return storage.credentials.list(provider).map((row) => row.credential);
  }

  test("the payload's app-provider pool lands as login api_key rows under the provider id the key names", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ ark: [sk("pool-one"), sk("pool-two")] }),
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    const input = runInputs[0]!;
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    const rows = storedPool("ark");
    expect(rows).toEqual([
      { type: "api_key", key: sk("pool-one"), source: "login" },
      { type: "api_key", key: sk("pool-two"), source: "login" },
    ]);
    const log = JSON.parse(stderr) as { event: string; provider: string; pool_size: number };
    expect(log).toEqual({ event: "credential_pool", provider: "ark", pool_size: 2 });
    expect(stderr).not.toContain(sk("pool-one"));
    expect(stderr).not.toContain(sk("pool-two"));
    expect(await (runStores.at(-1) as AuthStorage).keys.get("ark")).toBe(sk("pool-one"));
  });

  test("custom providers pool under their own id, in payload order", async () => {
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      worktreePath: "/workspace/clone",
      customProviders: [
        {
          provider_id: "my-provider",
          base_url: "https://my-provider.example.com/v1",
          api: "openai-completions",
          model_ids: ["my-model-1"],
        },
      ],
    });
    const { code } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ "my-provider": [sk("custom-one"), sk("custom-two")] }),
    );

    expect(code).toBe(0);
    const input = runInputs[0]!;
    expect(storedPool("my-provider")).toEqual([
      { type: "api_key", key: sk("custom-one"), source: "login" },
      { type: "api_key", key: sk("custom-two"), source: "login" },
    ]);
  });

  test("readCredentialStdin stops at a complete payload without waiting for EOF", async () => {
    async function* neverEnds(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"version":1,');
      yield new TextEncoder().encode('"pools":{}}');
      await new Promise(() => {});
    }
    await expect(readCredentialStdin(neverEnds(), 50)).resolves.toBe('{"version":1,"pools":{}}');
  });

  test("readCredentialStdin does not end early on a brace inside a string", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"version":1,"pools":{"a":["k}1"]}}');
    }
    await expect(readCredentialStdin(chunks(), 50)).resolves.toBe('{"version":1,"pools":{"a":["k}1"]}}');
  });

  test("readCredentialStdin bounds a pipe that delivers neither a payload nor EOF", async () => {
    async function* stalls(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"version":1,"pools":');
      await new Promise(() => {});
    }
    await expect(readCredentialStdin(stalls(), 20)).rejects.toThrow(/neither a complete payload nor EOF within 20ms/);
  });

  test("readCredentialStdin treats an empty stream as the keyless run shape", async () => {
    async function* empty(): AsyncGenerator<Uint8Array> {}
    await expect(readCredentialStdin(empty(), 50)).resolves.toBe("");
  });

  test("a stdin reader that never settles → the bound names the transport instead of stalling", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const code = await main(
        ["--level", "quick", "--input", inputPath],
        fakeRuntime,
        () => Promise.reject(new Error("credential stdin delivered neither a complete payload nor EOF")),
      );
      expect(code).toBe(1);
      expect(logs.join("")).toBe("");
      expect(errors.join("")).toContain("credential stdin delivered neither a complete payload nor EOF");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  test("an unparseable payload → fail closed (exit 1, no run, nothing written)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCliWithoutStore(
      ["--level", "quick", "--input", inputPath],
      '{"version":1,"pools":{"ark":',
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("credential pool rejected: the credential payload is not valid JSON");
  });

  test("an unsupported payload version → fail closed before anything is written", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCliWithoutStore(
      ["--level", "quick", "--input", inputPath],
      '{"version":2,"pools":{"ark":["k"]}}',
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("the credential payload version must be 1");
  });

  test("a payload with no pools object → fail closed", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCliWithoutStore(
      ["--level", "quick", "--input", inputPath],
      '{"version":1}',
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain('must carry a "pools" object');
  });

  test("an empty pool array → fail closed (never a partial pool)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCliWithoutStore(
      ["--level", "quick", "--input", inputPath],
      '{"version":1,"pools":{"ark":[]}}',
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("credential pool ark is empty");
  });

  test("a non-string entry → fail closed, never echoing the entry", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCliWithoutStore(
      ["--level", "quick", "--input", inputPath],
      `{"version":1,"pools":{"ark":["${sk("leaky")}",7]}}`,
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("credential pool ark entry 1 must be a non-empty string");
    expect(stderr).not.toContain(sk("leaky"));
  });

  test("an absent payload (empty stdin) → no credential rows written (keyless run shape)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath], "");

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const input = runInputs[0]!;
    expect(existsSync(join(preservedAgentDir(), "agent.db"))).toBe(false);
  });

  test("a built-in catalog provider pool resolves under its own provider id — no declared identity needed", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ openai: [sk("builtin-one")] }),
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    const input = runInputs[0]!;
    expect(storedPool("openai")).toEqual([
      { type: "api_key", key: sk("builtin-one"), source: "login" },
    ]);
    const log = JSON.parse(stderr) as { event: string; provider: string; pool_size: number };
    expect(log).toEqual({ event: "credential_pool", provider: "openai", pool_size: 1 });
    expect(stderr).not.toContain(sk("builtin-one"));
    expect(await (runStores.at(-1) as AuthStorage).keys.get("openai")).toBe(sk("builtin-one"));
    expect(readFileSync(join(preservedAgentDir(), "models.yml"), "utf8")).toBe("providers:\n");
  });

  test("a hyphenated provider id keeps its id verbatim (no prefix inversion) beside another pool", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({
        ark: [sk("ark-one")],
        "azure-openai": [sk("builtin-one"), sk("builtin-two")],
      }),
    );

    expect(code).toBe(0);
    expect(storedPool("azure-openai")).toEqual([
      { type: "api_key", key: sk("builtin-one"), source: "login" },
      { type: "api_key", key: sk("builtin-two"), source: "login" },
    ]);
    expect(storedPool("ark")).toEqual([
      { type: "api_key", key: sk("ark-one"), source: "login" },
    ]);
  });

  test("MSTAR_POOL_* env names are INERT — the retired channel is never a credential source", async () => {
    process.env.MSTAR_POOL_OPENAI_COUNT = "2";
    process.env.MSTAR_POOL_OPENAI_01 = sk("retired-env-key");
    process.env.MSTAR_POOL_ARK_01 = sk("retired-env-key");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    const input = runInputs[0]!;
    expect(existsSync(join(preservedAgentDir(), "agent.db"))).toBe(false);
    expect(stderr).not.toContain(sk("retired-env-key"));
  });

  test("a `!`-prefixed entry → fail closed BEFORE any write, and the value never reaches the diagnostic", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCliWithoutStore(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ ark: [sk("plain-one"), "!touch /tmp/pwned"] }),
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("credential pool ark entry 1 must not start with !");
    expect(stderr).not.toContain("pwned");
    expect(stderr).not.toContain(sk("plain-one"));
  });

  test("the sink the guard closes: the SDK's installed resolver runs a stored `!` value as a shell command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-resolver-sink-"));
    const marker = join(dir, "PWNED");
    writeFileSync(join(dir, "models.yml"), "providers: {}\n");
    const dbPath = join(dir, "agent.db");
    try {
      const seeded = await AuthStorage.create(dbPath);
      await seeded.credentials.set("openai", [
        { type: "api_key" as const, key: `!touch ${marker}`, source: "login" as const },
      ]);
      seeded.close();

      const storage = await AuthStorage.create(dbPath);
      await storage.credentials.reload();
      const registry = new ModelRegistry(storage, join(dir, "models.yml"));
      expect(await registry.getApiKeyForProvider("openai")).toBeUndefined();
      expect(existsSync(marker)).toBe(true);
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("over a REAL stdin pipe: the payload is read, and an unparseable one fails closed", () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const proc = Bun.spawnSync(["bun", "run", "packages/runner/src/runner.ts", "--level", "quick", "--input", inputPath], {
      stdin: new Blob([`{"version":1,"pools":{"ark":["${sk("leaky")}"}`]),
      stdout: "pipe",
      stderr: "pipe",
      cwd: join(import.meta.dir, "..", ".."),
    });
    const stderr = proc.stderr.toString();

    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toBe("");
    expect(stderr).toContain("credential pool rejected: the credential payload is not valid JSON");
    expect(stderr).not.toContain(sk("leaky"));
  });

  test("an INTERACTIVE stdin (no pipe) resolves to the keyless run instead of blocking on EOF", async () => {
    // why: The documented local path — `bun run packages/runner/src/runner.ts --level …
    // --input …` from a terminal — has no pipe: the pre-fix `Bun.stdin.text()`
    // waited for an EOF a TTY never sends, so even a keyless run hung until
    // Ctrl-D. The real entry runs here inside a real pty, with the runtime
    // injected so no session starts.
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const run = await runRealStdinInPty(inputPath);

    expect(run.ended).toBe(true);
    expect(run.code).toBe(0);
    expect(run.isTTY).toBe(true);
    expect(run.output).toContain('"schema":"mstar.review/v1"');
    expect(run.dir).toMatch(/^\/tmp\/omp-agent-/);
    expect(run.dirAfterRun).toBe(false);
  });

  test("no credential database is ever created, and the per-run directory is removed — success and failure", async () => {
    const payload = encodeCredentialPayload({ ark: [sk("cleanup-key")] });

    const okInput = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const ok = await runCli(["--level", "quick", "--input", okInput], payload);
    expect(ok.code).toBe(0);
    expect(inFlight?.hadStore).toBe(false);
    expect(existsSync(inFlight!.dir)).toBe(false);

    runtimeError = new Error("seat 0 failed: provider boom");
    const failInput = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const failed = await runCli(["--level", "quick", "--input", failInput], payload);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("provider boom");
    expect(inFlight?.hadStore).toBe(false);
    expect(existsSync(inFlight!.dir)).toBe(false);

    // why: ...and the ONE store definition both callers share is itself file-free.
    // Both the runner and `scripts/live-smoke-evidence.ts` construct through
    // `createInMemoryAuthStorage`, so proving it on the helper covers every
    // caller — including the direct script entry that has no runner around it.
    // A CHILD process is required: the SDK resolves its agent dir at module
    // load, so redirecting it here is the only way a disk-backed store would
    // reveal itself as `<agentDir>/agent.db`.
    const childAgentDir = mkdtempSync(join(tmpdir(), "helper-agentdir-"));
    try {
      const probe = Bun.spawnSync(["bun", "-e", HELPER_STORE_PROBE.replace("__KEY__", sk("helper-probe"))], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env, PI_CODING_AGENT_DIR: childAgentDir },
      });
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString()).toContain(`KEY=${sk("helper-probe")}`);
      expect(readdirSync(childAgentDir).filter((name) => name.startsWith("agent.db"))).toEqual([]);
    } finally {
      rmSync(childAgentDir, { recursive: true, force: true });
    }
  });

  test("the shared store definition asks for the in-memory database by NAME — no file path can pass", async () => {
    // why: The finding this closes: every assertion above watches a DIRECTORY, but
    // `AuthStorage.create(dbPath)` takes an explicit path and hands it straight
    // to `SqliteAuthCredentialStore.open(dbPath)`. `PI_CODING_AGENT_DIR` only
    // redirects the SDK's own default, so a helper literal of `"agent.db"`
    // would drop a credential-bearing file in the CHILD's cwd
    // yet still resolve the key and leave `<agentDir>` empty — the whole
    // regression above would stay green. Only the argument proves it, so
    // observe it: a spy that records every path the static factory receives and
    // then delegates to the real implementation (the store it returns must
    // still work, or the assertion would be watching a fake). The spy must
    // reach the SAME module copy the runner imports: a nested
    // packages/runner/node_modules install resolves the SDK to its own
    // instance, so a spy on this file's import would watch a class the helper
    // never calls. Resolve the specifier from the runner's own source dir.
    const runnerSdk = (await import(
      Bun.resolveSync("@oh-my-pi/pi-coding-agent", join(import.meta.dir, "..", "..", "packages", "runner", "src"))
    )) as typeof import("@oh-my-pi/pi-coding-agent");
    const realCreate = runnerSdk.AuthStorage.create;
    const paths: string[] = [];
    runnerSdk.AuthStorage.create = async (dbPath: string) => {
      paths.push(dbPath);
      return realCreate(dbPath);
    };
    const dir = mkdtempSync(join(tmpdir(), "store-arg-cwd-"));
    const origin = process.cwd();
    process.chdir(dir);
    try {
      const storage = await createInMemoryAuthStorage();
      try {
        await storage.credentials.set("probe", [
          { type: "api_key", key: sk("probe-key"), source: "login" },
        ]);
        expect(await storage.keys.get("probe")).toBe(sk("probe-key"));
        expect(paths).toEqual([":memory:"]);
      } finally {
        storage.close();
      }
    } finally {
      runnerSdk.AuthStorage.create = realCreate;
      process.chdir(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with a real payload the pool is loaded and readable from memory, yet NO database exists anywhere the session's tools scan", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stderr } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ ark: [sk("mem-only-key")] }),
    );
    expect(code).toBe(0);

    const storage = runStores.at(-1) as AuthStorage;
    expect(storage.credentials.list("ark").map((row) => row.credential)).toEqual([
      { type: "api_key", key: sk("mem-only-key"), source: "login" },
    ]);
    expect(await storage.keys.get("ark")).toBe(sk("mem-only-key"));
    expect(stderr).not.toContain(sk("mem-only-key"));

    expect(existsSync(join(preservedAgentDir(), "agent.db"))).toBe(false);
    expect(readdirSync(preservedAgentDir())).toContain("models.yml");
  });

  test("no per-run directory under /tmp/omp-agent-* ever carries a credential database", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code } = await runCli(
      ["--level", "quick", "--input", inputPath],
      encodeCredentialPayload({ ark: [sk("scan-key")] }),
    );
    expect(code).toBe(0);
    expect(inFlight?.hadStore).toBe(false);
    expect(agentDirs().filter((dir) => existsSync(join(dir, "agent.db")))).toEqual([]);
  });
});
