/**
 * ShellCommand brand (scanner CWE-78 boundary, qc2 F-001) — the type-level
 * gate between raw strings and the sandbox shell sink. A raw `string` —
 * webhook/HTTP-derived or otherwise unvalidated — is a type error at
 * `ReviewSandbox.runCommand`: only the validated pipeline/gitops.ts builders
 * (allowlist + fail-closed + single-quote discipline before any shell string
 * exists) and audited in-repo constants mint the brand via `shellCommand()`.
 *
 * Deliberately dependency-free (no SDK import) so pure-builder tests and the
 * review runtime can import it without pulling the @cloudflare/sandbox graph.
 */

declare const shellCommandBrand: unique symbol;

/** A shell command cleared for the sandbox sink. */
export type ShellCommand = string & { readonly [shellCommandBrand]: true };

/**
 * Mint a ShellCommand. Call ONLY after the value passed a builder's
 * allowlist validation or is an in-repo constant — this is the single
 * audit chokepoint between arbitrary strings and the shell sink.
 */
export function shellCommand(validated: string): ShellCommand {
  return validated as ShellCommand;
}
