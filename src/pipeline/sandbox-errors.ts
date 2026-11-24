/**
 * The sandbox boundary's error leaf. It imports nothing from the Worker on
 * purpose: the Durable Object module links `cloudflare:workers` at module-link
 * time, so a caller that only needs to CLASSIFY an outcome (the pipeline, the
 * Workflows host, any suite) must be able to name the class without linking a
 * container binding. Same reason `./shell-command` is its own dependency-free
 * leaf.
 *
 * The exception-cause sanitizer lives here for the same reason: `sandbox.ts`
 * (which links the container) and `review-attempt.ts` (which must not) both
 * turn an arbitrary thrown value into the ONE bounded cause string a failure
 * message and a log field may carry.
 */
import { REDACTED, redactSecretShapes } from "../../packages/shared/src/secret-shapes";

/**
 * A command was addressed to a slot that is not running. Transient by nature:
 * only `provision` may start a container, so the caller's retry re-provisions.
 */
export class ContainerNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerNotRunningError";
  }
}

/** Characters of an exec cause the failure message and log field keep. */
const EXEC_CAUSE_MAX_CHARS = 300;

/** Error names are a fixed vocabulary; anything longer is attacker-controlled. */
const CAUSE_NAME_MAX_CHARS = 40;

/** Shorter values are ordinary words, not credentials; redacting them would gut every message. */
const CAUSE_MIN_SENSITIVE_CHARS = 4;

/** Depth and node bounds for walking a stdin JSON payload. */
const STDIN_WALK_DEPTH = 8;
const STDIN_WALK_NODES = 2_000;

/** An error name is a fixed vocabulary; only these characters are ever emitted. */
const CAUSE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/;

/**
 * The values one exec carries that its own exception text must never echo —
 * plus whether that collection is COMPLETE. A walk that stopped at its own
 * depth/node bound leaves values nobody can name, so a message cannot be
 * proven clean and `execCause` must degrade instead of guessing.
 */
export type ExecSensitiveSet = {
  readonly values: readonly string[];
  readonly complete: boolean;
};

/**
 * The values one exec carries that its own exception text must never echo:
 * the shell command (whose interpolated values are the point), every command
 * token WITH and without its surrounding quotes (a platform error echoes the
 * argument, not the quoting), every env value, the stdin payload, and every
 * string leaf of that payload — the credential transport is base64 JSON, and a
 * provider key echoed by a platform error has no recognizable shape of its own.
 *
 * A stdin payload that is not a document makes the whole collection UNPROVABLE:
 * splitting it into tokens is not a parser and cannot establish its sensitive
 * values, so no message built from it can be proven clean.
 */
export function execSensitiveValues(
  command: string,
  opts?: { env?: Record<string, string>; stdin?: string },
): ExecSensitiveSet {
  const values = [command];
  for (const token of command.split(/\s+/)) {
    values.push(token);
    // `--token 'value'` is reported as `value`; keep both spellings.
    const unquoted = token.replace(/^['"]+|['"]+$/g, "");
    if (unquoted !== token) values.push(unquoted);
  }
  for (const value of Object.values(opts?.env ?? {})) values.push(value);
  const stdin = opts?.stdin;
  let complete = true;
  if (stdin !== undefined && stdin !== "") {
    values.push(stdin);
    const decoded = decodedStdin(stdin);
    if (decoded === undefined) {
      // Not a document, so no leaf can be named and the payload is UNPROVABLE:
      // whatever the boundary could split out of it is not its set of sensitive
      // values, so the whole collection is marked incomplete and the cause
      // degrades. The raw text still rides along as one value.
      complete = false;
    } else {
      complete = collectStrings(decoded, values);
    }
  }
  return { values: values.filter((value) => value.length >= CAUSE_MIN_SENSITIVE_CHARS), complete };
}

function decodedStdin(stdin: string): unknown {
  // The runner-input write carries base64; the credential transport writes the
  // JSON straight to the pipe. Either way the leaves are key material.
  try {
    return JSON.parse(stdin);
  } catch {
    try {
      return JSON.parse(atob(stdin));
    } catch {
      // Not a document: no leaf can be named, so the caller marks the whole
      // collection unprovable.
      return undefined;
    }
  }
}

function collectStrings(value: unknown, into: string[], depth = 0, budget = { nodes: STDIN_WALK_NODES }): boolean {
  if (budget.nodes <= 0 || depth > STDIN_WALK_DEPTH) return false;
  budget.nodes -= 1;
  if (typeof value === "string") {
    into.push(value);
    return true;
  }
  if (Array.isArray(value)) {
    let complete = true;
    for (const item of value) complete = collectStrings(item, into, depth + 1, budget) && complete;
    return complete;
  }
  if (value !== null && typeof value === "object") {
    let complete = true;
    for (const item of Object.values(value)) complete = collectStrings(item, into, depth + 1, budget) && complete;
    return complete;
  }
  return true;
}

/**
 * The message only when it is PROVABLY safe: single-line (a stack frame starts
 * at the first newline, so everything from there is dropped, not collapsed),
 * free of every collected value after removal, and free of secret shapes that
 * the removal could not name. `null` means "cannot be proven" — the caller
 * degrades rather than emit it.
 */
function cleanCauseMessage(raw: string, sensitive: ExecSensitiveSet): string | null {
  if (!sensitive.complete) return null;
  const firstLine = raw.split(/\r?\n/, 1)[0]!.trim();
  if (firstLine === "") return null;
  let out = firstLine;
  for (const value of sensitive.values) out = out.split(value).join(REDACTED);
  out = redactSecretShapes(out).replace(/\s+/g, " ").trim();
  if (out === "") return null;
  // A value that survived removal means this message cannot be made safe.
  if (sensitive.values.some((value) => out.includes(value))) return null;
  return out;
}

/**
 * Error names come from a fixed vocabulary; anything else is attacker text. A
 * character pattern alone is not that vocabulary: `providerkey9a1fbc` is
 * pattern-clean and still a credential. So the name is held to the SAME proof
 * as the message — no collected value, no secret shape — and degrades to
 * `Error` otherwise. Never echoed, never guessed.
 */
function safeCauseName(raw: unknown, sensitive: ExecSensitiveSet): string {
  if (typeof raw !== "string" || raw.length > CAUSE_NAME_MAX_CHARS) return "Error";
  if (!sensitive.complete) return "Error";
  if (!CAUSE_NAME_PATTERN.test(raw)) return "Error";
  if (redactSecretShapes(raw) !== raw) return "Error";
  if (sensitive.values.some((value) => raw.includes(value))) return "Error";
  return raw;
}

/**
 * The evidence a thrown exec leaves behind, bounded for a log field and a
 * failure row: error name, sanitized message, and how long the exec had been
 * open. No stack, no command text, no env value, no credential.
 *
 * FAIL CLOSED: the message is kept only when its safety is established, so the
 * cause degrades to `<name> (after <n>ms)` whenever it is not. The elapsed
 * suffix is reserved BEFORE truncation, so a long message can never cost the one
 * measurement that diagnoses a lost reply.
 */
export function execCause(err: unknown, openedAtMs: number, sensitive: ExecSensitiveSet): string {
  const rawName = err instanceof Error ? err.name : typeof err;
  const name = safeCauseName(rawName === "" ? "Error" : rawName, sensitive);
  const suffix = ` (after ${Math.max(0, Date.now() - openedAtMs)}ms)`;
  const message = cleanCauseMessage(err instanceof Error ? err.message : String(err), sensitive);
  const room = EXEC_CAUSE_MAX_CHARS - name.length - 2 - suffix.length;
  if (message === null || room <= 0) return `${name}${suffix}`;
  return `${name}: ${message.slice(0, room)}${suffix}`;
}
