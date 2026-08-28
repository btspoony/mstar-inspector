/**
 * omp AgentRuntime adapter (plan 07 Task 2) — the SINGLE omp SDK import point
 * of this module tree. The former single-session PR adapter (src/review/
 * session.ts + review.ts + run.ts) is retired here: the parent session never
 * runs an LLM turn and never carries `appendSystemPrompt`; it only hosts the
 * deterministic seat fan-out (spec: grill-me / architect lock).
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
 * Parent session options — migrated from the M1 src/review/session.ts with
 * `appendSystemPrompt` REMOVED (the seat prompts are engine-generated; the
 * parent never prompts a model). Everything else is the M1 isolation set:
 * in-memory session, read-only tool whitelist, no outbound fetch, local
 * plugin root, explicit skills, and the caller's model retry fallback chain
 * (the full selector list rides as retry.fallbackChains.default — the SDK
 * slices the chain after the active model, session/turn-recovery.ts:1455).
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

/** Inspector-owned seat wire contract (spec § 席位输出契约), strict-validated by the SDK. */
const SEAT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
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
      },
    },
    unverified: { type: "array", items: { type: "string" } },
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
 * The delivered omp AgentRuntime (plan 07 Task 2). Resolves ONLY with an
 * engine-validated mstar.review/v1 envelope; anything short of that throws.
 */
export const ompAgentRuntime: AgentRuntime = {
  async runReview(input: AgentRuntimeRunInput): Promise<MstarReviewV1> {
    // Port-level guard: the type system makes a bad level unrepresentable in
    // TS, but runtime values arrive from JSON (runner `--level`) — reject
    // instead of silently degrading (spec: throw, 不静默降档).
    if (!(input.level in REVIEW_SEATS)) {
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
    const seatAgentPath = join(cwd, ".omp", "agents", "mstar-review-seat.md");
    let session: AgentSession | undefined;
    try {
      await installSeatAgent(cwd);
      // input.modelSelectors is the single model SSOT (the runner parses
      // OMP_REVIEW_MODEL once) — the first selector is the parent's primary
      // model, the full list rides as retry.fallbackChains.default and is
      // passed verbatim per seat. Never re-parse env here (split-brain).
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
            model: [...input.modelSelectors],
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
      await rm(seatAgentPath, { force: true }).catch(() => {});
      await rmdir(join(cwd, ".omp", "agents")).catch(() => {});
      await rmdir(join(cwd, ".omp")).catch(() => {});
    }
  },
};
