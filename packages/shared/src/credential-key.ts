/**
 * The one rule both credential boundaries share: a provider KEY VALUE must
 * never look like a config COMMAND VALUE.
 *
 * The pinned omp SDK treats a config value starting with `!` as a command:
 * `isCommandConfigValue` (pi-coding-agent/src/config/resolve-config-value.ts)
 * matches the prefix and `executeCommand` runs the remainder through
 * `ptree.exec(["/bin/sh", "-c", command], …)`. `ModelRegistry` installs that
 * resolver over the credential store (`authStorage.setConfigValueResolver(
 * resolveConfigValue)`), and a stored `source: "login"` api_key is handed to
 * it verbatim — so a transported key of that shape is executed as a shell
 * command inside the review container by the session's own credential
 * resolver. Execution is SELECTION-dependent, not guaranteed on the first
 * request: the resolver caches a successful value and backs off 30s after a
 * failure, and it only runs when the runtime actually selects that login
 * credential. The execution capability itself is unconditional, which is what
 * this rule closes.
 *
 * A provider key is DATA, never a config value, so both boundaries refuse the
 * shape:
 *
 *   - the runner's payload decoder (`packages/shared/src/credential-payload.ts`)
 *     — the hard fail-closed gate, BEFORE any credential row is written;
 *   - the dashboard's key routes (`src/dashboard/index.ts`) — a keyed 400 where
 *     the operator typed it, instead of a failed review run later.
 *
 * Zero-dependency by construction: this file is admitted into the in-image
 * runner graph (sandbox-image/omp/Dockerfile COPYs it beside
 * packages/shared/src/recheck-wire.ts) and is consumed by the Worker faces, so
 * it must keep importing nothing (tests/review/runtime-boundary.test.ts asserts
 * that for every admitted contract file).
 */

/** The prefix the SDK's config-value resolver reads as "run this as a command". */
export const COMMAND_CONFIG_KEY_PREFIX = "!";

/**
 * Whether a credential value would be resolved as a shell command by the
 * installed SDK's config-value resolver. The rule is the SDK's own
 * (`valueConfig?.startsWith("!") === true`, mirrored so no caller restates the
 * literal) — a value that trips it is refused, never trimmed, escaped or
 * rewritten: the value is key material and its bytes are not ours to edit.
 */
export function isCommandConfigKey(value: string): boolean {
  return value.startsWith(COMMAND_CONFIG_KEY_PREFIX);
}
