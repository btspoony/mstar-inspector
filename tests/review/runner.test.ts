/**
 * Unit tests for the container review-runner entry (plan 07 Task 2; plan 37
 * Task 2 — required capabilityHosts, always synthesize).
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
 *   - `capabilityHosts` (plan 37 Task 2) is REQUIRED and shape-guarded — the
 *     runner ALWAYS synthesizes a COMPLETE per-review models.yml
 *     (/tmp/omp-agent-<uuid>/models.yml) from the capability hosts (there is
 *     no baked in-image base to fall back to) and rides that directory as the
 *     REQUIRED `agentDir` in the runtime input on EVERY run;
 *   - `worktreePath` defaults to the process cwd; `reconFacts` defaults to [];
 *   - the OMP_REVIEW_MODEL chain flows into the runtime input;
 *   - the optional `modelOverrides` map (plan 17 B6) is shape-guarded and
 *     rides into the runtime input verbatim; absent = the legacy shape.
 *   - the optional `customProviders` list (plan 23 Task 3, AL-23-1) is
 *     shape-guarded; merged INTO the capability-host base with custom keys
 *     referenced as CUSTOM_<ID>_API_KEY env names (never literals); absent or
 *     empty = the capability base alone (byte-identical zero-custom path).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MstarReviewV1 } from "@mstar-harness/engine";
import type { AgentRuntime, AgentRuntimeRunInput, CustomProviderDeclaration } from "../../src/review/runtime";
import { getSandboxImage } from "../../src/contracts/sandbox-images";
import { capabilityHostsYaml } from "../../src/review/models-synthesis";
import { main } from "../../src/review/runner";

/** Envelope the fake runtime resolves with; overridden per test. */
let fakeEnvelope: Record<string, unknown> | undefined;
/** Error the fake runtime rejects with; takes precedence when set. */
let runtimeError: Error | undefined;
/** Captured runReview inputs. */
const runInputs: unknown[] = [];

/** Injected AgentRuntime double: records inputs, then rejects or resolves. */
const fakeRuntime: AgentRuntime = {
  runReview: mock(async (input: AgentRuntimeRunInput): Promise<MstarReviewV1> => {
    runInputs.push(input);
    if (runtimeError) throw runtimeError;
    return fakeEnvelope as MstarReviewV1;
  }),
};

const ENVELOPE = {
  schema: "mstar.review/v1",
  verdict: "blocked",
  summary_md: "summary",
  findings: [],
};

/** The omp capability hosts, exactly as the consumer resolves them (plan 37). */
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
  runtimeError = undefined;
  cleanupAgentDirs();
  runInputs.length = 0;
  delete process.env.OMP_REVIEW_MODEL;
});

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
    // plan 37: every run rides a synthesized per-review models dir.
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

  test("--level deep parses and reaches the runtime — forwarded into runReview (plan 09 T3)", async () => {
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
      // plan 37: capabilityHosts is REQUIRED and shape-guarded (QC fix wave 1:
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
      // Plan 17 B6: shape-only guard on the optional overrides map.
      { modelOverrides: "not-an-object" },
      { modelOverrides: [] },
      { modelOverrides: null },
      { modelOverrides: { "mstar-review-seat": 42 } },
      { modelOverrides: { "code-reviewer": { nested: "object" } } },
      // Plan 23 T3: shape-only guard on the optional customProviders list.
      { customProviders: "not-an-array" },
      { customProviders: [42] },
      { customProviders: [{}] },
      { customProviders: [{ provider_id: 42, base_url: "u", api: "a", model_ids: ["m"] }] },
      { customProviders: [{ provider_id: "p", base_url: "u", api: "a", model_ids: "nope" }] },
      { customProviders: [{ provider_id: "p", base_url: "u", api: "a", model_ids: [1, 2] }] },
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

  test("modelOverrides rides into the runtime input verbatim (plan 17 B6)", async () => {
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

  test("ALWAYS synthesizes: a zero-custom run rides an agentDir whose models.yml is the capability base alone (plan 37)", async () => {
    const inputPath = writeInput({ capabilityHosts: OMP_HOSTS, worktreePath: "/workspace/clone" });
    const { code, stderr } = await runCli(["--level", "quick", "--input", inputPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(runInputs).toHaveLength(1);
    const input = runInputs[0] as Record<string, unknown>;
    expect(input.agentDir).toMatch(/^\/tmp\/omp-agent-/);
    // The zero-custom equivalence lock: the file is EXACTLY the capability
    // base (ark-plan included) — byte-identical to the deleted baked body.
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
    // Capability base + custom merge, zero key literals.
    expect(yaml).toContain("ark-plan:");
    expect(yaml).toContain("apiKey: ARK_API_KEY");
    expect(yaml).toContain('"my-provider":');
    expect(yaml).toContain("apiKey: CUSTOM_MY_PROVIDER_API_KEY");
    expect(yaml).not.toContain("sk-live");
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
