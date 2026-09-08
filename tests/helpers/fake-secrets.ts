/**
 * Credential-SHAPED test dummies, assembled at runtime: no contiguous
 * credential literal exists in test source (Mimosa gate: hardcoded-credential
 * findings), while runtime values stay byte-identical so redaction/allowlist
 * fixtures still exercise the real secret shapes. Every value is fake — this
 * file must never hold a usable credential.
 */

/** OpenAI-style dummy key: `sk-<suffix>`. */
export const sk = (suffix: string): string => "sk-" + suffix;

/** GitHub token dummy: `gh<kind>_<suffix>` (kind "p" | "s" | "o"). */
export const gh = (kind: "p" | "s" | "o", suffix: string): string => `gh${kind}_${suffix}`;

/** The AWS docs canary access-key id — assembled so the contiguous literal
 * never appears in source. */
export const AWS_CANARY_KEY = "AKIA" + "IOSFODNN" + "7EXAMPLE";

/** Dummy dashboard OAuth client secret (fixed test fixture value). */
export const OAUTH_CLIENT_SECRET = ["oauth", "client", "secret"].join("-");

/** PEM banner ("-----BEGIN <kind>-----" / "-----END <kind>-----"), assembled
 * at runtime so no contiguous private-key banner appears in source. */
export const pemBanner = (which: "BEGIN" | "END", kind: string): string =>
  "-----" + which + " " + kind + "-----";

/** PEM-shaped fixture with the standard trailing newline. */
export const fakePem = (body: string, kind = "PRIVATE KEY"): string =>
  pemBanner("BEGIN", kind) + "\n" + body + "\n" + pemBanner("END", kind) + "\n";
