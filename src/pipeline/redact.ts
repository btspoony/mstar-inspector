/**
 * Secret redaction for model-produced text (Phase 5 B2 / SEC-02) — pure,
 * unit-tested. The review session can be prompt-injected into echoing
 * secrets (provider keys,
 * installation tokens, PEM material) into ANY model-controlled envelope
 * string — summary_md, finding title/body/category/file_path/fingerprint_hint,
 * tally chatHeader. Everything that can reach the PUBLIC PR review comment
 * or the D1 envelope passes through here first (consumer choke point,
 * applied before postReview and insertReview).
 *
 * Redaction is intentionally conservative: an over-redacted phrase in a
 * finding body is acceptable; a leaked token is not.
 */

import { REDACTED, redactSecretShapes } from "../../packages/shared/src/secret-shapes";
import type { ReviewOutput } from "../review/schema";

/** Redaction marker, owned by the canonical pattern module. */
export { REDACTED };

/**
 * Replace every secret-shaped span in `text` with `[REDACTED]`. The patterns
 * are the canonical `packages/shared` list — the same one the sandbox runner
 * applies to its recheck status error, so a shape redacted here is redacted
 * there.
 */
export function redactSecrets(text: string): string {
  return redactSecretShapes(text);
}

/**
 * Exact-value redaction (SEC-01 defense-in-depth): replace every occurrence
 * of each distinct non-empty value with `[REDACTED]`. This is the strongest
 * defense — a credential that evades every shape pattern (e.g. a UUID-ish
 * key) is still removed verbatim. Returns `text` unchanged when `values` is
 * empty. Callers pass the ACTUAL secret values the session used (runner env
 * provider keys + the minted installation token).
 */
export function redactExactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of new Set(values)) {
    if (value === "") continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Marker replacing every transformed occurrence of a secret. */
const TRANSFORMED_REDACTED = "[redacted]";

/**
 * The BOUNDED transform set of one secret: the forms a session can echo when it
 * reflects a credential it holds back through a serialization step. Anything
 * outside this list stays unredacted (see `redactTransformed`'s limit line).
 */
export type SecretTransforms = {
  raw: string;
  /** `JSON.stringify` escaping: `"`→`\"`, `\`→`\\`, controls→`\n`/`\uXXXX`. */
  jsonEscaped: string;
  /** The same escaping with `/` as `\/` (legal JSON; `JSON.stringify` omits it). */
  slashEscaped: string;
  /** Every UTF-16 code unit as `\uXXXX` (surrogate pairs included). */
  unicodeEscaped: string;
  urlEncoded: string;
  base64: string;
  /** RFC 4648 §5: `-`/`_` alphabet, padding stripped. */
  base64url: string;
  hex: string;
};

/** The transforms of one secret. Pure; the transform set IS this function. */
export function secretTransforms(secret: string): SecretTransforms {
  const bytes = new TextEncoder().encode(secret);
  let binary = "";
  let unicodeEscaped = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  for (let index = 0; index < secret.length; index += 1) {
    unicodeEscaped += `\\u${secret.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  const base64 = btoa(binary);
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  return {
    raw: secret,
    jsonEscaped,
    slashEscaped: jsonEscaped.replaceAll("/", "\\/"),
    unicodeEscaped,
    urlEncoded: encodeURIComponent(secret),
    base64,
    base64url: base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    hex: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** Every distinct non-empty form of every secret, longest first. */
function transformedForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  const add = (form: string): void => {
    if (form === "") return;
    forms.add(form);
    // A JSON text leaf (the runner's stdout) escapes the escape itself: the
    // `\/` a model printed is stored as `\\/`, `\uXXXX` as `\\uXXXX`.
    forms.add(JSON.stringify(form).slice(1, -1));
  };
  for (const secret of new Set(secrets)) {
    if (secret === "") continue;
    for (const form of Object.values(secretTransforms(secret))) add(form);
  }
  // A shorter form that is a substring of a longer one must not shred the
  // longer match first.
  return [...forms].sort((left, right) => right.length - left.length);
}

/**
 * Replace every occurrence of every transform of every secret in the STRING
 * LEAVES of `value` with a fixed `[redacted]` token. Arrays, Sets and plain
 * objects are walked; numbers, booleans, null and every other non-string leaf
 * pass through by identity. Structure, keys and serialization order are
 * preserved, so an envelope's identity fields stay byte-identical.
 *
 * Idempotent by construction: the token is not a transform of any realistic
 * credential, so a second pass finds nothing.
 *
 * Shape patterns (`redactSecrets`) stay OUT of this pass: their long-hex rule
 * rewrites the envelope's `head_sha` and turns a valid row unreadable.
 */
// limit: a secret split across two leaves, or a form outside `SecretTransforms`, is missed.
export function redactTransformed<T>(value: T, secrets: readonly string[]): T {
  const forms = transformedForms(secrets);
  return forms.length === 0 ? value : redactValue(value, forms);
}

function redactValue<T>(value: T, forms: readonly string[]): T {
  if (typeof value === "string") {
    let out: string = value;
    for (const form of forms) out = out.split(form).join(TRANSFORMED_REDACTED);
    return out as T;
  }
  // A Set is not walked by `Object.entries`: `attempt.recheck.rejected` is one.
  if (value instanceof Set) return new Set([...value].map((item) => redactValue(item, forms))) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, forms)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, forms)]),
    ) as T;
  }
  return value;
}

/** The model-controlled `incomplete` fact (declared cause + unscanned scope). */
type IncompleteFact = NonNullable<ReviewOutput["incomplete"]>;

/**
 * Redact one `incomplete` fact (qc2 F-001): `reason` and every `unscanned`
 * entry are model-controlled and reach the public review comment and the D1
 * envelope, so both redaction passes rewrite them. Structure is preserved —
 * entries keep their order and count, and an empty list stays empty.
 */
const redactIncompleteFact = (
  fact: IncompleteFact,
  redact: (text: string) => string,
): IncompleteFact => ({
  reason: redact(fact.reason),
  unscanned: fact.unscanned.map(redact),
});

/**
 * Redact EVERY model-controlled string of a ReviewOutput (qc2 F-001): not
 * only summary_md and the finding bodies, but also each finding's title,
 * category, file_path, fingerprint_hint and the tally chatHeader — all of
 * them reach the public review comment body and/or the D1 envelope, so all
 * of them pass the SEC-02 choke point. Structural fields (mergeClass,
 * verdict, line numbers, counts) are engine-vocabulary, not model text.
 */
export function redactReviewOutput(output: ReviewOutput): ReviewOutput {
  return {
    ...output,
    ...(output.summary_md === undefined ? {} : { summary_md: redactSecrets(output.summary_md) }),
    ...(output.incomplete === undefined
      ? {}
      : { incomplete: redactIncompleteFact(output.incomplete, redactSecrets) }),
    ...(output.tally === undefined
      ? {}
      : {
          tally: {
            ...output.tally,
            chatHeader: redactSecrets(output.tally.chatHeader),
            ...(output.tally.incomplete === undefined
              ? {}
              : { incomplete: redactIncompleteFact(output.tally.incomplete, redactSecrets) }),
          },
        }),
    findings: output.findings.map((finding) => ({
      ...finding,
      title: redactSecrets(finding.title),
      body: redactSecrets(finding.body),
      // Conditional spreads keep ABSENT optional fields absent (no
      // `key: undefined` materialization on the envelope).
      ...(finding.category === undefined ? {} : { category: redactSecrets(finding.category) }),
      ...(finding.file_path == null ? {} : { file_path: redactSecrets(finding.file_path) }),
      ...(finding.fingerprint_hint === undefined
        ? {}
        : { fingerprint_hint: redactSecrets(finding.fingerprint_hint) }),
    })),
  };
}

/**
 * Exact-value second pass over a ReviewOutput (SEC-01): after
 * redactReviewOutput's shape-based pass, replace the ACTUAL secret values
 * the session used (runner env provider keys + the minted installation
 * token) in every model-controlled string. A credential that evades every
 * shape pattern is still removed verbatim before the output reaches the
 * public review body or the D1 envelope. Structural fields are untouched.
 */
export function redactReviewOutputExact(output: ReviewOutput, values: readonly string[]): ReviewOutput {
  return {
    ...output,
    ...(output.summary_md === undefined ? {} : { summary_md: redactExactSecrets(output.summary_md, values) }),
    ...(output.incomplete === undefined
      ? {}
      : { incomplete: redactIncompleteFact(output.incomplete, (text) => redactExactSecrets(text, values)) }),
    ...(output.tally === undefined
      ? {}
      : {
          tally: {
            ...output.tally,
            chatHeader: redactExactSecrets(output.tally.chatHeader, values),
            ...(output.tally.incomplete === undefined
              ? {}
              : {
                  incomplete: redactIncompleteFact(output.tally.incomplete, (text) =>
                    redactExactSecrets(text, values),
                  ),
                }),
          },
        }),
    findings: output.findings.map((finding) => ({
      ...finding,
      title: redactExactSecrets(finding.title, values),
      body: redactExactSecrets(finding.body, values),
      ...(finding.category === undefined ? {} : { category: redactExactSecrets(finding.category, values) }),
      ...(finding.file_path == null ? {} : { file_path: redactExactSecrets(finding.file_path, values) }),
      ...(finding.fingerprint_hint === undefined
        ? {}
        : { fingerprint_hint: redactExactSecrets(finding.fingerprint_hint, values) }),
    })),
  };
}
