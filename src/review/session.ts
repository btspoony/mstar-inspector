/**
 * omp review session (plan 02 Task 2).
 *
 * One-shot in-memory omp session with a read-only tool whitelist
 * (read / grep / glob), the local mstar-harness plugin loaded from
 * M0_HARNESS_PLUGIN_ROOT, and a PR-adapter system prompt that pins the §5.2
 * output contract. Each call creates a fresh session and disposes it in a
 * finally block; sessions are never reused across requests.
 *
 * Verified SDK surface (@oh-my-pi/pi-coding-agent 18.0.4, dist/types):
 *   - createAgentSession(options) -> Promise<CreateAgentSessionResult>  (sdk.d.ts)
 *   - SessionManager.inMemory(cwd?, storage?) -> SessionManager          (session/session-manager.d.ts)
 *   - CreateAgentSessionOptions.restrictToolNames: boolean              (sdk.d.ts)
 *   - CreateAgentSessionOptions.toolNames: string[]                    (sdk.d.ts)
 *   - CreateAgentSessionOptions.additionalExtensionPaths: string[]     (sdk.d.ts)
 *   - CreateAgentSessionOptions.skills: Skill[]                        (sdk.d.ts)
 *   - CreateAgentSessionOptions.settings: Settings                    (sdk.d.ts)
 *   - Settings.isolated(overrides) — in-memory settings, no user config (config/settings.d.ts)
 *   - loadSkillsFromDir({ dir, source }) -> Promise<LoadSkillsResult>  (extensibility/skills.d.ts)
 *   - AgentSession.prompt(text, options?) -> Promise<boolean>          (session/agent-session.d.ts)
 *   - AgentSession.getLastAssistantMessage() -> AssistantMessage | undefined
 *   - AgentSession.dispose(options?) -> Promise<void>
 *
 * Every session runs on Settings.isolated({ "fetch.enabled": false }): user
 * ~/.omp config is never inherited and the read tool's outbound URL fetch is
 * structurally off ("fetch.enabled" defaults true per settings-schema.d.ts;
 * tools/read.ts gates URL reads on session settings fetch.enabled).
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  loadSkillsFromDir,
  SessionManager,
  Settings,
  type AgentSession,
  type CreateAgentSessionOptions,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";

/** Plan-verified absolute fallback for the M0 plugin root (plan 02 Global Constraints). */
const ABSOLUTE_HARNESS_ROOT = "/Users/bibi/workspace/ai/mstar-harness";

/**
 * Resolve the local mstar-harness plugin root: prefer the sibling directory
 * `../mstar-harness` relative to this package (the main-repo layout), then the
 * plan-verified absolute path. M0 never installs from GitHub.
 */
function resolveHarnessRoot(): string {
  const sibling = resolve(import.meta.dir, "../../../mstar-harness");
  if (existsSync(sibling)) return sibling;
  return ABSOLUTE_HARNESS_ROOT;
}

/** Absolute path of the local mstar-harness plugin loaded into review sessions. */
export const M0_HARNESS_PLUGIN_ROOT = resolveHarnessRoot();

/** Read-only tool whitelist (plan 02 Global Constraints). */
export const REVIEW_TOOL_NAMES = ["read", "grep", "glob"] as const;

/** Default model selector; override with the OMP_REVIEW_MODEL env var. */
const DEFAULT_MODEL_PATTERN = "ark-plan/deepseek-v4-flash";

/**
 * PR-adapter system prompt. Three locked constraints (plan 02 Clarify #9):
 * read-only PR review; no {HARNESS_DIR} / SDD / process-state assumptions;
 * mandatory §5.2 JSON output. Wording is open; constraints are not.
 */
export const PR_ADAPTER_PROMPT = `You are a read-only pull-request review agent. You are given a unified diff and must produce a structured code review.

NON-NEGOTIABLE CONSTRAINTS:
1. READ-ONLY: You may only use the read, grep, and glob tools. You have no write, edit, bash, eval, or network tools. Never attempt to modify files, run commands, or access the network.
2. NO HARNESS STATE: Do not assume any {HARNESS_DIR}, plan directory, SDD directory, or process state exists. You are reviewing a standalone diff. Never write to any plan directory and never post anything to GitHub (no gh, no API calls, no review comments).
3. MANDATORY OUTPUT: Your final answer MUST be exactly one JSON object matching the schema below — no prose before or after it. You may use the mstar-audit skill (read-only codebase audit / PR review) to structure your analysis.

SCHEMA:
{
  "verdict": "comment" | "request_changes" | "approve",
  "summary_md": "markdown summary of the review",
  "findings": [
    {
      "severity": "critical" | "warning" | "suggestion" | "info",
      "category": "security" | "logic" | "style" | "perf" | "test" | "other",
      "file_path": "string or null",
      "line_start": "number or null",
      "line_end": "number or null",
      "title": "short finding title",
      "body": "detailed markdown explanation",
      "fingerprint_hint": "optional stable string for cross-PR dedup"
    }
  ]
}

An empty findings array with a valid verdict is acceptable.`;

/** Build the user prompt that injects the unified diff into the session. */
export function buildReviewPrompt(diffText: string): string {
  return `Review the following pull request diff. Use the mstar-audit skill's PR-review approach (read-only analysis). Then output the review as the single JSON object described in your instructions.

<diff>
${diffText}
</diff>`;
}

/**
 * Load every skill from the local mstar-harness plugin root and require the
 * mstar-audit judgment skill to be present (plan 02 Global Constraints).
 */
export async function loadHarnessSkills(pluginRoot: string): Promise<Skill[]> {
  const { skills, warnings } = await loadSkillsFromDir({
    dir: join(pluginRoot, "skills"),
    source: "mstar-harness",
  });
  if (!skills.some((skill) => skill.name === "mstar-audit")) {
    const detail = warnings.map((w) => w.message).join("; ");
    throw new Error(
      `mstar-harness plugin at ${pluginRoot} does not expose the mstar-audit skill` +
        (detail ? ` (warnings: ${detail})` : ""),
    );
  }
  return skills;
}

export interface ReviewSessionOptions {
  /** Working directory for the session (a throwaway temp dir). */
  cwd: string;
  /** Absolute path of the local mstar-harness plugin root. */
  pluginRoot: string;
  /** Skills to load into the session (from the plugin root). */
  skills: Skill[];
  /** Model selector, e.g. "ark-plan/deepseek-v4-flash". */
  modelPattern: string;
}

/**
 * Build the createAgentSession options: in-memory session, read-only tool
 * whitelist, local plugin root, explicit skills, PR-adapter prompt, and
 * isolated settings with outbound fetch disabled.
 */
export function buildSessionOptions(opts: ReviewSessionOptions): CreateAgentSessionOptions {
  return {
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(opts.cwd),
    // Isolated in-memory settings per session: no user ~/.omp config and no
    // outbound URL fetch (read tool gates URL reads on fetch.enabled).
    settings: Settings.isolated({ "fetch.enabled": false }),
    restrictToolNames: true,
    toolNames: [...REVIEW_TOOL_NAMES],
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [opts.pluginRoot],
    skills: opts.skills,
    appendSystemPrompt: PR_ADAPTER_PROMPT,
    modelPattern: opts.modelPattern,
    enableMCP: false,
    enableLsp: false,
    requireYieldTool: false,
    autoApprove: true,
  };
}

/** Concatenate the text blocks of an assistant message (raw model output). */
export function extractAssistantText(message: {
  role: string;
  content: Array<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Run one review session against a unified diff and return the model's raw
 * text. The session is created fresh per call, runs in a throwaway temp
 * directory (never the repo root), and is disposed in a finally block.
 */
export async function runReviewSession(diffText: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-review-"));
  let session: AgentSession | undefined;
  try {
    const skills = await loadHarnessSkills(M0_HARNESS_PLUGIN_ROOT);
    const modelPattern = Bun.env.OMP_REVIEW_MODEL?.trim() || DEFAULT_MODEL_PATTERN;
    const created = await createAgentSession(
      buildSessionOptions({ cwd, pluginRoot: M0_HARNESS_PLUGIN_ROOT, skills, modelPattern }),
    );
    session = created.session;
    await session.prompt(buildReviewPrompt(diffText));
    const last = session.getLastAssistantMessage();
    if (!last) {
      throw new Error("omp review session finished without an assistant message");
    }
    return extractAssistantText(last);
  } finally {
    if (session) {
      try {
        await session.dispose();
      } catch (error) {
        // Teardown failure must not mask the primary outcome; the session is
        // one-shot and owns no other resources.
        console.error("omp review session dispose failed", error);
      }
    }
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
