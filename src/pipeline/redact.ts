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

// why: a value shorter than a credential cannot be redacted safely — it would
// match ordinary text (and a 3-char secret matches inside a SHA).
const MIN_SECRET_LENGTH = 8;

// why: these are host-written identity fields, not model output; rewriting one
// (e.g. `head_sha`) turns a valid row into an unreadable one. Skipped by name at
// every depth, `headSha` being the report wire's spelling of the same field.
const IDENTITY_KEYS: Record<string, true> = {
  head_sha: true,
  headSha: true,
  attempt_id: true,
  run_id: true,
  launch_id: true,
  check_key: true,
  generation: true,
};

/**
 * The BOUNDED transform set of one secret: the forms a session can echo when it
 * encodes a credential it holds. JSON escaping is NOT here — the envelope is
 * parsed before matching, so `\u002f`, `\/` and `\n` are already decoded.
 */
export type SecretTransforms = {
  raw: string;
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
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return {
    raw: secret,
    urlEncoded: encodeURIComponent(secret),
    base64,
    base64url: base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    hex: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** How many credential values were applied and how many were refused. */
export type RedactionOutcome<T> = {
  value: T;
  /** Occurrences replaced across every string leaf. */
  replaced: number;
  /** Credential values not applied: too short, or ambiguous with the marker. */
  skipped: number;
};

/** Mutable counters one walk threads through its leaves. */
type RedactionState = { replaced: number };

/**
 * The forms the walk may replace, longest first, plus how many credential
 * values were refused. Two refusals, both visible to the caller:
 * a value shorter than `MIN_SECRET_LENGTH` (it would match ordinary text), and
 * a value that OVERLAPS the marker (`redacted`, `[redacted]`) — replacing it
 * would rewrite the marker, so a second pass would not be a no-op.
 */
function applicableForms(secrets: readonly string[]): { forms: string[]; skipped: number } {
  const forms = new Set<string>();
  let skipped = 0;
  for (const secret of new Set(secrets)) {
    if (secret === "") continue;
    if (secret.length < MIN_SECRET_LENGTH) {
      skipped += 1;
      continue;
    }
    // The idempotence rule, stated once: skip a value whose bytes touch the
    // marker, in EITHER direction.
    if (secret.includes(TRANSFORMED_REDACTED) || TRANSFORMED_REDACTED.includes(secret)) {
      skipped += 1;
      continue;
    }
    for (const form of Object.values(secretTransforms(secret))) {
      // Same reasoning per form: a form that touches the marker cannot be
      // replaced without corrupting it.
      if (form === "" || form.includes(TRANSFORMED_REDACTED) || TRANSFORMED_REDACTED.includes(form)) continue;
      forms.add(form);
    }
  }
  // A shorter form that is a substring of a longer one must not shred the
  // longer match first.
  return { forms: [...forms].sort((left, right) => right.length - left.length), skipped };
}

/**
 * Replace every occurrence of every transform of every applicable credential in
 * the DECODED string leaves of `value`, with a fixed `[redacted]` token.
 *
 * A JSON object/array string leaf is an envelope: it is parsed first, so an
 * echo the model escaped (`\u002f`, `\/`, `\n`) is already the raw character
 * before matching, and the result is serialized again. Replacing inside decoded
 * leaves is what keeps a credential from ever matching a JSON quote or an
 * identity field's bytes. An envelope with no match keeps its original bytes.
 *
 * Rules, all load-bearing:
 * - non-string leaves pass through by identity;
 * - `IDENTITY_KEYS` are skipped by name at every depth (host-written, not model
 *   output — rewriting one turns a valid row invalid);
 * - values shorter than `MIN_SECRET_LENGTH` are skipped, and the count is
 *   returned in `skipped` so the caller can say so;
 * - a value that contains or is contained in the marker is skipped, which is
 *   what makes `redactTransformed` idempotent.
 *
 * Shape patterns (`redactSecrets`) stay OUT: their long-hex rule rewrites the
 * envelope's `head_sha`.
 */
// limit: a credential split across two leaves, or one the model double-escaped (it decodes to literal `\uXXXX` text), is missed.
export function redactTransformed<T>(value: T, secrets: readonly string[]): RedactionOutcome<T> {
  const applicable = applicableForms(secrets);
  const state: RedactionState = { replaced: 0 };
  const redacted =
    applicable.forms.length === 0 ? value : (redactValue(value, applicable.forms, state) as T);
  return { value: redacted, replaced: state.replaced, skipped: applicable.skipped };
}

function redactValue(value: unknown, forms: readonly string[], state: RedactionState): unknown {
  if (typeof value === "string") return redactLeaf(value, forms, state);
  // A Set is not walked by `Object.entries`: `attempt.recheck.rejected` is one.
  if (value instanceof Set) return new Set([...value].map((item) => redactValue(item, forms, state)));
  if (Array.isArray(value)) return value.map((item) => redactValue(item, forms, state));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        IDENTITY_KEYS[key] === true ? item : redactValue(item, forms, state),
      ]),
    );
  }
  return value;
}

/** Redact one string leaf; re-serialize an envelope only when it changed. */
function redactLeaf(text: string, forms: readonly string[], state: RedactionState): string {
  const envelope = parseEnvelope(text);
  if (envelope === undefined) return replaceForms(text, forms, state);
  const before = state.replaced;
  const redacted = redactValue(envelope, forms, state);
  // Untouched envelopes keep their exact bytes: no reformatting, no key moves.
  return state.replaced === before ? text : JSON.stringify(redacted);
}

/** The parsed value of a JSON object/array leaf, or `undefined` for anything else. */
function parseEnvelope(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function replaceForms(text: string, forms: readonly string[], state: RedactionState): string {
  let out = text;
  for (const form of forms) {
    const parts = out.split(form);
    if (parts.length === 1) continue;
    state.replaced += parts.length - 1;
    out = parts.join(TRANSFORMED_REDACTED);
  }
  return out;
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
