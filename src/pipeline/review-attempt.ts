/**
 * One review attempt's execution body. `prepareReviewAttempt` acquires the
 * container and its purpose-scoped credential, clones the PR head and resolves
 * the authoritative checkout SHA; `runReviewAttempt` writes the runner input,
 * makes the blocking paid call and collects the result documents. The queue
 * consumer still drives both — admission, dedupe, skip settlement, the Check
 * seam and publication stay there.
 */

import type { CustomProviderDeclaration, ReviewLevel } from "../../packages/shared/src/runtime";
import { APPLIED_MODEL_MAX_CHARS, APPLIED_MODEL_PATH, APPLIED_MODEL_PATTERN } from "../../packages/shared/src/runtime";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  type CustomProviderConsumerConfig,
  type CustomProviderModelMeta,
  type CustomProviderModelsMeta,
} from "../dashboard/app-config-store";
import type { GitOpsCommands } from "./gitops";
import { catalogLimitsFor } from "../contracts/provider-catalog-limits";
import { resolveModelSize } from "../contracts/provider-models";
import { encodeCredentialPayload, type CredentialPools } from "../../packages/shared/src/credential-payload";
import { providerEnvName } from "./provider-catalog";
import { redactExactSecrets, redactSecrets } from "./redact";
import { EXEC_TIMEOUT_GIT_MS, POST_RUNNER_READ_TIMEOUT_MS, type RunnerBudgetAnchor } from "../review-budget";
import type { FailureStage } from "../store/failure-store";
import { parseBudgetExhaustedSignal, type BudgetExhaustedOutcome } from "../review/schema";
import {
  isRecheckStatusReason,
  RECHECK_OUTPUT_PATH,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  validateRecheckDoc,
  type RecheckDoc,
  type RecheckInput,
  type RecheckStatus,
} from "../../packages/shared/src/recheck-wire";
import {
  REPORT_OUTPUT_PATH,
  validateReportDoc,
  type PrContext,
  type ReportDoc,
} from "../../packages/shared/src/report-wire";
import { assertSandboxGrant, type ReviewCommenter } from "./comment";
import {
  BOUNDED_READ_ABSENT_FLAG,
  buildGitOpsCommands,
  CLONE_DIR,
  DIFF_PATH,
  gitTransportEnv,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
  RUNNER_INPUT_PATH,
  RUNNER_PATH,
  runnerCommand,
  writeJsonCommand,
} from "./gitops";
import type { ReviewSandbox } from "./sandbox";
import type { ShellCommand } from "./shell-command";

/**
 * Structured log sink of one attempt. The caller owns the field schema; this
 * module only adds the fields of the step it is in.
 */
export type AttemptLogFields = Record<string, unknown>;

export type AttemptLog = {
  info(fields: AttemptLogFields, msg?: string): void;
  warn(fields: AttemptLogFields, msg?: string): void;
};

/**
 * The facts one attempt carries across its steps: the coarse stage the caller's
 * failure path attributes a row to, the session's ACTUAL secret values (SEC-01
 * exact-value defense) and the runner's start instant (visibility only). They
 * are passed by reference so a throw inside a step still leaves them visible to
 * the caller's catch.
 */
export type ReviewAttemptProgress = {
  failureStage: FailureStage;
  secretValues: string[];
  runnerStartedAt: number | undefined;
};

/** The container, credential and checkout an attempt's paid step runs on. */
export type PreparedReviewAttempt = {
  sandbox: ReviewSandbox;
  token: string;
  cmds: GitOpsCommands;
  headSha: string;
};

/** What the paid step left in the container for collection. */
export type ReviewAttemptExecution = {
  run: { stdout: string; stderr: string; exitCode: number };
  recheck: RecheckRead | null;
  report: ReportDoc | null;
  appliedProvider: string | null;
};

/**
 * The derived-deadline refusal: an attempt's own clock declined a step or a
 * paid exec. `window` names which derived window was spent — the runner
 * window frozen at the anchor (`runner`), or the preparation window before
 * the runner received an allocation (`preparation`).
 */
export class RoundBudgetSpent extends Error {
  constructor(
    message: string,
    readonly window: BudgetExhaustedOutcome["budgetWindow"],
  ) {
    super(message);
    this.name = "RoundBudgetSpent";
  }
}

/**
 * The resolved wall-clock stop: the outcome is built at the site that
 * observed the evidence (the runner's exit-0 signal, or the sandbox exec
 * killed at the anchored deadline) and carried to the caller's single
 * publication catch, which publishes it once — Check, durable failure row,
 * then ack.
 */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly outcome: BudgetExhaustedOutcome,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * What the derived pre-runner cutoff still owes a bounded preparation step,
 * capped at the step's own budget. THROWS the explicit round-budget failure
 * once spent: a spent deadline must decline the step, never manufacture a
 * positive (1ms) timeout that starts paid work and then fails it for the
 * wrong cause. The runner's own budget is derived once, at the anchor, and
 * never re-clamped here. `nowMs` fixes the clock when the caller must reuse
 * its own sample — a step whose timeout AND whose kill attribution read one
 * instant (the runner input write) passes it; everyone else takes the fresh
 * read.
 */
export function boundedStepTimeout(
  runnerDeadlineMs: number,
  capMs: number,
  step: string,
  window: BudgetExhaustedOutcome["budgetWindow"],
  nowMs = Date.now(),
): number {
  const left = Math.min(capMs, runnerDeadlineMs - nowMs);
  if (left <= 0) {
    throw new RoundBudgetSpent(
      `round budget spent: ${step} declined — the derived runner deadline is spent (${left}ms left for it)`,
      window,
    );
  }
  return left;
}

/**
 * Payload text of one bounded read, plus WHY it yielded nothing. A missing
 * flag line or overflow beyond the byte bound are both "no payload" to the
 * caller, but they are different D1 causes, so the failure is named rather
 * than collapsed into a bare null. Shared by the recheck document and status
 * reads and the diff capture — the transport is identical, only the producer
 * differs.
 */
type BoundedRead = { text: string | null; failure: "overflow" | "unreadable" | null };

/**
 * The report read's own result: the same transport, plus `absent` — the
 * command itself proved the path is not there. ONLY a read whose command
 * probes for the file may report it (see `readReportCommand`); every other
 * producer never emits that flag, so their reads cannot report it and keep
 * their meanings.
 */
type ReportBoundedRead = { text: string | null; failure: "overflow" | "unreadable" | "absent" | null };

export function parseBoundedRead(stdout: string): BoundedRead;
export function parseBoundedRead(stdout: string, provesAbsence: true): ReportBoundedRead;
export function parseBoundedRead(stdout: string, provesAbsence = false): ReportBoundedRead {
  const out = stdout.trimEnd();
  const split = out.lastIndexOf("\n");
  if (split < 0) return { text: null, failure: "unreadable" };
  const flag = out.slice(split + 1).trim();
  // Absence is claimed only where the command PROVED it; for every other read
  // a stray `2` keeps its old meaning (over the byte bound).
  if (provesAbsence && flag === BOUNDED_READ_ABSENT_FLAG) return { text: null, failure: "absent" };
  if (flag !== "0") return { text: null, failure: "overflow" }; // beyond the byte bound
  return { text: out.slice(0, split), failure: null };
}

async function boundedRead(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  timeoutMs: number,
): Promise<BoundedRead>;
async function boundedRead(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  timeoutMs: number,
  provesAbsence: true,
): Promise<ReportBoundedRead>;
async function boundedRead(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  timeoutMs: number,
  provesAbsence = false,
): Promise<ReportBoundedRead> {
  let read;
  try {
    read = await sandbox.runCommand(command, { timeout: timeoutMs });
  } catch {
    return { text: null, failure: "unreadable" };
  }
  if (read.exitCode !== 0) return { text: null, failure: "unreadable" };
  return provesAbsence ? parseBoundedRead(read.stdout, true) : parseBoundedRead(read.stdout);
}

/**
 * A seat-authored `reason`/`error` bounded for the D1 failure text and the log
 * field. Redaction runs FIRST: slicing first would cut a secret that straddles
 * the cap and persist its surviving fragment. `null` for a non-string field.
 */
function boundedStatusText(value: unknown): string | null {
  return typeof value === "string"
    ? redactSecrets(value).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS)
    : null;
}

/**
 * The seat's recheck status document (`RecheckStatus`), or null when the file
 * is absent/unreadable or carries a foreign schema or HEAD. Anything but this
 * round's own status for this HEAD is no attribution at all — never a
 * fabricated outcome.
 */
function parseRecheckStatus(text: string | null, headSha: string): RecheckStatus | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    if (value["schema"] !== "mstar.recheck-status/v1" || value["headSha"] !== headSha) return null;
    const outcome = value["outcome"];
    if (outcome !== "ok" && outcome !== "skipped" && outcome !== "failed") return null;
    // `rejected` is DERIVED from the row-id list, never read from the document:
    // one source survives, so the two faces of the count cannot disagree in a
    // foreign or hand-rolled status. `rejected_unnamed` has no list to derive
    // from — it is the count of drops the gate could not name, and it is the
    // only record of them once the seat has filtered its own document.
    const rejectedRowIds = Array.isArray(value["rejected_row_ids"])
      ? value["rejected_row_ids"].filter((id): id is string => typeof id === "string")
      : [];
    const rejectedUnnamed = value["rejected_unnamed"];
    return {
      schema: "mstar.recheck-status/v1",
      headSha,
      outcome,
      rejected: rejectedRowIds.length,
      rejected_row_ids: rejectedRowIds,
      rejected_unnamed:
        typeof rejectedUnnamed === "number" && Number.isInteger(rejectedUnnamed) && rejectedUnnamed >= 0
          ? rejectedUnnamed
          : 0,
      // `reason` is a CLOSED vocabulary: the per-row accounting below branches
      // on these exact literals, so an off-vocabulary value would fall through
      // to the wrong verdict instead of being ignored. Unrecognized → null
      // (same as absent), never a guessed reason.
      reason: isRecheckStatusReason(value["reason"]) ? value["reason"] : null,
      error: boundedStatusText(value["error"]),
    };
  } catch {
    return null;
  }
}

/**
 * Bounded read + validation of the runner's recheck output:
 * the audited fixed-path command (`src/pipeline/gitops.ts`
 * `readRecheckCommand`) emits `<content>\n<overflow-flag>` where the flag is
 * `wc -c`'s own output, i.e. NEWLINE-TERMINATED (`…\n0\n` / `…\n1\n`). The
 * flag is therefore read off the last non-empty line after the trailing
 * newline(s) are dropped — a transport that preserves or trims that final
 * newline parses identically. Flag `0` = within the byte bound. Anything else
 * (non-zero exit, overflow, malformed JSON, failed validation) is NO recheck:
 * the round proceeds with every selected row conservatively omitted, never a
 * fabricated document.
 *
 * The SAME transport reads the seat's status document, which is what makes a
 * round that produced no usable document attributable in D1 without container
 * stderr. Rows `validateRecheckDoc` dropped come back as `rejected` so the
 * reconciliation can name them `invalid-output` instead of `omitted` — but the
 * written document is ALREADY filtered by the seat, so a second validation
 * pass sees no drops; the status's `rejected_row_ids` is the only surviving
 * record of them and is therefore the primary source. It is trusted only for
 * the row IDs this round actually sent. A drop that carried no usable rowId
 * cannot be named: the status's `rejected_unnamed` count is the record of it,
 * and the reconciliation attributes those drops by position among the
 * sent-but-unanswered rows. The two sources are unioned by taking the larger
 * count, since the seat filters its document before writing it.
 */
export type RecheckRead = {
  doc: RecheckDoc | null;
  /** Why `doc` is null (absent read / overflow / validation), null when it survived. */
  docFailure: string | null;
  rejected: ReadonlySet<string>;
  anonymousRejectedRows: number;
  status: RecheckStatus | null;
};

async function readRecheckDoc(sandbox: ReviewSandbox, recheckInput: RecheckInput): Promise<RecheckRead> {
  const [docRead, statusRead] = await Promise.all([
    boundedRead(sandbox, readRecheckCommand(RECHECK_OUTPUT_PATH), POST_RUNNER_READ_TIMEOUT_MS),
    boundedRead(sandbox, readRecheckStatusCommand(), POST_RUNNER_READ_TIMEOUT_MS),
  ]);
  let doc: RecheckDoc | null = null;
  // A zero-byte payload is the seat writing nothing: absent, not malformed.
  // Parsing it would throw and report the round as a JSON fault instead.
  const docText = docRead.text !== null && docRead.text.trim() !== "" ? docRead.text : null;
  let docFailure: string | null =
    docRead.failure ?? (docRead.text !== null && docText === null ? "absent" : null);
  const droppedRowIds = new Set<string>();
  let anonymousRejectedRows = 0;
  if (docText !== null) {
    try {
      const gate = validateRecheckDoc(JSON.parse(docText), recheckInput);
      if (gate.ok) {
        doc = gate.doc;
        docFailure = null;
        for (const row of gate.rejected) {
          if (row.rowId === null) anonymousRejectedRows += 1;
          else droppedRowIds.add(row.rowId);
        }
      } else {
        docFailure = `invalid-document: ${gate.error}`;
      }
    } catch {
      docFailure = "invalid-document: not JSON";
    }
  }
  const status = parseRecheckStatus(statusRead.text, recheckInput.headSha);
  const sent = new Set(recheckInput.targets.map((target) => target.rowId));
  const rejected = new Set(droppedRowIds);
  // A row the surviving document CARRIES has a real answer, so a status that
  // also names it (the seat drops, then re-emits it) must not cost it that
  // answer: `rejected` outranks the answered row in the reconciliation, and a
  // row listed in both would report `invalid-output` instead of its actual
  // assessment. Local gate drops need no such filter — a dropped row is by
  // construction absent from `doc.results`.
  const answeredRowIds = new Set((doc?.results ?? []).map((row) => row.rowId));
  for (const rowId of status?.rejected_row_ids ?? []) {
    if (sent.has(rowId) && !answeredRowIds.has(rowId)) rejected.add(rowId);
  }
  // The seat writes an ALREADY-FILTERED document, so the local pass above
  // normally sees no drops at all; the status is the surviving record. Taking
  // the larger of the two unions them without double-counting a round whose
  // unfiltered document also reached this pass.
  const unnamedRejectedRows = Math.max(anonymousRejectedRows, status?.rejected_unnamed ?? 0);
  return { doc, docFailure, rejected, anonymousRejectedRows: unnamedRejectedRows, status };
}

/**
 * Bounded read + validation + redaction of the report seat's document: the
 * audited fixed-path read (`readReportCommand`) yields `<content>\n<flag>`;
 * anything other than a flag-0 document that passes `validateReportDoc` and is
 * bound to `expectedHeadSha` is NO report (the sections render `none`) and
 * leaves ONE warn naming which cause rejected it — a document the read PROVED
 * missing (`absent`) and a read that broke (`unreadable`) are separate names,
 * though both render `none`. Each narrative field is redacted before it can
 * reach a public body — the seat's text is model output like any other, and a
 * prompt-injected credential can hide in a PR description it quoted.
 */
/**
 * The runner's applied-model document: WHICH `provider/model` actually served
 * the round, or null when the runner wrote none (no model served). This is a
 * projection of the runner's observation — never a derivation from the
 * configured chain, which would report what we asked for instead of what ran.
 * A broken read or document is null with one warn: losing the attribution must
 * never lose the review, and it must never invent a provider either.
 */
async function readAppliedProvider(
  sandbox: ReviewSandbox,
  secretValues: string[],
  log: AttemptLog,
  fields: AttemptLogFields,
): Promise<string | null> {
  const read = await boundedRead(sandbox, readReportCommand(APPLIED_MODEL_PATH), POST_RUNNER_READ_TIMEOUT_MS, true);
  if (read.failure !== null) {
    // `absent` is the ordinary no-model-served shape — no warn without a fault.
    if (read.failure !== "absent") {
      log.warn({ ...fields, applied_model: read.failure }, `applied-model document ${read.failure}`);
    }
    return null;
  }
  if (read.text === null || read.text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    log.warn({ ...fields, applied_model: "invalid-json" }, "applied-model document is not JSON — left unrecorded");
    return null;
  }
  const value = (parsed as { appliedModel?: unknown } | null)?.appliedModel;
  if (typeof value !== "string") {
    log.warn(
      { ...fields, applied_model: "invalid-document" },
      "applied-model document carries no provider — left unrecorded",
    );
    return null;
  }
  // The document is container-authored, like the recheck status and the report:
  // bounded FIRST (a value over the column's bound is refused whatever it
  // contains), then redacted, then validated to the shape the column advertises
  // (`provider/model`) — never persisted as whatever string it carried.
  const trimmed = value.trim();
  if (trimmed.length > APPLIED_MODEL_MAX_CHARS) {
    log.warn(
      { ...fields, applied_model: "invalid-document" },
      "applied-model document exceeds the provider bound — left unrecorded",
    );
    return null;
  }
  const redacted = redactExactSecrets(redactSecrets(trimmed), secretValues).trim();
  if (!APPLIED_MODEL_PATTERN.test(redacted)) {
    log.warn(
      { ...fields, applied_model: "invalid-document" },
      "applied-model document does not name a provider/model pair — left unrecorded",
    );
    return null;
  }
  return redacted;
}

async function readReportDoc(
  sandbox: ReviewSandbox,
  secretValues: string[],
  expectedHeadSha: string,
  log: AttemptLog,
  fields: AttemptLogFields,
): Promise<ReportDoc | null> {
  const read = await boundedRead(sandbox, readReportCommand(), POST_RUNNER_READ_TIMEOUT_MS, true);
  if (read.failure !== null) {
    // `absent` and `unreadable` are distinct failures of the SAME disclosure:
    // the seat wrote no document vs. the read of it broke. Both render `none`.
    log.warn(
      { ...fields, report_doc: read.failure },
      `report document ${read.failure} — sections render none`,
    );
    return null;
  }
  if (read.text === null || read.text.trim() === "") {
    log.warn({ ...fields, report_doc: "empty" }, "report document empty — sections render none");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    // No parse-error detail: `JSON.parse` quotes the input, and the input is
    // seat-authored text that may carry a credential-shaped value.
    log.warn({ ...fields, report_doc: "invalid-json" }, "report document is not JSON — sections render none");
    return null;
  }
  const redact = (text: string) => redactExactSecrets(redactSecrets(text), secretValues);
  const gate = validateReportDoc(parsed);
  if (!gate.ok) {
    // The shared gate names only the accepted shape, never the seat's own
    // key/value text; the same shape + exact-value redaction every other log
    // field gets is applied here too.
    const error = redact(gate.error);
    log.warn(
      { ...fields, report_doc: "invalid-document", report_doc_error: error },
      `report document failed its gate — sections render none: ${error}`,
    );
    return null;
  }
  // The fixed path is shared with every earlier run in this container: a
  // document bound to another head is that run's narrative, not this one's. A
  // missing/invalid head never reaches here — the gate rejects it first.
  if (gate.doc.headSha !== expectedHeadSha) {
    log.warn(
      {
        ...fields,
        report_doc: "stale-head",
        report_doc_head_sha: gate.doc.headSha,
      },
      `report document is bound to head ${gate.doc.headSha}, not the reviewed head ${expectedHeadSha} — sections render none`,
    );
    return null;
  }
  return {
    schema: "mstar.report/v1",
    headSha: gate.doc.headSha,
    overview: redact(gate.doc.overview),
    linkedIssueAc: redact(gate.doc.linkedIssueAc),
    verified: redact(gate.doc.verified),
    rejected: redact(gate.doc.rejected),
    planToFix: redact(gate.doc.planToFix),
  };
}

/** The harness paths the in-image runner exec env carries. */
const HARNESS_ROOT = "/opt/mstar-harness";
const OMP_AGENT_DIR = "/opt/omp-agent";

/**
 * Per-App AI configuration for the runner exec env. `keys` maps provider id
 * to decrypted key pools in store order; modelChain is the verbatim stored
 * selector chain. Missing chains or keyless chain providers fail closed.
 */
export type RunnerAppConfig = {
  keys: Record<string, string[]>;
  modelChain: string | null;
};

/**
 * The effective model selector chain for one message plus WHERE it came from.
 * AL-24-5 zero global fallback: the App's verbatim non-blank chain is the ONLY
 * source. A falsy/whitespace-only chain = unset (input bounds) →
 * `chain: undefined` (unreachable on the production path: the fail-closed
 * assertAppConfigComplete gate rejects a chain-less App before the
 * runner/put steps; the undefined shape survives only for direct unit calls
 * to this single-point parser). `fromApp` is always true. This is THE chain
 * single source — used by the runner exec env and the version-record put, so
 * the recorded model can never drift from the chain the runner actually saw.
 */
export function effectiveModelChain(
  appCfg: RunnerAppConfig | undefined,
): { chain: string | undefined; fromApp: boolean } {
  const appChain =
    typeof appCfg?.modelChain === "string" && appCfg.modelChain.trim() !== ""
      ? appCfg.modelChain
      : undefined;
  if (appChain !== undefined) return { chain: appChain, fromApp: true };
  return { chain: undefined, fromApp: true };
}

/**
 * The head (primary) selector of an effective chain — the version record
 * written to `reviews.model`. Comma-separated, trimmed,
 * empty segments dropped (the same grammar as the runner-side selector
 * parse). No chain → NULL — reachable only from direct unit calls: on the
 * production path assertAppConfigComplete fail-closes any App whose chain
 * is missing or parses to zero selectors (AL-24-5), so a successful put
 * never records NULL (the in-image DEFAULT_MODEL_PATTERN scaffold is
 * unreachable from the consumer).
 */
export function chainHeadSelector(chain: string | undefined): string | null {
  if (chain === undefined) return null;
  for (const segment of chain.split(",")) {
    const selector = segment.trim();
    if (selector !== "") return selector;
  }
  return null;
}

/**
 * The runner-input projection of one consumer config: the declaration with
 * the API keys stripped. Provider keys ride only the runner's stdin credential
 * payload (under the declaration's own provider id).
 *
 * Sizes are resolved HERE, not stored: the operator's statement wins per field
 * and the provider catalog fills a blank one. The runner has no catalog of its
 * own (the image copies package sources only), so a size left unresolved would
 * reach the synthesized models.yml as absent. A model with a fact on neither
 * side keeps the bare id entry it has always had.
 */
function toRunnerCustomProvider(provider: CustomProviderConsumerConfig): CustomProviderDeclaration {
  const declaration: CustomProviderDeclaration = {
    provider_id: provider.provider_id,
    base_url: provider.base_url,
    api: provider.api,
    model_ids: [...provider.model_ids],
  };
  // The vendor's numbers describe the MODEL, so the id alone resolves them —
  // whatever endpoint the declaration points at.
  const catalog = catalogLimitsFor(provider.provider_id);
  const meta: CustomProviderModelsMeta = {};
  for (const modelId of provider.model_ids) {
    const declared = provider.models_meta?.[modelId];
    const resolved = resolveModelSize(declared, catalog?.[modelId]);
    const entry: CustomProviderModelMeta = {};
    if (resolved.contextWindow !== undefined) entry.contextWindow = resolved.contextWindow;
    if (resolved.maxTokens !== undefined) entry.maxTokens = resolved.maxTokens;
    if (declared?.name !== undefined) entry.name = declared.name;
    if (declared?.reasoning !== undefined) entry.reasoning = declared.reasoning;
    if (declared?.input !== undefined) entry.input = [...declared.input];
    if (Object.keys(entry).length > 0) meta[modelId] = entry;
  }
  // Absent when neither the declaration nor the catalog states anything: the
  // synthesis then emits the bare `- id:` entry it has always emitted.
  if (Object.keys(meta).length > 0) declaration.models_meta = meta;
  return declaration;
}

/**
 * Build the runner exec env: harness paths + the App's verbatim model chain.
 * It carries NO credential — provider keys ride the stdin payload
 * (`buildRunnerCredentials`), never the process environment.
 */
function buildRunnerEnv(appCfg: RunnerAppConfig): Record<string, string> {
  const runnerEnv: Record<string, string> = {
    HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
  };
  // The App's verbatim chain forwards VERBATIM (the guard only decides
  // unset-vs-set; it never mutates the value; the runner-side selector parse
  // trims segments). A blank chain cannot reach production — the
  // assertAppConfigComplete gate fails the message before the guard. The
  // precedence lives in effectiveModelChain (ONE resolution shared with the
  // version-record put — no re-resolution split-brain).
  const { chain } = effectiveModelChain(appCfg);
  if (chain !== undefined) {
    runnerEnv.OMP_REVIEW_MODEL = chain;
  }
  return runnerEnv;
}

/**
 * Build the runner's credential transport: the versioned stdin payload
 * (packages/shared/src/credential-payload) plus the exact key VALUES it carries — the
 * SEC-01 exact-redaction list. ONE resolution serves both, so the recorded
 * secret list can never drift from the keys the session actually saw.
 *
 * Provider id (the App-config key space) → ordered pool, in store order: the
 * allowlisted BYOK ids first, then the App's custom declarations. Blank values
 * never ride, and a pool with none left is not transported at all. `payload`
 * is `undefined` when nothing was transported (the keyless run shape). Key
 * values live only in this payload and are never logged.
 */
function buildRunnerCredentials(
  appCfg: RunnerAppConfig,
  log?: AttemptLog,
  fields?: AttemptLogFields,
  customProviders?: readonly CustomProviderConsumerConfig[],
): { payload: string | undefined; keyValues: string[] } {
  // Log only when the caller supplied BOTH the sink and the identity fields
  // (the consumer flow does; direct unit calls may omit them).
  const emit = log !== undefined && fields !== undefined;
  const pools: CredentialPools = {};
  const keyValues: string[] = [];
  let appKeys = 0;
  const addPool = (provider: string, rawKeys: readonly string[], source: "app" | "custom"): number => {
    const keys = rawKeys.filter((key) => key.trim() !== "");
    if (keys.length === 0) return 0;
    pools[provider] = keys;
    keyValues.push(...keys);
    if (emit) {
      log.info(
        { ...fields, provider, key_source: source },
        `provider key pool from App config: ${provider} (${keys.length} key(s))`,
      );
    }
    return keys.length;
  };
  for (const [provider, keys] of Object.entries(appCfg.keys)) {
    if (providerEnvName(provider) === undefined) {
      if (emit) {
        log.warn(
          { ...fields, provider },
          "stored provider key id is not on the PROVIDERS allowlist — row skipped",
        );
      }
      continue;
    }
    appKeys += addPool(provider, keys, "app");
  }
  for (const decl of customProviders ?? []) {
    if (addPool(decl.provider_id, decl.api_keys, "custom") === 0 && emit) {
      log.warn(
        { ...fields, provider: decl.provider_id, key_source: "custom" },
        "custom provider key pool is empty — no keys transported",
      );
    }
  }
  if (emit) {
    const customCount = customProviders?.length ?? 0;
    log.info(
      { ...fields, config_source: "app" },
      `per-App credential payload: ${appKeys} provider key(s) from App config, ${customCount} custom` +
        `${effectiveModelChain(appCfg).chain !== undefined ? ", model chain from App config" : ""}`,
    );
  }
  return {
    payload: Object.keys(pools).length === 0 ? undefined : encodeCredentialPayload(pools),
    keyValues,
  };
}

/**
 * Exec-env names that are configuration/paths, not credentials — the only
 * values the runner exec env carries now that keys ride the stdin payload.
 */
const RUNNER_EXEC_ENV_PASSTHROUGH_NAMES: readonly string[] = [
  "OMP_REVIEW_MODEL",
  "HARNESS_PLUGIN_ROOT",
  "PI_CODING_AGENT_DIR",
];

/**
 * The ACTUAL secret values one review session carried (SEC-01 exact-value
 * defense): every provider key the credential payload transported — the values
 * a prompt-injected model could echo verbatim — plus the installation token
 * minted for the session. `redactExactSecrets` removes them even when they
 * evade every shape pattern. The key list is the SAME resolution the runner
 * exec used (no re-resolution split-brain).
 */
function sessionSecretValues(runnerEnv: Record<string, string>, keyValues: readonly string[], token: string): string[] {
  const values: string[] = [token, ...keyValues];
  for (const [name, value] of Object.entries(runnerEnv)) {
    if (RUNNER_EXEC_ENV_PASSTHROUGH_NAMES.includes(name)) continue;
    if (value !== "") values.push(value);
  }
  return values;
}

/** Characters of an exec's stderr tail carried by its failure message. */
export const STDERR_TAIL_MAX = 600;

/**
 * The runner stage's failure detail. stderr is the ONLY diagnosis a non-zero
 * exit carries (exit 124 = the exec bound fired, and the run leaves 0B of
 * stdout), so a redacted tail rides the message that reaches the durable
 * review_failures row and the log line. `stdout` is counted in UTF-8 bytes,
 * never in UTF-16 units. Redaction runs BEFORE the tail cut:
 * a secret sliced in half would survive the exact-value pass.
 */
function runnerFailureDetail(
  run: { stdout: string; stderr: string; exitCode: number },
  secretValues: readonly string[],
): string {
  // review_failures.error is unbounded TEXT (migration 0010), so the bounded
  // tail below cannot overflow the column.
  const base = `runner failed: exit ${run.exitCode}, stdout ${new TextEncoder().encode(run.stdout).length}B`;
  const tail = redactExactSecrets(redactSecrets(run.stderr), secretValues).trim().slice(-STDERR_TAIL_MAX);
  return tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
}

/**
 * Base64-encode UTF-8 text for the in-image JSON write step (workerd-safe).
 * Byte→char conversion is CHUNKED (qc3 F-303): a plain per-byte `+=` loop
 * is O(n²) and this sits in the worker hot path; 0x8000 chars per
 * `String.fromCharCode` call stays far below the engine arg-count cliff.
 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Acquire the attempt's container, mint its purpose-scoped read credential,
 * clone the PR head and resolve the AUTHORITATIVE checkout SHA. The caller's
 * failure path reads `progress.failureStage` and `progress.secretValues`, so
 * both are updated in place as the steps advance.
 */
export async function prepareReviewAttempt(input: {
  payload: ReviewJobPayload;
  deps: {
    env: { SANDBOX: unknown };
    getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  };
  commenter: Pick<ReviewCommenter, "getInstallationToken">;
  /** The attempt identity: the container is resolved by it. */
  attemptId: string;
  sandbox: ReviewSandbox | null;
  /**
   * The caller owns the container's lifetime (its finally destroys it), so it
   * learns the handle the moment it exists — a throw after acquisition must
   * not lose the only reference to a running container.
   */
  onSandbox: (sandbox: ReviewSandbox) => void;
  progress: ReviewAttemptProgress;
}): Promise<PreparedReviewAttempt> {
  const { payload, deps, commenter, attemptId, progress } = input;
  let sandbox = input.sandbox;
  // 1. Sandbox + installation token (created lazily; destroyed by the caller).
  // AL-6 stage window: container acquisition + every in-sandbox step below
  // (clone/rev-parse/diff/numstat/input-write) classify "sandbox" until the
  // runner step takes over. The installation-token mint is a GITHUB AUTH
  // call, not a sandbox step — it stays OUTSIDE the sandbox window so a
  // mint failure (bad App credentials, GitHub auth outage) records
  // stage "pipeline" and is never mis-tagged as a sandbox/infra failure.
  if (sandbox === null) {
    progress.failureStage = "sandbox";
    sandbox = await deps.getSandbox(deps.env.SANDBOX, attemptId);
    input.onSandbox(sandbox);
  }
  progress.failureStage = "pipeline";
  // Purpose-scoped sandbox read grant (§7.6 / RL-6): the mint is
  // repository-scoped read-only BY REQUEST, and the sandbox path only
  // proceeds on the RETURNED capabilities — assertSandboxGrant fails
  // closed on any broader grant (RL-6: the request is never presented as
  // proof of the response).
  const grant = await commenter.getInstallationToken({
    scope: {
      appId: payload.botRef.appId,
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
    },
    purpose: "sandbox-read",
  });
  assertSandboxGrant(grant, payload.repo);
  const token = grant.token;
  // SEC-01: seed the exact-value list with the minted token immediately —
  // a failure before the runner env is assembled (clone/diff/input steps)
  // still exact-redacts the token in the catch path.
  progress.secretValues = [token];
  progress.failureStage = "sandbox";
  const cmds = buildGitOpsCommands({
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
    cloneDir: CLONE_DIR,
    diffPath: DIFF_PATH,
  });

  // 2. Clone the PR head branch. Git transport auth via scoped extraheader
  // env (bugbot A1 — git ignores GH_TOKEN, so private-repo clones failed
  // without this; same pattern as the smoke-entry git fallback), built by
  // the ONE `gitTransportEnv` the oversized-diff fetch also uses. GH_TOKEN
  // stays for the gh steps below. Credentials are exec env only — never in
  // the command string, never in the image, never in logs.
  const clone = await sandbox.runCommand(cmds.clone, {
    env: gitTransportEnv(token),
    timeout: EXEC_TIMEOUT_GIT_MS,
  });
  if (clone.exitCode !== 0) {
    throw new Error(`clone failed: exit ${clone.exitCode}, stdout ${clone.stdout.length}B`);
  }

  // 3. AUTHORITATIVE sha: read the checked-out HEAD (bugbot A2). Everything
  // downstream — idempotency key, D1 row, posted commit_id, KV state — is
  // keyed off this sha, so diff/files/commit_id always describe the same
  // commit and a force-push mid-flight is captured here, not drifted.
  const rev = await sandbox.runCommand(cmds.checkedOutSha, { timeout: EXEC_TIMEOUT_GIT_MS });
  if (rev.exitCode !== 0 || rev.stdout.trim() === "") {
    throw new Error(`cannot resolve head sha: git exit ${rev.exitCode}, stdout ${rev.stdout.length}B`);
  }
  return { sandbox, token, cmds, headSha: rev.stdout.trim() };
}

/**
 * `runReviewAttempt` takes the prepared checkout, writes the runner input,
 * makes the blocking paid call at the attempt's absolute deadline and collects
 * the result documents. The caller's failure path reads the same
 * `progress` object, so a throw still carries the runner stage, its start
 * instant and the session's exact secret values.
 */
export async function runReviewAttempt(input: {
  deps: { log: AttemptLog };
  /** The absolute instant the exec is killed at (`anchorRunnerBudget`'s end). */
  deadlineMs: number;
  sandbox: ReviewSandbox;
  headSha: string;
  token: string;
  level: ReviewLevel;
  appCfg: RunnerAppConfig;
  fields: AttemptLogFields;
  reconFacts: readonly string[];
  modelOverrides: Record<string, string> | undefined;
  customProviders: readonly CustomProviderConsumerConfig[] | undefined;
  recheckInput: RecheckInput | undefined;
  recheckAssignmentMaxBytes: number | undefined;
  prContext: PrContext | undefined;
  runnerAnchor: RunnerBudgetAnchor;
  observedChangedLines: number | null;
  progress: ReviewAttemptProgress;
}): Promise<ReviewAttemptExecution> {
  const {
    deps,
    deadlineMs,
    sandbox,
    headSha,
    token,
    level,
    appCfg,
    fields,
    reconFacts,
    modelOverrides,
    customProviders,
    recheckInput,
    recheckAssignmentMaxBytes,
    prContext,
    runnerAnchor,
    observedChangedLines,
    progress,
  } = input;
  // The input carries the SAME absolute deadline every post-diff step bills —
  // the exec's own end instant, never a duration. The runner anchors its own
  // review deadline AT it, so the write's own window and the runner's parse
  // time both spend that deadline instead of each being added back onto it.
  const runnerInput = {
    worktreePath: CLONE_DIR,
    reconFacts,
    // No image-declared base provider: the per-review models.yml is the
    // App's own declarations, and built-in providers resolve from the
    // runtime's own catalog.
    capabilityHosts: [],
    // The absolute instant the exec below is killed at: the runner anchors
    // its own review deadline there, so a shortened round plans synthesis
    // inside the exec it runs under instead of the level's whole tier cap.
    outerDeadlineEpochMs: deadlineMs,
    ...(modelOverrides !== undefined ? { modelOverrides } : {}),
    ...(customProviders !== undefined
      ? { customProviders: customProviders.map(toRunnerCustomProvider) }
      : {}),
    // §7.8: the typed recheck input rides ONLY when open rows
    // exist — a first round with an empty lifecycle serializes
    // byte-identically to the pre-recheck payload.
    ...(recheckInput !== undefined ? { recheck: recheckInput } : {}),
    // The seat's ask budget: a top-level runner field, never part of the
    // frozen recheck document.
    ...(recheckAssignmentMaxBytes !== undefined ? { recheckAssignmentMaxBytes } : {}),
    // The report seat's untrusted input. Absent when gh could not answer,
    // so no report is attempted and the sections render `none`.
    ...(prContext !== undefined ? { prContext } : {}),
  };
  // The document rides the exec stdin pipe: as an argv string it became one
  // argument, and a recheck round above ~98 KiB breaches Linux's 128 KiB cap.
  // Serialization is paid BEFORE the write's one clock sample, so the armed
  // bound and the `124` attribution below both read the instant the write
  // actually started at — a straddling sample cannot arm the deadline's
  // shorter remainder and then classify its kill as the step cap's.
  const runnerInputStdin = toBase64Utf8(JSON.stringify(runnerInput));
  const inputWriteWindowMs = deadlineMs - Date.now();
  const writeInput = await sandbox.runCommand(writeJsonCommand(RUNNER_INPUT_PATH), {
    stdin: runnerInputStdin,
    timeout: boundedStepTimeout(
      deadlineMs,
      EXEC_TIMEOUT_GIT_MS,
      "runner input write",
      "runner",
      // The SAME sample both bounds the write and decides whether a `124`
      // was that bound's: two reads could disagree across the cap/deadline
      // crossover and retry a stop the clock already spent.
      deadlineMs - inputWriteWindowMs,
    ),
  });
  if (writeInput.exitCode !== 0) {
    // A kill under the anchored runner deadline (its remainder bound the
    // write, not the step's own cap) is the typed stop, not a generic
    // write error: the runner never started, so every observed counter is
    // KNOWN — provably 0/0 seats — and the attempt acks rather than paying
    // a queue retry for the same clock. A `124` the step's own cap fired
    // keeps the generic path: that kill was not the frozen deadline's.
    if (writeInput.exitCode === 124 && inputWriteWindowMs <= EXEC_TIMEOUT_GIT_MS) {
      throw new BudgetExhaustedError(
        {
          kind: "budget-exhausted",
          cause: "sandbox-kill",
          tier: level,
          budgetWindow: "runner",
          budgetMs: runnerAnchor.effectiveBudgetMs,
          seatsDispatched: 0,
          seatsStopped: 0,
          changedLines: observedChangedLines,
        },
        "runner input write killed at the anchored runner deadline",
      );
    }
    throw new Error(`runner input write failed: exit ${writeInput.exitCode}`);
  }

  // 4. In-image runner: cwd = clone dir; harness paths + the App's model
  // chain via exec env, and the App's own provider keys via the exec STDIN
  // credential payload (compass D, AL-24-5: per-App BYOK only, zero global
  // fallback; key_source app|custom logging; secrets never baked into the
  // image, never in logs, never in the process environment). The runtime
  // runner has NO summary-degrade path: exit 0 ⇒ stdout is the
  // engine-validated mstar.review/v1 envelope.
  // AL-6 stage window: the review run itself — a non-zero exit or an exec
  // exception (timeout / container error) here classifies "runner".
  progress.failureStage = "runner";
  progress.runnerStartedAt = Date.now();
  // SEC-01 exact-value defense: the SAME credential resolution the runner
  // exec used is captured here (single source — no re-resolution
  // split-brain) so the session's actual secret values can be
  // exact-redacted from any model-echoed output below.
  const runnerEnv = buildRunnerEnv(appCfg);
  const credentials = buildRunnerCredentials(appCfg, deps.log, fields, customProviders);
  // SEC-01 exact-value defense: the session's ACTUAL secret values (the
  // transported provider keys + the minted installation token) — needed by
  // the failure message below and shared by the degrade and success paths.
  progress.secretValues = sessionSecretValues(runnerEnv, credentials.keyValues, token);
  // §7.8: with a recheck input the runner gains `--recheck-out` — the seat
  // writes its validated document to the audited fixed path before the
  // envelope reaches stdout. `--report-out` rides whenever the report seat
  // has context to work with.
  const runnerCmd = runnerCommand(
    RUNNER_PATH,
    level,
    RUNNER_INPUT_PATH,
    recheckInput !== undefined ? RECHECK_OUTPUT_PATH : undefined,
    prContext !== undefined ? REPORT_OUTPUT_PATH : undefined,
  );
  // What that ONE absolute instant still owes, read HERE after the input
  // write consumed its window: the write and startup spend the deadline
  // instead of being added back onto it. A deadline the write finished is
  // declined explicitly, never started as a 1ms exec that fails for the
  // wrong cause. No tier clamp is re-applied — the derivation was the only.
  const runnerTimeout = deadlineMs - Date.now();
  if (runnerTimeout <= 0) {
    throw new RoundBudgetSpent(
      `round budget spent: runner declined — the exec deadline is spent (${runnerTimeout}ms left for it)`,
      "runner",
    );
  }
  const run = await sandbox.runCommand(runnerCmd, {
    cwd: CLONE_DIR,
    env: runnerEnv,
    // The credential payload rides the exec STDIN pipe — present only when
    // the App actually transported a key (keyless run shape = no stdin).
    ...(credentials.payload === undefined ? {} : { stdin: credentials.payload }),
    timeout: runnerTimeout,
  });
  const runnerElapsedMs = Date.now() - progress.runnerStartedAt;
  if (run.exitCode === 124) {
    // The sandbox's GNU-timeout wrapper killed the exec at the anchored
    // instant — the runner could not print its own signal, so neither seat
    // counts nor the stop instant are observable. `sandbox-kill` records
    // the frozen runner budget and leaves every counter null. The persisted
    // outcome carries only trusted budget fields plus fixed diagnostics:
    // provider stderr is untrusted text, so it rides one redacted log line
    // and never the durable row the outcome builds below.
    deps.log.warn(
      {
        ...fields,
        stderr_tail: redactExactSecrets(redactSecrets(run.stderr), progress.secretValues).slice(-STDERR_TAIL_MAX),
      },
      "runner exec killed at the anchored deadline (provider stderr on this line only)",
    );
    throw new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "sandbox-kill",
        tier: level,
        budgetWindow: "runner",
        budgetMs: runnerAnchor.effectiveBudgetMs,
        seatsDispatched: null,
        seatsStopped: null,
        changedLines: observedChangedLines,
      },
      `runner exec killed at its deadline: exit 124, stdout ${new TextEncoder().encode(run.stdout).length}B`,
    );
  }
  if (run.exitCode !== 0) {
    throw new Error(runnerFailureDetail(run, progress.secretValues));
  }
  // d5-budget AC-S10-logs: one runner attempt → at least one budget line
  // (level + runner_timeout_ms + elapsed_ms + orchestration). elapsed_ms is
  // VISIBILITY ONLY — it never throws; the sandbox exec timeout above is
  // the only wall-clock failure (spec 不 abort).
  deps.log.info(
    { ...fields, elapsed_ms: runnerElapsedMs },
    `runner finished in ${runnerElapsedMs}ms (budget ${runnerTimeout}ms)`,
  );

  // The ONE typed terminal outcome outside the verdict envelope (spec §
  // Exhaustion): the runner declared the round's wall clock spent and
  // stopped review work BEFORE its own deadline fired — the signal is the
  // outcome, not model content, so a malformed one is still a parse
  // degrade below. It resolves before any verdict parsing and before the
  // post-runner publication steps it made un-runnable; the single catch
  // publishes it. failureStage stays "runner" for the row.
  const budgetSignal = parseBudgetExhaustedSignal(run.stdout);
  if (budgetSignal.ok) {
    throw new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "runner-deadline",
        tier: level,
        budgetWindow: "runner",
        budgetMs: runnerAnchor.effectiveBudgetMs,
        seatsDispatched: budgetSignal.signal.seatsDispatched,
        seatsStopped: budgetSignal.signal.seatsStopped,
        changedLines: observedChangedLines,
      },
      `runner signalled budget exhaustion (seats ${budgetSignal.signal.seatsStopped}/${budgetSignal.signal.seatsDispatched})`,
    );
  }

  // AL-6 stage window: post-runner steps (parse has its own branch; the
  // post/KV/put orchestration is worker-side) are "pipeline" again.
  progress.failureStage = "pipeline";

  // §7.7 step 5 (cont): read the concurrent recheck seat's document AND its
  // status through the audited fixed-path bounded reads (§7.3: Worker
  // validates against ITS OWN trusted input — never a model echo). Anything
  // other than a valid document is NO recheck; the round proceeds with every
  // selected row conservatively accounted (§7.4), and the seat's status makes
  // that loss attributable in D1. Rows the gate dropped are carried as
  // rejected — by rowId when it had one, by position among the unanswered
  // sent rows when it did not — so they are never mistaken for rows the seat
  // never reached.
  const recheck = recheckInput !== undefined ? await readRecheckDoc(sandbox, recheckInput) : null;

  // The report document (mstar.report/v1) rides the SAME audited bounded read
  // and the SAME fail-closed rule: the Worker validates it against its own
  // gate and falls back to `none` headings, or null when the seat wrote
  // nothing. Read only when the runner was actually given `--report-out`.
  const report: ReportDoc | null =
    prContext !== undefined
      ? await readReportDoc(sandbox, progress.secretValues, headSha, deps.log, fields)
      : null;

  // Which provider actually served — the runner's own observation, projected
  // here and NOWHERE derived again. null = the runner reported none (no model
  // served), which stays null on the row; it is never replaced with the chain
  // head, because that would report the configured first selector as if it
  // had run.
  const appliedProvider = await readAppliedProvider(sandbox, progress.secretValues, deps.log, fields);

  return { run, recheck, report, appliedProvider };
}
