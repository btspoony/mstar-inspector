/**
 * omp AgentRuntime adapter (plan 07 Task 2; deep path plan 09 Task 2) — the
 * SINGLE omp SDK import point of this module tree. The former single-session
 * PR adapter (src/review/session.ts + review.ts + run.ts) is retired here.
 * quick/default: the parent session never prompts a model — it only hosts
 * the deterministic seat fan-out. deep: the parent session runs ONE LLM turn
 * that drives the harness three-stage flow and must yield the envelope.
 * No level carries `appendSystemPrompt` (spec: grill-me / architect lock).
 *
 * Flow (`.mstar/iterations/v0.3/specs/agent-runtime.md` § omp adapter 内部形状):
 *   1. createAgentSession — parent session, M1 isolation items unchanged
 *      (Settings.isolated fetch.enabled=false, restrictToolNames + read/grep/
 *      glob, additionalExtensionPaths=[HARNESS_PLUGIN_ROOT], autoApprove),
 *      minus appendSystemPrompt; the seat agent definition (./seat-agent.md)
 *      is copied into the PR clone (input.worktreePath) at .omp/agents/ so
 *      omp's project-scope agent discovery finds it. The session cwd IS the
 *      clone: SDK buildExecutorOptions derives every seat's tool cwd from
 *      session.cwd, so relative read/grep/glob paths (reconFacts are
 *      repo-relative) resolve against the review tree.
 *   2. Deterministic seat partition over reconFacts numstat lines (no LLM
 *      dispatch): quick = 1 seat (full diff), default = 2 seats clustered by
 *      top-level directory balanced on changed lines; degenerate inputs fall
 *      back to sorted-path halves. Both seats together always cover every
 *      changed file (overlap allowed; merge dedupes).
 *   3. One runStructuredSubagent call per seat (Promise.all fan-out), with
 *      assignment = engine `prReviewSeatPrompt(...)` — zero copies of harness
 *      prompt text in this repo — and a strict seat output schema.
 *   4. Merge + dedupe seat findings (fingerprint_hint ?? file:line:title),
 *      synthesizeReview (engine default summary template), validateMstarReviewV1.
 *   5. deep (plan 09 T2): no partition, no Bun fan-out — createAgentSession
 *      with read/grep/glob + the SDK built-in `task` tool and a strict
 *      PARENT_OUTPUT_SCHEMA; the harness /amazing-pr-review command is loaded
 *      from HARNESS_PLUGIN_ROOT into the assignment (zero copy), the deep
 *      seat roles (DEEP_SEAT_ROLES) are installed into <worktree>/.omp/agents/
 *      as OMP-native read-only seat definitions (seat-agent.md frontmatter
 *      contract, bodies loaded from the plugin root), and one session.prompt()
 *      drives the three stages; the turn must end in a schema-validated
 *      yield, which the adapter re-validates with validateMstarReviewV1
 *      (spec Architect locks L1/L2).
 *
 * Failure contract: ANY seat/parse/validation failure throws — the caller
 * never receives an M1-shaped fake success and nothing is posted or stored.
 *
 * reconFacts conventions this adapter defines for the consumer (wired in plan
 * 07 Task 5):
 *   - `<owner>/<repo>#<pr>`     → folded into the envelope `target`;
 *   - `head <sha>`              → folded into `target.head_sha`;
 *   - git-numstat lines `"<add>\t<del>\t<path>"` → the seat-partition universe.
 * Facts not matching these shapes pass through to the seat prompts verbatim.
 *
 * MCP note: `runStructuredSubagent` has no `enableMCP` field in 18.0.4 — MCP
 * is derived as `!restrictToolNames && …` (structured-subagent.ts:387), so the
 * restricted parent session structurally disables MCP for every seat.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  loadSkillsFromDir,
  SessionManager,
  Settings,
  type AgentSession,
  type CreateAgentSessionOptions,
  type Skill,
  type ToolSession,
} from "@oh-my-pi/pi-coding-agent";
import { runStructuredSubagent, type StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
  MERGE_CLASSES,
  PR_VERDICTS,
  prReviewSeatPrompt,
  synthesizeReview,
  validateMstarReviewV1,
  type MstarReviewFinding,
  type MstarReviewV1,
} from "@mstar-harness/engine";
import { REVIEW_SEATS, type AgentRuntime, type AgentRuntimeRunInput, type ReviewLevel } from "./runtime";

/**
 * Environment override for the mstar-harness plugin root — the primary,
 * documented configuration surface. It wins over the sibling-directory and
 * absolute-path defaults so tests and CI can inject a fixture root. The test
 * fixture mirrors this name (tests/review/plugin-root-fixture.ts).
 */
const HARNESS_ROOT_ENV = "HARNESS_PLUGIN_ROOT";

/** Plan-verified absolute fallback for the M0 plugin root (plan 02 Global Constraints). */
const ABSOLUTE_HARNESS_ROOT = "/Users/bibi/workspace/ai/mstar-harness";

/**
 * Resolve the local mstar-harness plugin root, in priority order:
 *   1. $HARNESS_PLUGIN_ROOT — explicit configuration (primary surface);
 *   2. the sibling directory `../mstar-harness` relative to this package
 *      (the main-repo layout);
 *   3. the plan-verified absolute path (local default fallback only).
 * M0 never installs from GitHub. Resolved lazily per call so tests can
 * inject a fixture root regardless of module evaluation order.
 */
export function resolveHarnessRoot(): string {
  const fromEnv = Bun.env[HARNESS_ROOT_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const sibling = resolve(import.meta.dir, "../../../mstar-harness");
  if (existsSync(sibling)) return sibling;
  return ABSOLUTE_HARNESS_ROOT;
}

/** Read-only tool whitelist (plan 02 Global Constraints — parent + seat). */
export const REVIEW_TOOL_NAMES = ["read", "grep", "glob"] as const;

/** Default model selector; used when the caller passes an empty modelSelectors chain (the runner parses OMP_REVIEW_MODEL into modelSelectors). */
const DEFAULT_MODEL_PATTERN = "ark-plan/deepseek-v4-flash";

/**
 * Parse the OMP_REVIEW_MODEL value into model selectors: comma-separated,
 * trimmed, empty entries dropped. `undefined`/empty → `[]` (the default
 * model pattern is used, no fallback chain configured).
 */
export function parseModelSelectors(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/**
 * Load every skill from the local mstar-harness plugin root and require the
 * mstar-audit judgment skill to be present (plan 02 Global Constraints).
 * Seats receive these as session skills; their prompts point at the plugin
 * root's pr-review reference by absolute path (engine prReviewSeatPrompt).
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

/**
 * quick/default parent session options — migrated from the M1
 * src/review/session.ts with `appendSystemPrompt` REMOVED (the seat prompts
 * are engine-generated; this parent never prompts a model). Everything else
 * is the M1 isolation set: in-memory session, read-only tool whitelist, no
 * outbound fetch, local plugin root, explicit skills, and the caller's model
 * retry fallback chain (the full selector list rides as
 * retry.fallbackChains.default — the SDK slices the chain after the active
 * model, session/turn-recovery.ts:1455). The deep parent (deepSessionOptions)
 * spreads this and adds the deep-only deltas on top.
 */
export function buildSessionOptions(opts: {
  cwd: string;
  pluginRoot: string;
  skills: Skill[];
  modelPattern: string;
  fallbackChain?: string[];
}): CreateAgentSessionOptions {
  return {
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(opts.cwd),
    settings: Settings.isolated({
      "fetch.enabled": false,
      "retry.modelFallback": true,
      "retry.fallbackChains": { default: opts.fallbackChain ?? [] },
    }),
    restrictToolNames: true,
    toolNames: [...REVIEW_TOOL_NAMES],
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [opts.pluginRoot],
    skills: opts.skills,
    modelPattern: opts.modelPattern,
    enableMCP: false,
    enableLsp: false,
    requireYieldTool: false,
    autoApprove: true,
  };
}

/**
 * The parent AgentSession is not a ToolSession (missing cwd / hasUI /
 * getSessionFile / getSessionSpawns — tsc-verified against 18.0.4). Shim the
 * four members over a Proxy and delegate everything else, bound to the real
 * session so private internal state keeps working:
 *   - cwd = the PR clone (input.worktreePath) — drives .omp/agents
 *     discovery and every seat's tool cwd (SDK buildExecutorOptions reads
 *     `cwd: session.cwd`);
 *   - hasUI = false (headless container);
 *   - getSessionFile = () => null (in-memory session);
 *   - getSessionSpawns = () => null (spawn policy "*" — we pass `agent:`
 *     explicitly; the default agent never matters).
 */
function asToolSession(session: AgentSession, cwd: string): ToolSession {
  return new Proxy(session, {
    get(target, prop) {
      if (prop === "cwd") return cwd;
      if (prop === "hasUI") return false;
      if (prop === "getSessionFile") return () => null;
      if (prop === "getSessionSpawns") return () => null;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ToolSession; // the get-trap supplies the four members tsc flags as missing
}

/** One accepted finding — shared by the seat wire contract and the deep parent envelope schema (mstar.review/v1 finding shape, SP3 § Schema). */
const REVIEW_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mergeClass", "title", "body"],
  properties: {
    mergeClass: { enum: [...MERGE_CLASSES] },
    title: { type: "string" },
    body: { type: "string" },
    category: { type: "string" },
    file_path: { type: ["string", "null"] },
    line_start: { type: ["integer", "null"] },
    line_end: { type: ["integer", "null"] },
    fingerprint_hint: { type: "string" },
  },
} as const;

/** Inspector-owned seat wire contract (spec § 席位输出契约), strict-validated by the SDK. */
const SEAT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: { type: "array", items: REVIEW_FINDING_SCHEMA },
    unverified: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * Parent-session output contract for the deep path (plan 09 T2) — the
 * mstar.review/v1 envelope shape as a strict JSON Schema (spec Architect
 * lock L2). The SDK's strict mode only enforces shape; the engine
 * vocabulary SSOT re-validates the extracted payload.
 */
const PARENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "verdict", "summary_md", "findings"],
  properties: {
    schema: { enum: ["mstar.review/v1"] },
    verdict: { enum: [...PR_VERDICTS] },
    summary_md: { type: "string" },
    findings: { type: "array", items: REVIEW_FINDING_SCHEMA },
    tally: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "scorePct", "tally", "chatHeader"],
      properties: {
        verdict: { enum: [...PR_VERDICTS] },
        scorePct: { type: "integer" },
        tally: {
          type: "object",
          additionalProperties: false,
          required: ["mustFix", "shouldFix", "nit", "unverified"],
          properties: {
            mustFix: { type: "integer" },
            shouldFix: { type: "integer" },
            nit: { type: "integer" },
            unverified: { type: "integer" },
          },
        },
        chatHeader: { type: "string" },
      },
    },
    target: {
      type: "object",
      additionalProperties: false,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        head_sha: { type: "string" },
      },
    },
  },
} as const;

type SeatOutput = {
  findings: MstarReviewFinding[];
  unverified?: string[];
};

/** One deterministic seat: prompt labels + the changed-file scope it reviews. */
export type SeatPlan = {
  domain: string;
  seat: string;
  scope: readonly string[];
};

/** git-numstat line: `"<added>\t<deleted>\t<path>"` (binary counts are "-"). */
const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/** `<owner>/<repo>#<pr>` recon fact → envelope target fields. */
const PR_FACT_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;

/** `head <sha>` recon fact → envelope target.head_sha. */
const HEAD_FACT_RE = /^head ([0-9a-f]{7,64})$/;

/** Changed files with a balancing weight (added + deleted lines). */
type ChangedFile = { path: string; lines: number };

/** Extract the partition universe: numstat-shaped recon facts, in order. */
function parseChangedFiles(reconFacts: readonly string[]): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const fact of reconFacts) {
    const match = NUMSTAT_RE.exec(fact);
    if (!match) continue;
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const deleted = match[2] === "-" ? 0 : Number(match[2]);
    files.push({ path: match[3]!, lines: added + deleted });
  }
  return files;
}

/** Fold `owner/repo#pr` and `head <sha>` recon facts into the envelope target. */
export function parseTarget(reconFacts: readonly string[]): MstarReviewV1["target"] {
  let target: MstarReviewV1["target"] | undefined;
  for (const fact of reconFacts) {
    const prMatch = PR_FACT_RE.exec(fact);
    if (prMatch) {
      target = { ...target, owner: prMatch[1], repo: prMatch[2], pr: Number(prMatch[3]) };
      continue;
    }
    const headMatch = HEAD_FACT_RE.exec(fact);
    if (headMatch) {
      target = { ...target, head_sha: headMatch[1] };
    }
  }
  return target;
}

/** Top-level directory bucket of a changed path; repo-root files share "(root)". */
function topDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

/** Seat label from the group's directories: lowercase-kebab, capped at 48 chars. */
function seatLabel(dirs: readonly string[]): string {
  const label = [...dirs].sort().join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return label.length === 0 ? "combined" : label.slice(0, 48);
}

/**
 * Deterministic seat partition (spec § 席位范围规则 — no LLM dispatch):
 *   quick → one seat covering everything (domain `full-diff`, seat `combined`);
 *   default → cluster changed files by top-level directory, then merge the
 *   clusters into two groups balanced on changed lines (longest-processing-
 *   time greedy); degenerate inputs (fewer than 2 files, or a single cluster)
 *   fall back to sorted-path halves with domains `changeset-1`/`changeset-2`.
 *   An empty universe (no numstat facts) gives both seats full coverage —
 *   overlap is allowed and the merge step dedupes.
 */
export function partitionSeats(reconFacts: readonly string[], level: ReviewLevel): SeatPlan[] {
  const files = parseChangedFiles(reconFacts);
  if (level === "quick") {
    return [{ domain: "full-diff", seat: "combined", scope: files.map((file) => file.path).sort() }];
  }

  const degenerateHalves = (): SeatPlan[] => {
    const paths = files.map((file) => file.path).sort();
    const half = Math.ceil(paths.length / 2);
    const first = paths.slice(0, half);
    const second = paths.slice(half);
    // Single changed file: both seats take it (overlap + merge dedupe keeps
    // combined coverage without an empty seat scope).
    return [
      { domain: "changeset-1", seat: "part-1", scope: first },
      { domain: "changeset-2", seat: "part-2", scope: second.length > 0 ? second : first },
    ];
  };

  const clusters = new Map<string, { paths: string[]; lines: number }>();
  for (const file of files) {
    const dir = topDir(file.path);
    const cluster = clusters.get(dir) ?? { paths: [], lines: 0 };
    cluster.paths.push(file.path);
    cluster.lines += file.lines;
    clusters.set(dir, cluster);
  }
  if (clusters.size === 1) {
    return degenerateHalves();
  }

  const sorted = [...clusters.entries()].sort(
    ([dirA, a], [dirB, b]) => b.lines - a.lines || dirA.localeCompare(dirB),
  );
  const groups = [
    { dirs: [] as string[], paths: [] as string[], lines: 0 },
    { dirs: [] as string[], paths: [] as string[], lines: 0 },
  ];
  for (const [dir, cluster] of sorted) {
    // Lightest group wins; ties go to group 0 (deterministic).
    const target = groups[1]!.lines < groups[0]!.lines ? groups[1]! : groups[0]!;
    target.dirs.push(dir);
    target.paths.push(...cluster.paths);
    target.lines += cluster.lines;
  }
  return [
    { domain: "changeset-1", seat: seatLabel(groups[0]!.dirs), scope: groups[0]!.paths.sort() },
    { domain: "changeset-2", seat: seatLabel(groups[1]!.dirs), scope: groups[1]!.paths.sort() },
  ];
}

/** Per-seat recon facts: the shared facts plus this seat's file scope. */
function seatReconFacts(reconFacts: readonly string[], plan: SeatPlan): string[] {
  if (plan.scope.length === 0) return [...reconFacts];
  return [...reconFacts, `File scope for this seat (review ONLY these files):`, ...plan.scope];
}

/** Seat assignment = engine prReviewSeatPrompt — zero copies of harness text. */
function seatAssignment(input: AgentRuntimeRunInput, pluginRoot: string, plan: SeatPlan): string {
  return prReviewSeatPrompt({
    stage: 2, // quick/default fold collection into the domain seat (harness tier table).
    domain: plan.domain,
    seat: plan.seat,
    skillRoot: `${pluginRoot}/skills/mstar-audit`,
    worktreePath: input.worktreePath,
    reconFacts: seatReconFacts(input.reconFacts, plan),
    tier: input.level,
  });
}

/** Extract and guard the strict-validated seat payload. */
function seatOutput(result: StructuredSubagentResult, index: number): SeatOutput {
  const single = result.result;
  if (single.error) {
    throw new Error(`review seat ${index} (${single.agent}) failed: ${single.error}`);
  }
  const structured = single.structuredOutput;
  if (!structured || structured.status !== "valid" || structured.data === undefined) {
    const detail = structured?.error ?? single.stderr.slice(-200);
    throw new Error(
      `review seat ${index} (${single.agent}) produced no valid structured output` +
        `(status ${structured?.status ?? "absent"})${detail ? `: ${detail}` : ""}`,
    );
  }
  return structured.data as SeatOutput;
}

/** Spec fingerprint: explicit hint, else the `file:line:title` composite. */
function findingFingerprint(finding: MstarReviewFinding): string {
  return finding.fingerprint_hint ?? `${finding.file_path}:${finding.line_start}:${finding.title}`;
}

/**
 * Merge seat outputs: exact-dedupe findings by fingerprint (first seat wins),
 * union-dedupe unverified strings (spec § 合并与合成).
 */
export function mergeSeatOutputs(outputs: readonly SeatOutput[]): {
  findings: MstarReviewFinding[];
  unverifiedCount: number;
} {
  const findings = new Map<string, MstarReviewFinding>();
  const unverified = new Set<string>();
  for (const output of outputs) {
    for (const finding of output.findings ?? []) {
      const fingerprint = findingFingerprint(finding);
      if (!findings.has(fingerprint)) {
        findings.set(fingerprint, finding);
      }
    }
    for (const item of output.unverified ?? []) {
      unverified.add(item);
    }
  }
  return { findings: [...findings.values()], unverifiedCount: unverified.size };
}

/** Install the shipped seat-agent definition into the PR clone (the session cwd) for omp discovery; runReview removes it again when the run ends. */
async function installSeatAgent(cwd: string): Promise<void> {
  const definition = await readFile(join(import.meta.dir, "seat-agent.md"), "utf8");
  const agentsDir = join(cwd, ".omp", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "mstar-review-seat.md"), definition);
}

/**
 * Deep Stage 2 seat roles (harness pr-review § Review pipeline): the
 * three-stage flow dispatches exactly these harness roles as domain seats
 * (each carrying the in-domain security lens). Installing ONLY these keeps
 * the task-tool agent schema minimal, and the cleanup set static. Exported
 * for the dashboard-side MODEL_ROLE_IDS parity lock (plan 17 B6 — the test
 * import does not widen the dashboard's own import boundary).
 */
export const DEEP_SEAT_ROLES = ["code-reviewer", "fullstack-dev", "frontend-dev"] as const;

/** Filenames the deep path may install — known statically, so a partially-failed install cleans up exactly like a complete one. */
const DEEP_SEAT_ROLE_FILES: readonly string[] = DEEP_SEAT_ROLES.map((role) => `${role}.md`);

/** Strip a `---`-fenced frontmatter block; the role body is what the seat reads. */
function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized.trim();
  return normalized.slice(end + 4).trim();
}

/**
 * Rewrite a harness role file into an OMP-native read-only seat definition
 * (qc2 F-001): harness agents/*.md carry OpenCode-style frontmatter (`tools`
 * as an object map), which the SDK `parseAgentFields` reads as NO tool list —
 * under the parent's restrictToolNames that spawns a yield-only seat that
 * cannot read the clone. The installed contract is the same as
 * ./seat-agent.md — name + description + `tools: [read, grep, glob]` — with
 * the harness role BODY kept verbatim (zero-copy: sourced from the plugin
 * root at runtime, never pasted into src/).
 */
function toOmpSeatDefinition(role: string, source: string): string {
  const body = stripFrontmatter(source);
  return [
    "---",
    `name: ${role}`,
    `description: Read-only deep-review seat for the ${role} harness role — collects and vets review findings for its assigned domain using only read, grep, and glob.`,
    `tools: [${REVIEW_TOOL_NAMES.join(", ")}]`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Install the deep seat definitions into the PR clone for omp project-scope
 * discovery (discoverAgents reads <session-cwd>/.omp/agents/): the deep
 * parent dispatches its Stage 2 domain seats with the SDK built-in `task`
 * tool against these definitions (spec Architect lock L1). Each harness role
 * file is loaded from the plugin root at runtime and rewritten with the
 * OMP-native frontmatter contract; a missing role file throws fail-loud (a
 * seat the flow cannot dispatch is a broken review, not a degraded one).
 */
async function installDeepSeatAgents(cwd: string, pluginRoot: string): Promise<void> {
  const agentsDir = join(cwd, ".omp", "agents");
  await mkdir(agentsDir, { recursive: true });
  for (const role of DEEP_SEAT_ROLES) {
    let source: string;
    try {
      source = await readFile(join(pluginRoot, "agents", `${role}.md`), "utf8");
    } catch {
      throw new Error(`mstar-harness plugin at ${pluginRoot} is missing the deep seat role agents/${role}.md`);
    }
    await writeFile(join(agentsDir, `${role}.md`), toOmpSeatDefinition(role, source));
  }
}

/** Remove the agent definitions a run installed; rmdir only removes the dirs we left empty. */
async function removeInstalledAgents(cwd: string, names: readonly string[]): Promise<void> {
  await Promise.all(names.map((name) => rm(join(cwd, ".omp", "agents", name), { force: true }).catch(() => {})));
  await rmdir(join(cwd, ".omp", "agents")).catch(() => {});
  await rmdir(join(cwd, ".omp")).catch(() => {});
}

/**
 * Run `review` with the GitHub token env aliases removed from the process
 * env (qc2 F-004: `GH_TOKEN` and `GITHUB_TOKEN` — the common `gh` alias;
 * spec: the deep parent env carries no writable GitHub token). The SDK
 * session has no env override surface, so the strip window covers the parent
 * turn — the phase in which every seat spawns — and the previous values are
 * restored afterwards even on throw (the consumer's own git/gh steps run in
 * their own exec envs, outside this window).
 */
async function withoutGitHubTokenEnv<T>(review: () => Promise<T>): Promise<T> {
  const savedGhToken = process.env.GH_TOKEN;
  const savedGithubToken = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    return await review();
  } finally {
    if (savedGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGhToken;
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubToken;
  }
}
/**
 * Deep parent session options — the quick/default isolation set plus the
 * three deep-only deltas (spec Architect locks L1/L2): the SDK built-in
 * `task` tool joins the whitelist so the parent can dispatch seats
 * (`canSpawnAtDepth(task.maxRecursionDepth ?? 2, 0)` passes for a top-level
 * session), and the strict PARENT_OUTPUT_SCHEMA + required yield tool make
 * the turn's final act a schema-validated yield. GitHub write tools stay
 * structurally absent: restrictToolNames admits ONLY the four named tools,
 * extension/MCP discovery is disabled, and fetch is off.
 *
 * Plan 17 B6 (Architect lock L2): a non-empty `agentModelOverrides` map is
 * written into the isolated settings record as `task.agentModelOverrides` —
 * the deep `task`-tool dispatch passes NO explicit model, so the SDK preflight
 * resolves each spawned seat from that record per agent name (resolution
 * order: explicit request model → task.agentModelOverrides → agent
 * frontmatter → parent active). The spawned seat session is created with
 * `settings: session.settings` (SDK structured-subagent), i.e. the SAME
 * record the parent session options carry — one write covers parent + seats.
 * Unmapped seats keep today's resolution (the installed definitions carry no
 * model frontmatter → the parent active model). buildSessionOptions stays
 * untouched (the key must never reach the quick/default settings where it is
 * a dead surface), so the overrides branch constructs the deep settings
 * record itself; the map is copied — the record must not alias caller-owned
 * state.
 */
function deepSessionOptions(opts: {
  cwd: string;
  pluginRoot: string;
  skills: Skill[];
  modelPattern: string;
  fallbackChain?: string[];
  agentModelOverrides?: Record<string, string>;
}): CreateAgentSessionOptions {
  const overrides = opts.agentModelOverrides;
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
  return {
    ...buildSessionOptions(opts),
    ...(hasOverrides
      ? {
          settings: Settings.isolated({
            "fetch.enabled": false,
            "retry.modelFallback": true,
            "retry.fallbackChains": { default: opts.fallbackChain ?? [] },
            "task.agentModelOverrides": { ...overrides },
          }),
        }
      : {}),
    toolNames: [...REVIEW_TOOL_NAMES, "task"],
    outputSchema: PARENT_OUTPUT_SCHEMA,
    outputSchemaMode: "strict",
    requireYieldTool: true,
  };
}

/**
 * Deep parent assignment — orchestration glue only. The review procedure is
 * the harness /amazing-pr-review command loaded from the plugin root at
 * runtime (zero-copy: no command text lives in this repo); the return
 * contract is the session's strict output schema, so the prompt only needs
 * to point at the yield tool and forbid GitHub publication (the caller owns
 * it — spec § GitHub: COMMENT-only, posted by the inspector).
 */
async function deepAssignment(input: AgentRuntimeRunInput, pluginRoot: string): Promise<string> {
  const command = await readFile(join(pluginRoot, "commands", "amazing-pr-review.md"), "utf8");
  return [
    "You are the parent session of a deep (three-stage) code review.",
    "",
    "Recon facts:",
    ...input.reconFacts.map((fact) => `- ${fact}`),
    "",
    `The review worktree is ${input.worktreePath} (read-only clone; your cwd).`,
    "The review seat definitions (code-reviewer / fullstack-dev /",
    "frontend-dev) are installed at .omp/agents/ — dispatch the Stage 1",
    "collect and Stage 2 domain (± security) seats with the `task` tool;",
    "Stage 3 synthesis is yours alone.",
    "",
    "Execute the following review command for tier `deep`, with one override:",
    "do NOT post anything to GitHub (no reviews, no comments) — the caller",
    "owns publication and only consumes your verdict envelope.",
    "",
    "--- begin /amazing-pr-review (loaded from the mstar-harness plugin root) ---",
    command,
    "--- end /amazing-pr-review ---",
    "",
    "Final answer: call the `yield` tool once with data = the complete",
    "mstar.review/v1 envelope JSON.",
  ].join("\n");
}

/**
 * The deep parent-session path (plan 09 T2; spec § 父 session 约束 +
 * Architect locks L1/L2): one parent LLM turn runs the harness three-stage
 * flow and dispatches its own seats via the built-in `task` tool; the turn
 * must end in a schema-validated `yield` of the mstar.review/v1 envelope,
 * which is re-validated against the engine vocabulary. No yield, a yielded
 * error, or a validation failure throws — nothing is posted or stored.
 */
async function runDeepReview(input: AgentRuntimeRunInput): Promise<MstarReviewV1> {
  const pluginRoot = resolveHarnessRoot();
  const skills = await loadHarnessSkills(pluginRoot);
  // The session cwd IS the PR clone: .omp/agents discovery and every task
  // tool seat cwd resolve against the review tree.
  const cwd = input.worktreePath;
  let session: AgentSession | undefined;
  try {
    await installDeepSeatAgents(cwd, pluginRoot);
    return await withoutGitHubTokenEnv(async () => {
      const created = await createAgentSession(
        deepSessionOptions({
          cwd,
          pluginRoot,
          skills,
          modelPattern: input.modelSelectors[0] ?? DEFAULT_MODEL_PATTERN,
          fallbackChain: [...input.modelSelectors],
          agentModelOverrides: input.modelOverrides,
        }),
      );
      session = created.session;

      // Capture the structured yield the turn must end with. Capture rides
      // `tool_execution_end`, NOT start: the SDK yield tool validates the
      // payload inside execute() — after the start event — and retries up to
      // MAX_SCHEMA_RETRIES before overriding, so a start-args capture can
      // keep a payload the SDK went on to reject (qc2 F-002). On end,
      // `isError` marks a rejected attempt (the model retries); a successful
      // end carries the accepted payload in result.details.data, and the
      // LAST successful capture wins (`=`, never `??=`) so a corrected
      // re-yield replaces an earlier accepted one.
      let yielded: unknown;
      let yieldError: string | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "tool_execution_end" || event.toolName !== "yield") return;
        if (event.isError) return;
        const details = (event.result as { details?: unknown } | undefined)?.details;
        if (!details || typeof details !== "object") return;
        const record = details as { data?: unknown; error?: string; status?: string; type?: unknown };
        if (typeof record.error === "string") {
          yieldError = record.error;
          return;
        }
        // Incremental section yields (array-typed `type`) carry partial data
        // that can never satisfy the envelope; only terminal (untyped) yields
        // with a payload count.
        if (record.status === "success" && !Array.isArray(record.type) && record.data !== undefined) {
          yielded = record.data;
        }
      });
      let turnError: unknown;
      try {
        await session.prompt(await deepAssignment(input, pluginRoot));
      } catch (error) {
        turnError = error;
      } finally {
        unsubscribe();
      }
      if (yielded === undefined) {
        if (turnError !== undefined) {
          throw turnError;
        }
        throw new Error(
          yieldError !== undefined
            ? `deep parent yielded an error: ${yieldError}`
            : "deep parent turn produced no structured yield (mstar.review/v1 envelope)",
        );
      }
      // A prompt throw AFTER a successful yield must stay observable (qc3
      // S-002): the envelope below is engine-validated, so returning it
      // stands — but the partially-failed turn is logged, not swallowed.
      if (turnError !== undefined) {
        console.error("deep parent turn raised after a successful yield", turnError);
      }

      // SDK strict schema enforcement only guarantees shape — the engine
      // vocabulary stays the SSOT (spec Architect lock L2).
      const gate = validateMstarReviewV1(yielded);
      if (!gate.ok) {
        const detail = gate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ");
        throw new Error(`deep parent yield failed mstar.review/v1 validation: ${detail}`);
      }
      return yielded as MstarReviewV1;
    });
  } finally {
    if (session) {
      try {
        await session.dispose();
      } catch (error) {
        // Teardown failure must not mask the primary outcome; the session
        // is one-shot and owns no other resources.
        console.error("omp review runtime session dispose failed", error);
      }
    }
    // Undo the seat installs; the set is static (DEEP_SEAT_ROLE_FILES), so a
    // partially-failed install cleans up exactly like a complete one (qc1
    // F-002). The clone itself is caller-owned and must survive (rmdir
    // removes the dirs only if we left them empty).
    await removeInstalledAgents(cwd, DEEP_SEAT_ROLE_FILES);
  }
}

/**
 * The delivered omp AgentRuntime (plan 07 Task 2). Resolves ONLY with an
 * engine-validated mstar.review/v1 envelope; anything short of that throws.
 */
export const ompAgentRuntime: AgentRuntime = {
  async runReview(input: AgentRuntimeRunInput): Promise<MstarReviewV1> {
    // Port-level guard: the type system makes a bad level unrepresentable in
    // TS, but runtime values arrive from JSON (runner `--level`) — reject
    // instead of silently degrading (spec: throw, 不静默降档). Deep branches
    // first (plan 09 T2): the parent-session path never enters this Bun
    // fan-out, and naming the branch first narrows `input.level` to the
    // REVIEW_SEATS keys. The own-key check (qc3 F-302) stays for the
    // remaining runtime values: `in` also matches Object.prototype keys,
    // which would pass a looser guard and only explode later with a
    // misleading seat-partition message.
    if (input.level === "deep") {
      return runDeepReview(input);
    }
    if (!Object.hasOwn(REVIEW_SEATS, input.level)) {
      throw new Error(`unsupported review level: ${JSON.stringify(String(input.level))}`);
    }

    const pluginRoot = resolveHarnessRoot();
    const skills = await loadHarnessSkills(pluginRoot);
    // The session cwd IS the PR clone (spec § 席位 worktree = 该只读 clone).
    // Seat read/grep/glob resolve relative paths against
    // buildExecutorOptions' `cwd: session.cwd`, and omp agent discovery picks
    // up the seat definition installed at <worktree>/.omp/agents/ (the clone
    // is ephemeral, so installing there is fine — it is removed on exit).
    const cwd = input.worktreePath;
    let session: AgentSession | undefined;
    try {
      await installSeatAgent(cwd);
      // input.modelSelectors is the single model SSOT (the runner parses
      // OMP_REVIEW_MODEL once) — the first selector is the parent's primary
      // model, the full list rides as retry.fallbackChains.default and is
      // passed verbatim per seat (falling back to the default pattern when empty). Never re-parse env here (split-brain).
      // Seats must never see `model: []` — an empty array is truthy, not
      // "inherit from parent", so an unset OMP_REVIEW_MODEL means every seat
      // gets the same DEFAULT_MODEL_PATTERN the parent gets (PR #4 Bugbot).
      //
      // Plan 17 B6 (Architect lock L2): the quick/default seat override is
      // applied HERE, at the seatModels synthesis — quick/default always
      // passes the explicit `model` param, and the SDK resolves an explicit
      // model BEFORE the `task.agentModelOverrides` settings override, so
      // writing the settings key would be a dead surface (it is NOT written:
      // buildSessionOptions is untouched). A present, non-blank override
      // REPLACES the global chain as the seat's explicit model — sole
      // verbatim entry (the SDK comma-splits and trims model entries, so a
      // stored chain value resolves identically; `:thinking` suffixes ride
      // along). No merge: the App's global chain remains only the
      // session-level retry fallback configured by buildSessionOptions.
      // Blank value or no map → today's synthesis verbatim.
      const seatOverride = input.modelOverrides?.["mstar-review-seat"];
      const seatModels =
        seatOverride !== undefined && seatOverride.trim() !== ""
          ? [seatOverride]
          : input.modelSelectors.length > 0
            ? [...input.modelSelectors]
            : [DEFAULT_MODEL_PATTERN];
      const created = await createAgentSession(
        buildSessionOptions({
          cwd,
          pluginRoot,
          skills,
          modelPattern: input.modelSelectors[0] ?? DEFAULT_MODEL_PATTERN,
          fallbackChain: [...input.modelSelectors],
        }),
      );
      session = created.session;

      const plans = partitionSeats(input.reconFacts, input.level);
      if (plans.length !== REVIEW_SEATS[input.level]) {
        throw new Error(
          `seat partition produced ${plans.length} seats for level ${input.level} (expected ${REVIEW_SEATS[input.level]})`,
        );
      }
      const toolSession = asToolSession(session, cwd);
      const outputs = await Promise.all(
        plans.map(async (plan, index) => {
          const result = await runStructuredSubagent({
            session: toolSession,
            invocationKind: "task",
            assignment: seatAssignment(input, pluginRoot, plan),
            agent: "mstar-review-seat",
            model: seatModels,
            outputSchema: SEAT_OUTPUT_SCHEMA,
            schemaMode: "strict",
            enableLsp: false,
            enableIrc: false,
          });
          return seatOutput(result, index);
        }),
      );

      const { findings, unverifiedCount } = mergeSeatOutputs(outputs);
      const envelope = synthesizeReview({ findings, unverifiedCount, target: parseTarget(input.reconFacts) });
      const gate = validateMstarReviewV1(envelope);
      if (!gate.ok) {
        const detail = gate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ");
        throw new Error(`synthesized review failed mstar.review/v1 validation: ${detail}`);
      }
      return envelope;
    } finally {
      if (session) {
        try {
          await session.dispose();
        } catch (error) {
          // Teardown failure must not mask the primary outcome; the session
          // is one-shot and owns no other resources.
          console.error("omp review runtime session dispose failed", error);
        }
      }
      // Undo the seat-agent install; the clone itself is caller-owned and
      // must survive (rmdir removes the dirs only if we left them empty).
      await removeInstalledAgents(cwd, ["mstar-review-seat.md"]);
    }
  },
};
