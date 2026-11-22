
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
