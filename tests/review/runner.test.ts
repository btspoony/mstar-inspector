/**
 * Unit tests for the container review-runner entry
 * (required capabilityHosts, always synthesize).
 *
 * The AgentRuntime is INJECTED (main(argv, runtime)) so the tests are
 * deterministic. mock.module on the shared "../../src/review/runtime-omp"
 * specifier is deliberately avoided: bun's module-mock registry is
 * process-global and leaks across test files in one `bun test` run, with a
 * filesystem-dependent execution order — on Linux CI (bun 1.4.0) this stub
 * leaked into runtime-omp.test.ts and shadowed the module under test there.
 * Contract under test:
 *   - `--level <quick|default|deep> --input <json-file>` → exit 0 and stdout is
 *     ONLY the mstar.review/v1 envelope JSON (no envelope wrapper, no logs);
 *   - usage errors (missing flags, unknown level) → exit 2, stdout empty;
 *   - unreadable/malformed input file → exit 1, stdout empty;
 *   - runtime failure → exit 1, stdout empty, stderr diagnostic;
 * - `capabilityHosts` is REQUIRED and shape-guarded — the
 *     runner ALWAYS synthesizes a COMPLETE per-review models.yml
 *     (/tmp/omp-agent-<uuid>/models.yml) from the capability hosts (there is
 *     no baked in-image base to fall back to) and rides that directory as the
 *     REQUIRED `agentDir` in the runtime input on EVERY run;
 *   - `worktreePath` defaults to the process cwd; `reconFacts` defaults to [];
 *   - the OMP_REVIEW_MODEL chain flows into the runtime input;
 * - the optional `modelOverrides` map is shape-guarded and
 *     rides into the runtime input verbatim; absent = the legacy shape.
 * - the optional `customProviders` list (AL-23-1) is
 *     shape-guarded; merged INTO the capability-host base. The synthesized
 *     blocks pin NO scalar `apiKey` (a models.yml apiKey is a tier-2 config
 *     override that would suppress the stored pool) and authenticate via
 *     `auth: oauth`; absent or empty = the capability base alone
 *     (byte-identical zero-custom path).
 * - the credential pool: the runner writes the `MSTAR_POOL_*` env keys into
 *     `<agentDir>/agent.db` as `{type:"api_key", source:"login"}` rows before
 *     the runtime starts, under the MODELS.YML provider id (capability host id
 *     — resolved through its catalogProviderId — or the custom provider id),
 *     and fails the run closed when `_COUNT` disagrees with the `_01.._NN`
 *     values actually present, or when a populated prefix carries no `_COUNT`.
 * - the optional recheck channel (spec review-lifecycle
 *     §7.8): the input's `recheck` document is shape-guarded and forwarded
 *     verbatim; the optional `--recheck-out <path>` flag writes the runtime's
 *     recheck result only when one exists, before the envelope reaches
 *     stdout (a write failure = exit 1, no stdout); legacy input carries no
 *     `recheck` key and writes no file.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { MstarReviewV1 } from "@mstar-harness/engine";
import type { AgentRuntime, AgentRuntimeRunInput, CustomProviderDeclaration, ReviewRunResult } from "../../src/review/runtime";
import { getSandboxImage } from "../../src/contracts/sandbox-images";
import { capabilityHostsYaml } from "../../src/review/models-synthesis";
import { main } from "../../src/review/runner";
import { sk } from "../helpers/fake-secrets";

/** Envelope the fake runtime resolves with; overridden per test. */
let fakeEnvelope: Record<string, unknown> | undefined;
/** Recheck document the fake runtime resolves with (null = no result). */
let fakeRecheck: Record<string, unknown> | null = null;
/** Error the fake runtime rejects with; takes precedence when set. */
let runtimeError: Error | undefined;
/** Captured runReview inputs. */
const runInputs: unknown[] = [];

/** Injected AgentRuntime double: records inputs, then rejects or resolves. */
const fakeRuntime: AgentRuntime = {
  runReview: mock(async (input: AgentRuntimeRunInput): Promise<ReviewRunResult> => {
    runInputs.push(input);
    if (runtimeError) throw runtimeError;
    return { envelope: fakeEnvelope as MstarReviewV1, recheck: fakeRecheck as ReviewRunResult["recheck"] };
  }),
};

const ENVELOPE = {
  schema: "mstar.review/v1",
  verdict: "blocked",
  summary_md: "summary",
  findings: [],
};

/** The omp capability hosts, exactly as the consumer resolves them. */
const OMP_HOSTS = getSandboxImage("omp")!.hosts;
/** The base those hosts generate — the zero-custom models.yml equivalence lock. */
const OMP_BASE_YAML = capabilityHostsYaml(OMP_HOSTS);

/** Write a JSON input file into a fresh temp dir and return its path. */
function writeInput(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-input-"));
  const path = join(dir, "input.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

/** Capture console.log / console.error while a runner main() call runs. */
async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const code = await main(argv, fakeRuntime);
    return { code, stdout: logs.join("\n"), stderr: errors.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** Clean up the synthesized /tmp/omp-agent-<uuid> dir a run produced. */
function cleanupAgentDirs(): void {
  for (const input of runInputs) {
    const agentDir = (input as { agentDir?: string }).agentDir;
    if (typeof agentDir === "string") rmSync(agentDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  fakeEnvelope = ENVELOPE;
  fakeRecheck = null;
  runtimeError = undefined;
  cleanupAgentDirs();
  runInputs.length = 0;
  delete process.env.OMP_REVIEW_MODEL;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("MSTAR_POOL_")) delete process.env[name];
  }
});

/** A shape-valid recheck INPUT document (the runner guards shape only). */
const RECHECK_INPUT_DOC = {
  schema: "mstar.recheck-input/v1",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  targets: [],
  evidence: [],
  discussion: { items: [], issueCoverage: "complete", issueDigest: "d", capturedMs: 1, threads: [] },
};

/** The valid recheck OUTPUT document the fake runtime returns when set. */
const RECHECK_RESULT_DOC = {
  schema: "mstar.recheck/v1",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  results: [],
};

describe("runner entry (src/review/runner.ts)", () => {
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
    const input = runInputs[0] as Record<string, unknown>;
    expect(input.level).toBe("quick");
    expect(input.worktreePath).toBe("/workspace/clone");
    expect(input.reconFacts).toEqual(["acme/widgets#7"]);
    expect(input.modelSelectors).toEqual([]);
    // every run rides a synthesized per-review models dir.
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
  });

  test("defaults: worktreePath = cwd, reconFacts = [], model chain from env parsing", async () => {
    // Real parseModelSelectors wiring: the env chain flows verbatim into the
    // runtime input (comma-separated, trimmed).
    process.env.OMP_REVIEW_MODEL = "ark-plan/deepseek-v4-flash, ark-plan/backup";
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS });
    const { code } = await runCli(["--level", "default", "--input", inputPath]);

    expect(code).toBe(0);
    const input = runInputs[0] as Record<string, unknown>;
    expect(input.level).toBe("default");
    expect(input.worktreePath).toBe(process.cwd());
    expect(input.reconFacts).toEqual([]);
    expect(input.modelSelectors).toEqual(["ark-plan/deepseek-v4-flash", "ark-plan/backup"]);
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
      // capabilityHosts is REQUIRED and shape-guarded (QC fix wave 1:
      // a non-empty base — there is no baked in-image models.yml to fall back to).
      {},
      { capabilityHosts: "not-an-array" },
      { capabilityHosts: [] },
      { capabilityHosts: [42] },
      { capabilityHosts: [{}] },
      { capabilityHosts: [{ id: 42, catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey" }] },
      { capabilityHosts: [{ id: "h", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey", models: "nope" }] },
      { capabilityHosts: [{ id: "h", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey", models: [42] }] },
      { capabilityHosts: [{ id: "h", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY", baseUrl: "u", api: "a", auth: "apiKey", models: [{ id: "m", name: "M", reasoning: "yes", input: ["text"], contextWindow: 1, maxTokens: 2 }] }] },
      { worktreePath: 42 },
      { reconFacts: "not-an-array" },
      { reconFacts: [1, 2] },
      // shape-only guard on the optional overrides map.
      { modelOverrides: "not-an-object" },
      { modelOverrides: [] },
      { modelOverrides: null },
      { modelOverrides: { "mstar-review-seat": 42 } },
      { modelOverrides: { "code-reviewer": { nested: "object" } } },
      // shape-only guard on the optional customProviders list.
      { customProviders: "not-an-array" },
      { customProviders: [42] },
      { customProviders: [{}] },
      { customProviders: [{ provider_id: 42, base_url: "u", api: "a", model_ids: ["m"] }] },
      { customProviders: [{ provider_id: "p", base_url: "u", api: "a", model_ids: "nope" }] },
      { customProviders: [{ provider_id: "p", base_url: "u", api: "a", model_ids: [1, 2] }] },
      // shape-only guard on the optional recheck document.
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

  test("non-finite model numbers → exit 1 (QC fix wave 1: typeof alone admits ±Infinity)", async () => {
    // JSON.stringify cannot carry NaN/±Infinity, so the non-finite path is
    // exercised through raw JSON text: JSON.parse("1e999") === Infinity.
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
    // Shape-only validation: unknown agent names and `:thinking` suffixes are
    // NOT the runner's business — they pass through untouched (L3).
    const overrides = {
      "mstar-review-seat": "ark-plan/deepseek-v4-flash:high",
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
    const input = runInputs[0] as Record<string, unknown>;
    expect(input.modelOverrides).toEqual(overrides);
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
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

  test("ALWAYS synthesizes: a zero-custom run rides an agentDir whose models.yml is the capability base alone", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(runInputs).toHaveLength(1);
    const input = runInputs[0] as Record<string, unknown>;
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    // The zero-custom equivalence lock: the file is EXACTLY the capability
    // base (ark-plan included) — the poolized base, byte-for-byte.
    const yaml = readFileSync(join(input.agentDir as string, "models.yml"), "utf8");
    expect(yaml).toBe(OMP_BASE_YAML);
    expect(yaml).toContain("ark-plan:");
  });

  test("customProviders: merge into the capability base and ride agentDir into the runtime input", async () => {
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
    const input = runInputs[0] as Record<string, unknown>;
    // The declarations themselves do NOT ride the runtime input — only the
    // synthesized per-review directory (the keys ride the exec env).
    expect(Object.keys(input)).not.toContain("customProviders");
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    expect(input.worktreePath).toBe("/workspace/clone");
    const yaml = readFileSync(join(input.agentDir as string, "models.yml"), "utf8");
    // Capability base + custom merge, zero apiKey pins, zero key literals.
    expect(yaml).toContain("ark-plan:");
    expect(yaml).not.toMatch(/^\s*apiKey:/m);
    expect(yaml).toContain('"my-provider":');
    expect(yaml).toContain("auth: oauth");
    expect(yaml).not.toContain(sk("live"));
    rmSync(input.agentDir as string, { recursive: true, force: true });
  });

  test("customProviders colliding with a capability host id: skipped with a structured stderr warn (id + count, no keys)", async () => {
    fakeEnvelope = ENVELOPE;
    const decls: CustomProviderDeclaration[] = [
      {
        provider_id: "ark-plan", // collides with the omp capability host
        base_url: "https://evil.example.com/",
        api: "openai-completions",
        model_ids: ["m1"],
      },
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
    // Structured warn on stderr: event + id + count; zero key material.
    const warn = JSON.parse(stderr) as { event: string; provider_id: string; count: number };
    expect(warn).toEqual({ event: "custom_provider_collision", provider_id: "ark-plan", count: 1 });
    expect(stderr).not.toContain("sk-");
    // The synthesized file keeps the CAPABILITY ark-plan block (capability/base
    // wins) and appends the non-colliding custom provider.
    const input = runInputs[0] as Record<string, unknown>;
    const yaml = readFileSync(join(input.agentDir as string, "models.yml"), "utf8");
    expect(yaml).toContain("baseUrl: https://ark.cn-beijing.volces.com/api/plan");
    expect(yaml).not.toContain("https://evil.example.com/");
    expect(yaml).toContain('"my-provider":');
    rmSync(input.agentDir as string, { recursive: true, force: true });
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
    // The recheck document is the FILE, byte-written JSON; stdout never carries it.
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(RECHECK_RESULT_DOC);
    // The typed recheck input rides into the runtime input verbatim.
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

  test("null recheck result → no file created at the --recheck-out path", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = null;
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const outPath = join(outDir, "recheck.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
    const { code } = await runCli(["--level", "quick", "--input", inputPath, "--recheck-out", outPath]);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(false);
  });

  test("legacy input (no recheck field) → runtime input carries no recheck key, no file written", async () => {
    fakeEnvelope = ENVELOPE;
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const outPath = join(outDir, "recheck.json");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code } = await runCli(["--level", "quick", "--input", inputPath, "--recheck-out", outPath]);

    expect(code).toBe(0);
    expect(Object.keys(runInputs[0] as Record<string, unknown>)).not.toContain("recheck");
    expect(existsSync(outPath)).toBe(false);
  });

  test("--recheck-out write failure → exit 1, stdout empty, stderr diagnostic", async () => {
    fakeEnvelope = ENVELOPE;
    fakeRecheck = RECHECK_RESULT_DOC;
    // A directory path makes writeFileSync throw (EISDIR) — a genuine I-O
    // failure must not masquerade as success (exit codes unchanged).
    const outDir = mkdtempSync(join(tmpdir(), "recheck-out-"));
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, recheck: RECHECK_INPUT_DOC });
    const { code, stdout, stderr } = await runCli([
      "--level",
      "quick",
      "--input",
      inputPath,
      "--recheck-out",
      outDir,
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

describe("runner entry — transported credential pool", () => {
  /** Read the stored pool rows the run wrote into <agentDir>/agent.db. */
  async function storedPool(agentDir: string, provider: string) {
    const storage = await AuthStorage.create(join(agentDir, "agent.db"));
    try {
      // The SDK's discovery path loads the store on open (reload); the bare
      // factory caches nothing, so reload here mirrors it.
      await storage.reload();
      return storage.listStoredCredentials(provider).map((row) => row.credential);
    } finally {
      storage.close();
    }
  }

  test("MSTAR_POOL_<CATALOG_ID> keys land as login api_key rows under the capability host id", async () => {
    // The consumer pools a capability host under its catalogProviderId
    // (`ark-plan` ↔ `ark`); the session resolves credentials under the
    // models.yml provider id (`ark-plan`).
    process.env.MSTAR_POOL_ARK_COUNT = "2";
    process.env.MSTAR_POOL_ARK_01 = sk("pool-one");
    process.env.MSTAR_POOL_ARK_02 = sk("pool-two");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    const input = runInputs[0] as Record<string, unknown>;
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    const rows = await storedPool(input.agentDir as string, "ark-plan");
    expect(rows).toEqual([
      { type: "api_key", key: sk("pool-one"), source: "login" },
      { type: "api_key", key: sk("pool-two"), source: "login" },
    ]);
    // The log line carries provider + pool_size only — never a key value.
    const log = JSON.parse(stderr) as { event: string; provider: string; pool_size: number };
    expect(log).toEqual({ event: "credential_pool", provider: "ark-plan", pool_size: 2 });
    expect(stderr).not.toContain(sk("pool-one"));
    expect(stderr).not.toContain(sk("pool-two"));
    // The pool rows are live via the pinned auth storage, not just persisted.
    const storage = await AuthStorage.create(join(input.agentDir as string, "agent.db"));
    try {
      await storage.reload();
      expect(await storage.getApiKey("ark-plan")).toBe(sk("pool-one"));
    } finally {
      storage.close();
    }
  });

  test("custom providers pool under their own id, in env order", async () => {
    process.env.MSTAR_POOL_MY_PROVIDER_COUNT = "2";
    process.env.MSTAR_POOL_MY_PROVIDER_01 = sk("custom-one");
    process.env.MSTAR_POOL_MY_PROVIDER_02 = sk("custom-two");
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
    const { code } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    const input = runInputs[0] as Record<string, unknown>;
    expect(await storedPool(input.agentDir as string, "my-provider")).toEqual([
      { type: "api_key", key: sk("custom-one"), source: "login" },
      { type: "api_key", key: sk("custom-two"), source: "login" },
    ]);
  });

  test("COUNT greater than the values present → fail closed (exit 1, no run, named counts)", async () => {
    process.env.MSTAR_POOL_ARK_COUNT = "2";
    process.env.MSTAR_POOL_ARK_01 = sk("only-one");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("ark-plan");
    expect(stderr).toContain("MSTAR_POOL_ARK_02");
    expect(stderr).not.toContain(sk("only-one"));
  });

  test("COUNT less than the values present → fail closed (never a partial pool)", async () => {
    process.env.MSTAR_POOL_ARK_COUNT = "1";
    process.env.MSTAR_POOL_ARK_01 = sk("pool-one");
    process.env.MSTAR_POOL_ARK_02 = sk("pool-two");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("MSTAR_POOL_ARK_COUNT=1");
  });

  test("an empty pooled value → fail closed (exit 1, no run)", async () => {
    process.env.MSTAR_POOL_ARK_COUNT = "2";
    process.env.MSTAR_POOL_ARK_01 = sk("pool-one");
    process.env.MSTAR_POOL_ARK_02 = "";
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("MSTAR_POOL_ARK_02 is empty");
  });

  test("a non-positive COUNT → fail closed (exit 1, no run)", async () => {
    process.env.MSTAR_POOL_ARK_COUNT = "0";
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
  });

  test("no pool env → no credential rows written (keyless run shape)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const input = runInputs[0] as Record<string, unknown>;
    expect(existsSync(join(input.agentDir as string, "agent.db"))).toBe(false);
  });

  test("a built-in catalog provider pool lands under its own provider id — no capability/custom identity needed", async () => {
    // `openai` is an allowlisted built-in: the consumer pools its App key as
    // MSTAR_POOL_OPENAI_* and the session resolves it under the `openai`
    // provider id. Neither a capability host nor a custom declaration covers
    // that prefix, so the pool is discovered from the exec env itself.
    process.env.MSTAR_POOL_OPENAI_COUNT = "1";
    process.env.MSTAR_POOL_OPENAI_01 = sk("builtin-one");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    const input = runInputs[0] as Record<string, unknown>;
    expect(await storedPool(input.agentDir as string, "openai")).toEqual([
      { type: "api_key", key: sk("builtin-one"), source: "login" },
    ]);
    const log = JSON.parse(stderr) as { event: string; provider: string; pool_size: number };
    expect(log).toEqual({ event: "credential_pool", provider: "openai", pool_size: 1 });
    expect(stderr).not.toContain(sk("builtin-one"));
    const storage = await AuthStorage.create(join(input.agentDir as string, "agent.db"));
    try {
      await storage.reload();
      expect(await storage.getApiKey("openai")).toBe(sk("builtin-one"));
    } finally {
      storage.close();
    }
  });

  test("a hyphenated built-in provider pools several keys in env order alongside a capability host pool", async () => {
    // `azure-openai` → MSTAR_POOL_AZURE_OPENAI_*: the prefix inverts to the
    // catalog provider id (the only underscore source is a hyphen). The
    // capability host pool keeps its own catalog→host identity in the same run.
    process.env.MSTAR_POOL_ARK_COUNT = "1";
    process.env.MSTAR_POOL_ARK_01 = sk("ark-one");
    process.env.MSTAR_POOL_AZURE_OPENAI_COUNT = "2";
    process.env.MSTAR_POOL_AZURE_OPENAI_01 = sk("builtin-one");
    process.env.MSTAR_POOL_AZURE_OPENAI_02 = sk("builtin-two");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    const input = runInputs[0] as Record<string, unknown>;
    expect(await storedPool(input.agentDir as string, "azure-openai")).toEqual([
      { type: "api_key", key: sk("builtin-one"), source: "login" },
      { type: "api_key", key: sk("builtin-two"), source: "login" },
    ]);
    expect(await storedPool(input.agentDir as string, "ark-plan")).toEqual([
      { type: "api_key", key: sk("ark-one"), source: "login" },
    ]);
  });

  test("a malformed built-in pool → fail closed before the runtime runs (exit 1, no run)", async () => {
    process.env.MSTAR_POOL_OPENAI_COUNT = "2";
    process.env.MSTAR_POOL_OPENAI_01 = sk("only-one");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("openai");
    expect(stderr).toContain("MSTAR_POOL_OPENAI_02");
    expect(stderr).not.toContain(sk("only-one"));
  });

  test("a populated pool prefix with no COUNT → fail closed (exit 1, no run)", async () => {
    // The consumer's buildRunnerEnv always emits COUNT with the slots, so a
    // stray slot is not a shape it produces — but if one arrives, the session
    // would silently drop that key. Discovered from the env itself: no
    // capability host or custom declaration covers the `openai` prefix.
    process.env.MSTAR_POOL_OPENAI_01 = sk("orphan-one");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("MSTAR_POOL_OPENAI_COUNT");
    expect(stderr).not.toContain(sk("orphan-one"));
  });

  test("a stray slot under a DECLARED capability pool with no COUNT → fail closed", async () => {
    // The same boundary on the declared-identity path: `ark` is a capability
    // host's catalog provider id, so its prefix is enumerated even without a
    // COUNT name — the missing COUNT must still be rejected, never skipped.
    process.env.MSTAR_POOL_ARK_01 = sk("declared-orphan");
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stdout, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(runInputs).toHaveLength(0);
    expect(stderr).toContain("MSTAR_POOL_ARK_COUNT");
    expect(stderr).not.toContain(sk("declared-orphan"));
  });

  test("a custom id colliding with a capability host pools only once (base wins, same rule as the synthesis)", async () => {
    // `ark-plan` is a capability host id; the consumer pools the capability
    // host under catalog id `ark`. A custom declaration reusing the same id is
    // skipped by the synthesis, so its pool must not be loaded either — the
    // provider id would otherwise resolve credentials the file never declares.
    process.env.MSTAR_POOL_ARK_COUNT = "1";
    process.env.MSTAR_POOL_ARK_01 = sk("base-key");
    process.env.MSTAR_POOL_ARK_PLAN_COUNT = "1";
    process.env.MSTAR_POOL_ARK_PLAN_01 = sk("shadow-key");
    const inputPath = writeInput({
      capabilityHosts: OMP_HOSTS,
      worktreePath: "/workspace/clone",
      customProviders: [
        {
          provider_id: "ark-plan",
          base_url: "https://evil.example.com/",
          api: "openai-completions",
          model_ids: ["m1"],
        },
      ],
    });
    const { code } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    const input = runInputs[0] as Record<string, unknown>;
    expect(await storedPool(input.agentDir as string, "ark-plan")).toEqual([
      { type: "api_key", key: sk("base-key"), source: "login" },
    ]);
  });
});
