/**
 * Unit tests for the omp review session (plan 02 Task 2).
 *
 * The @oh-my-pi/pi-coding-agent SDK boundary is mocked; these tests pin the
 * contract the real SDK must satisfy (verified against dist/types of
 * 18.0.4):
 *   - createAgentSession(options) -> { session }
 *   - SessionManager.inMemory(cwd?) — in-memory session manager
 *   - options.restrictToolNames === true with toolNames ⊆ read/grep/glob
 *   - options.additionalExtensionPaths points at the local mstar-harness root
 *   - options.skills includes the mstar-audit skill
 *   - options.settings is an isolated in-memory Settings with fetch.enabled=false
 *   - session.dispose() called exactly once on success and on error
 *   - two runReviewSession calls create two distinct sessions
 *
 * The plugin root is environment-independent: ./plugin-root-fixture creates a
 * temp fixture root and injects it via $HARNESS_PLUGIN_ROOT before this
 * file's imports of src/review/session are evaluated, so no test depends on
 * the machine-absolute default root existing.
 */

import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import "./plugin-root-fixture";
import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";

/** Shape of the mocked AgentSession returned by the fake createAgentSession. */
interface MockSession {
  id: number;
  prompt: (text: string) => Promise<boolean>;
  getLastAssistantMessage: () => { role: string; content: Array<{ type: string; text?: string }> } | undefined;
  dispose: () => Promise<void>;
}

/** Shape of the createAgentSession options the implementation must pass. */
interface MockCreateOptions {
  cwd: string;
  sessionManager: { kind: string; cwd?: string };
  restrictToolNames: boolean;
  toolNames: string[];
  disableExtensionDiscovery: boolean;
  additionalExtensionPaths: string[];
  skills: Array<{ name: string }>;
  appendSystemPrompt: string;
  modelPattern: string;
  enableMCP: boolean;
  enableLsp: boolean;
  requireYieldTool: boolean;
  autoApprove: boolean;
  /** Isolated in-memory settings the implementation must pass through. */
  settings: { kind: string; overrides: Record<string, unknown>; get: (path: string) => unknown };
}

const createdOptions: MockCreateOptions[] = [];
const createdSessions: MockSession[] = [];
let nextSessionId = 1;
let promptError: Error | undefined;

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  createAgentSession: mock(async (options: MockCreateOptions) => {
    createdOptions.push(options);
    const session: MockSession = {
      id: nextSessionId++,
      prompt: mock(async () => true),
      getLastAssistantMessage: mock(() => ({
        role: "assistant",
        content: [{ type: "text", text: '{"verdict":"comment","summary_md":"ok","findings":[]}' }],
      })),
      dispose: mock(async () => {}),
    };
    if (promptError) {
      session.prompt = mock(async () => {
        throw promptError;
      });
    }
    createdSessions.push(session);
    return { session };
  }),
  SessionManager: {
    inMemory: mock((cwd?: string) => ({ kind: "in-memory", cwd })),
  },
  Settings: {
    isolated: mock((overrides: Record<string, unknown>) => ({
      kind: "isolated",
      overrides,
      get: (path: string) => overrides[path],
    })),
  },
  loadSkillsFromDir: mock(async () => ({
    skills: [
      {
        name: "mstar-audit",
        description: "Morning Star codebase audit",
        filePath: "/virtual/mstar-harness/skills/mstar-audit/SKILL.md",
        baseDir: "/virtual/mstar-harness/skills/mstar-audit",
        source: "mstar-harness",
      },
    ],
    warnings: [],
  })),
}));

import {
  buildReviewPrompt,
  buildSessionOptions,
  parseModelSelectors,
  PR_ADAPTER_PROMPT,
  REVIEW_TOOL_NAMES,
  resolveHarnessRoot,
  runReviewSession,
} from "../../src/review/session";

function resetMocks(): void {
  createdOptions.length = 0;
  createdSessions.length = 0;
  nextSessionId = 1;
  promptError = undefined;
}

/**
 * Default root the resolver would select without the env override — mirror of
 * resolveHarnessRoot in src/review/session.ts (sibling first, then the
 * plan-locked absolute path). Used only to decide whether the conditional
 * local check below runs; it never drives a hard failure.
 */
function defaultHarnessRoot(): string {
  const sibling = resolve(import.meta.dir, "../../../mstar-harness");
  return existsSync(sibling) ? sibling : "/Users/bibi/workspace/ai/mstar-harness";
}

const DEFAULT_HARNESS_ROOT = defaultHarnessRoot();

describe("runReviewSession", () => {
  test("creates an in-memory session with a read-only tool whitelist", async () => {
    resetMocks();
    const raw = await runReviewSession("diff --git a/x b/x\n");

    expect(raw).toContain('"verdict"');
    expect(createdOptions).toHaveLength(1);
    const options = createdOptions[0]!;
    // SessionManager.inMemory (verified API name) is used.
    expect(options.sessionManager.kind).toBe("in-memory");
    // restrictToolNames === true (verified option key) with the whitelist.
    expect(options.restrictToolNames).toBe(true);
    expect(options.toolNames).toEqual([...REVIEW_TOOL_NAMES]);
    expect(options.toolNames).toEqual(["read", "grep", "glob"]);
    // No write-capable or network tools are registered.
    for (const forbidden of ["write", "edit", "bash", "eval", "web_search", "github", "browser", "task", "hub"]) {
      expect(options.toolNames).not.toContain(forbidden);
    }
    // MCP and LSP are disabled so no ambient tool surface leaks in.
    expect(options.enableMCP).toBe(false);
    expect(options.enableLsp).toBe(false);
    // Settings are isolated per session (Settings.isolated): the read tool's
    // outbound URL fetch is structurally off, no user ~/.omp config inherited.
    expect(options.settings.kind).toBe("isolated");
    expect(options.settings.get("fetch.enabled")).toBe(false);
  });

  test("loads the injected mstar-harness plugin root and mentions mstar-audit", async () => {
    resetMocks();
    await runReviewSession("diff --git a/x b/x\n");

    // $HARNESS_PLUGIN_ROOT (set by ./plugin-root-fixture at module scope)
    // is the primary configuration surface: the resolved root IS the temp
    // fixture, never a machine-absolute path.
    expect(resolveHarnessRoot()).toBe(PLUGIN_ROOT_FIXTURE);
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit"))).toBe(true);

    // The fixture path is what reaches the session options.
    const options = createdOptions[0]!;
    expect(options.additionalExtensionPaths).toContain(PLUGIN_ROOT_FIXTURE);
    expect(options.skills.some((s) => s.name === "mstar-audit")).toBe(true);
    // The PR-adapter prompt pins the mstar-audit skill and the read-only contract.
    expect(options.appendSystemPrompt).toContain("mstar-audit");
    expect(PR_ADAPTER_PROMPT).toContain("READ-ONLY");
    expect(PR_ADAPTER_PROMPT).toContain("Never write to any plan directory");
    expect(PR_ADAPTER_PROMPT).toContain("never post anything to GitHub");
  });

  // Local M0 machine-layout check only: skipped when the default root is
  // absent (CI and any other machine). The unit contract is fully covered by
  // the fixture test above; a missing local root is a plan-level STOP, never
  // a hard unit-test failure.
  test.skipIf(!existsSync(join(DEFAULT_HARNESS_ROOT, "skills", "mstar-audit")))(
    "real mstar-harness default root is present on this machine (skipped when the default root is absent)",
    () => {
      expect(existsSync(join(DEFAULT_HARNESS_ROOT, "skills", "mstar-audit"))).toBe(true);
    },
  );

  test("disposes the session exactly once on success", async () => {
    resetMocks();
    await runReviewSession("diff --git a/x b/x\n");
    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  test("disposes the session exactly once when the prompt throws", async () => {
    resetMocks();
    promptError = new Error("provider boom");
    await expect(runReviewSession("diff --git a/x b/x\n")).rejects.toThrow("provider boom");
    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  test("creates a fresh session per call (no cross-request reuse)", async () => {
    resetMocks();
    await runReviewSession("diff one");
    await runReviewSession("diff two");
    expect(createdSessions).toHaveLength(2);
    expect(createdSessions[0]!.id).not.toBe(createdSessions[1]!.id);
    // Each call got its own in-memory SessionManager instance.
    expect(createdOptions[0]!.sessionManager).not.toBe(createdOptions[1]!.sessionManager);
  });
});

describe("buildSessionOptions", () => {
  test("pins the read-only whitelist and in-memory manager", () => {
    const options = buildSessionOptions({
      cwd: "/tmp/x",
      pluginRoot: "/tmp/harness",
      skills: [{ name: "mstar-audit", description: "d", filePath: "f", baseDir: "b", source: "s" }],
      modelPattern: "ark-plan/deepseek-v4-flash",
    });
    // The mocked SessionManager is a plain object; the real type is the SDK class.
    const managerShape = options.sessionManager as unknown as { kind?: string };
    expect(managerShape.kind).toBe("in-memory");
    expect(options.restrictToolNames).toBe(true);
    expect(options.toolNames).toEqual(["read", "grep", "glob"]);
    expect(options.additionalExtensionPaths).toEqual(["/tmp/harness"]);
    expect(options.disableExtensionDiscovery).toBe(true);
    expect(options.enableMCP).toBe(false);
    expect(options.enableLsp).toBe(false);
    expect(options.requireYieldTool).toBe(false);
    // The isolated settings object itself carries fetch.enabled=false.
    const settings = options.settings as unknown as { kind: string; get: (path: string) => unknown };
    expect(settings.kind).toBe("isolated");
    expect(settings.get("fetch.enabled")).toBe(false);
  });
});

describe("buildReviewPrompt", () => {
  test("injects the diff and demands the JSON contract", () => {
    const prompt = buildReviewPrompt("diff --git a/x b/x\n+line\n");
    expect(prompt).toContain("<diff>");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain("mstar-audit");
  });
});
describe("parseModelSelectors", () => {
  test("splits a comma-separated list, trims, and drops empty entries", () => {
    expect(
      parseModelSelectors("ark-plan/deepseek-v4-flash, openrouter/anthropic/claude-sonnet-4 ,, gemini/gemini-2.5-pro"),
    ).toEqual([
      "ark-plan/deepseek-v4-flash",
      "openrouter/anthropic/claude-sonnet-4",
      "gemini/gemini-2.5-pro",
    ]);
  });

  test("a single selector yields a one-element list", () => {
    expect(parseModelSelectors("ark-plan/deepseek-v4-flash")).toEqual(["ark-plan/deepseek-v4-flash"]);
  });

  test("undefined / empty / whitespace-only values yield an empty list", () => {
    expect(parseModelSelectors(undefined)).toEqual([]);
    expect(parseModelSelectors("")).toEqual([]);
    expect(parseModelSelectors("   ")).toEqual([]);
    expect(parseModelSelectors(",")).toEqual([]);
  });
});

describe("buildSessionOptions — retry fallback chain (T2)", () => {
  test("injects retry.modelFallback=true and the default chain into isolated settings", () => {
    const options = buildSessionOptions({
      cwd: "/tmp/x",
      pluginRoot: "/tmp/harness",
      skills: [{ name: "mstar-audit", description: "d", filePath: "f", baseDir: "b", source: "s" }],
      modelPattern: "ark-plan/deepseek-v4-flash",
      fallbackChain: ["ark-plan/deepseek-v4-flash", "openrouter/anthropic/claude-sonnet-4"],
    });
    const settings = options.settings as unknown as { kind: string; get: (path: string) => unknown };
    expect(settings.kind).toBe("isolated");
    expect(settings.get("fetch.enabled")).toBe(false);
    expect(settings.get("retry.modelFallback")).toBe(true);
    expect(settings.get("retry.fallbackChains")).toEqual({
      default: ["ark-plan/deepseek-v4-flash", "openrouter/anthropic/claude-sonnet-4"],
    });
  });

  test("an omitted fallbackChain injects an empty default chain (no fallback configured)", () => {
    const options = buildSessionOptions({
      cwd: "/tmp/x",
      pluginRoot: "/tmp/harness",
      skills: [{ name: "mstar-audit", description: "d", filePath: "f", baseDir: "b", source: "s" }],
      modelPattern: "ark-plan/deepseek-v4-flash",
    });
    const settings = options.settings as unknown as { kind: string; get: (path: string) => unknown };
    expect(settings.get("retry.modelFallback")).toBe(true);
    expect(settings.get("retry.fallbackChains")).toEqual({ default: [] });
  });
});

describe("runReviewSession — OMP_REVIEW_MODEL comma chain (T2)", () => {
  const OMP_REVIEW_MODEL = "OMP_REVIEW_MODEL";

  test("first selector becomes the modelPattern; the full list rides as the fallback chain", async () => {
    resetMocks();
    const prev = Bun.env[OMP_REVIEW_MODEL];
    Bun.env[OMP_REVIEW_MODEL] = "ark-plan/deepseek-v4-flash,openrouter/anthropic/claude-sonnet-4";
    try {
      await runReviewSession("diff --git a/x b/x\n");
    } finally {
      if (prev === undefined) delete Bun.env[OMP_REVIEW_MODEL];
      else Bun.env[OMP_REVIEW_MODEL] = prev;
    }
    const options = createdOptions[0]!;
    expect(options.modelPattern).toBe("ark-plan/deepseek-v4-flash");
    expect(options.settings.get("retry.modelFallback")).toBe(true);
    expect(options.settings.get("retry.fallbackChains")).toEqual({
      default: ["ark-plan/deepseek-v4-flash", "openrouter/anthropic/claude-sonnet-4"],
    });
  });

  test("unset OMP_REVIEW_MODEL falls back to the default model with an empty chain", async () => {
    resetMocks();
    const prev = Bun.env[OMP_REVIEW_MODEL];
    delete Bun.env[OMP_REVIEW_MODEL];
    try {
      await runReviewSession("diff --git a/x b/x\n");
    } finally {
      if (prev !== undefined) Bun.env[OMP_REVIEW_MODEL] = prev;
    }
    const options = createdOptions[0]!;
    expect(options.modelPattern).toBe("ark-plan/deepseek-v4-flash");
    expect(options.settings.get("retry.fallbackChains")).toEqual({ default: [] });
  });
});
