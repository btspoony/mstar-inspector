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
 */

import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  M0_HARNESS_PLUGIN_ROOT,
  PR_ADAPTER_PROMPT,
  REVIEW_TOOL_NAMES,
  runReviewSession,
} from "../../src/review/session";

function resetMocks(): void {
  createdOptions.length = 0;
  createdSessions.length = 0;
  nextSessionId = 1;
  promptError = undefined;
}

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

  test("loads the local mstar-harness plugin root and mentions mstar-audit", async () => {
    resetMocks();
    await runReviewSession("diff --git a/x b/x\n");

    // Plugin root resolves to the sibling ../mstar-harness (absolute equivalent).
    expect(M0_HARNESS_PLUGIN_ROOT.endsWith("mstar-harness")).toBe(true);
    expect(existsSync(join(M0_HARNESS_PLUGIN_ROOT, "skills", "mstar-audit"))).toBe(true);

    const options = createdOptions[0]!;
    expect(options.additionalExtensionPaths).toContain(M0_HARNESS_PLUGIN_ROOT);
    expect(options.skills.some((s) => s.name === "mstar-audit")).toBe(true);
    // The PR-adapter prompt pins the mstar-audit skill and the read-only contract.
    expect(options.appendSystemPrompt).toContain("mstar-audit");
    expect(PR_ADAPTER_PROMPT).toContain("READ-ONLY");
    expect(PR_ADAPTER_PROMPT).toContain("Never write to any plan directory");
    expect(PR_ADAPTER_PROMPT).toContain("never post anything to GitHub");
  });

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
