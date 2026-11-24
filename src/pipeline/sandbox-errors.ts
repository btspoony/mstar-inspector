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
export const EXEC_CAUSE_MAX_CHARS = 300;

/** Error names are a fixed vocabulary; anything longer is attacker-controlled. */
const CAUSE_NAME_MAX_CHARS = 40;

/** Shorter values are ordinary words, not credentials; redacting them would gut every message. */
const CAUSE_MIN_SENSITIVE_CHARS = 4;

/** Depth and node bounds for walking a stdin JSON payload. */
const STDIN_WALK_DEPTH = 8;
const STDIN_WALK_NODES = 2_000;

/**
 * The values one exec carries that its own exception text must never echo:
 * the shell command (whose interpolated values are the point), every env value,
 * the stdin payload, and every string leaf of that payload — the credential
 * transport is base64 JSON, and a provider key echoed by a platform error has
 * no recognizable shape of its own.
 */
export function execSensitiveValues(
  command: string,
  opts?: { env?: Record<string, string>; stdin?: string },
): string[] {
  const values = [command];
  for (const token of command.split(/\s+/)) values.push(token);
  for (const value of Object.values(opts?.env ?? {})) values.push(value);
  const stdin = opts?.stdin;
  if (stdin !== undefined && stdin !== "") {
    values.push(stdin);
    collectStrings(decodedStdin(stdin), values);
  }
  return values.filter((value) => value.length >= CAUSE_MIN_SENSITIVE_CHARS);
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
      // Not a document: the raw string is all this boundary can name, and it is
      // already in the list.
      return undefined;
    }
  }
}

function collectStrings(value: unknown, into: string[], depth = 0, budget = { nodes: STDIN_WALK_NODES }): void {
  if (budget.nodes <= 0 || depth > STDIN_WALK_DEPTH) return;
  budget.nodes -= 1;
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, depth + 1, budget);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into, depth + 1, budget);
  }
}

/**
 * Remove every known value and secret shape, then collapse every whitespace run
 * (a stack trace, a multi-line command dump) to one space.
 */
function cleanCauseMessage(raw: string, sensitive: readonly string[]): string {
  let out = raw;
  for (const value of sensitive) out = out.split(value).join(REDACTED);
  return redactSecretShapes(out).replace(/\s+/g, " ").trim();
}

/**
 * The evidence a thrown exec leaves behind, bounded for a log field and a
 * failure row: error name, sanitized message, and how long the exec had been
 * open. No stack, no command text, no env value, no credential.
 *
 * The elapsed suffix is reserved BEFORE the message is truncated, so a long
 * message can never cost the one measurement that diagnoses a lost reply. A
 * message that cannot be proven safe is dropped entirely: the cause degrades to
 * `<name> (after <n>ms)` instead of echoing anything.
 */
export function execCause(err: unknown, openedAtMs: number, sensitive: readonly string[]): string {
  const rawName = err instanceof Error ? err.name : typeof err;
  const name = (rawName === "" ? "Error" : rawName).slice(0, CAUSE_NAME_MAX_CHARS);
  const suffix = ` (after ${Math.max(0, Date.now() - openedAtMs)}ms)`;
  const message = cleanCauseMessage(err instanceof Error ? err.message : String(err), sensitive);
  const room = EXEC_CAUSE_MAX_CHARS - name.length - 2 - suffix.length;
  if (message === "" || room <= 0) return `${name}${suffix}`;
  const kept = message.slice(0, room);
  // A value that survived sanitization means this message cannot be made safe.
  if (sensitive.some((value) => kept.includes(value))) return `${name}${suffix}`;
  return `${name}: ${kept}${suffix}`;
}
