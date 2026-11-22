/**
 * note: Secret redaction for model-produced text (Phase 5 B2 / SEC-02) — pure,
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

/** safety: Regex metacharacters, escaped so a credential form matches literally. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

// why: a value this short cannot be distinguished from ordinary text (`mstar`
// inside `mstar.review/v1`), so its only safe match is an exact one.
const SUBSTRING_MIN_LENGTH = 8;

/** A retained document whose host-written identity paths are protected. */
export type RetainedDocument = "run" | "recheck" | "report" | "text";

/**
 * safety: The identity paths, per document. Protection is STRUCTURAL — by position, not
 * by key name — because a key name is model-forgeable: through this table a
 * value under `target.head_sha` is host-written, while the same text nested
 * inside `summary_md` is model output and stays redactable.
 *
 * `*` matches any array index. A path that is absent is simply absent.
 */
const IDENTITY_PATHS: Record<RetainedDocument, readonly (readonly string[])[]> = {
  run: [
    ["target", "head_sha"],
    ["target", "headSha"],
    ["attempt_id"],
    ["run_id"],
    ["launch_id"],
  ],
  recheck: [
    ["doc", "headSha"],
    ["status", "headSha"],
    ["doc", "results", "*", "rowId"],
    // note: The recheck wire's evidence is one object per result, not a list.
    ["doc", "results", "*", "evidence", "sliceId"],
  ],
  // note: The report wire's only host-bound field; it carries no checkKey/generation.
  report: [["headSha"]],
  text: [],
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
  /** note: RFC 4648 §5: `-`/`_` alphabet, padding stripped. */
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

/** What one document redaction changed. */
export type RedactionOutcome<T> = {
  value: T;
  /** note: Occurrences replaced across every string leaf. */
  replaced: number;
};

/** note: Mutable counter one walk threads through its leaves. */
type RedactionState = { replaced: number };

/** safety: How each credential form is matched against a leaf. */
type CredentialMatcher = {
  /** safety: Forms of long credentials, matched anywhere in a leaf. */
  pattern: RegExp | null;
  /** safety: Short credentials, matched only when the whole leaf is that value. */
  exact: ReadonlySet<string>;
};

/**
 * safety: Split the credentials into the two match modes. A value at or above
 * `SUBSTRING_MIN_LENGTH` contributes every form and is matched anywhere; a
 * shorter one is matched only against a leaf that is exactly that value.
 */
function credentialMatcher(secrets: readonly string[]): CredentialMatcher {
  const forms = new Set<string>();
  const exact = new Set<string>();
  for (const secret of new Set(secrets)) {
    if (secret === "") continue;
    if (secret.length < SUBSTRING_MIN_LENGTH) {
      exact.add(secret);
      continue;
    }
    for (const form of Object.values(secretTransforms(secret))) {
      if (form !== "") forms.add(form);
    }
  }
  // invariant: A shorter form that is a substring of a longer one must not shred the
  // longer match first.
  const ordered = [...forms].sort((left, right) => right.length - left.length);
  return { pattern: ordered.length === 0 ? null : formPattern(ordered), exact };
}

/**
 * safety: Redact ONE retained document root.
 *
 * Identity is protected by traversal path (`IDENTITY_PATHS` for `document`),
 * not by key name and not by substituting values: a node whose path matches the
 * table is left untouched, every other string leaf is redacted in place. A path
 * the document does not carry is simply absent, and forged model text — e.g. a
 * `summary_md` containing `{"head_sha": …}` — is at no protected path, so the
 * credential match finds it like any other characters.
 *
 * A string document that parses as JSON (after trimming) is worked on as a
 * structure: `\u002f`, `\/` and `\n` are decoded before matching, and the result
 * is serialized again ONLY when a replacement happened — an untouched document
 * keeps its exact bytes, surrounding whitespace included. A changed one loses
 * that padding. A string leaf is NEVER parsed to look inside it: a leaf is text.
 *
 * Every string leaf at every depth is redacted; non-string leaves, object keys
 * and container shape pass through.
 *
 * Shape patterns (`redactSecrets`) stay OUT: their long-hex rule rewrites a
 * host-written `head_sha`.
 */
// safety: limit: a credential split across two leaves, or one the model double-escaped (it decodes to literal `\uXXXX` text), is missed.
export function redactDocument<T>(
  value: T,
  secrets: readonly string[],
  document: RetainedDocument,
): RedactionOutcome<T> {
  const matcher = credentialMatcher(secrets);
  if (matcher.pattern === null && matcher.exact.size === 0) return { value, replaced: 0 };
  const state: RedactionState = { replaced: 0 };
  const redacted = redactRoot(value, matcher, state, IDENTITY_PATHS[document]);
  return { value: redacted as T, replaced: state.replaced };
}

function redactRoot(
  value: unknown,
  matcher: CredentialMatcher,
  state: RedactionState,
  paths: readonly (readonly string[])[],
): unknown {
  if (typeof value === "string") {
    const parsed = parseDocument(value);
    if (parsed === undefined) return redactText(value, matcher, state);
    const redacted = redactTree(parsed, [], paths, matcher, state);
    // note: Untouched document: return the original bytes, trimming included.
    return state.replaced === 0 ? value : JSON.stringify(redacted);
  }
  return redactTree(value, [], paths, matcher, state);
}

/**
 * note: Walk a parsed structure carrying its path. A node on a protected path is
 * returned untouched; every other string is one text leaf. `*` in a table path
 * matches an array index.
 */
function redactTree(
  value: unknown,
  at: readonly string[],
  paths: readonly (readonly string[])[],
  matcher: CredentialMatcher,
  state: RedactionState,
): unknown {
  if (typeof value === "string") {
    const protectedPath = paths.some(
      (path) => path.length === at.length && path.every((segment, index) => segment === at[index]),
    );
    return protectedPath ? value : redactText(value, matcher, state);
  }
  // note: A Set is not walked by `Object.entries`: `attempt.recheck.rejected` is one.
  if (value instanceof Set) {
    return new Set([...value].map((item) => redactTree(item, [...at, "*"], paths, matcher, state)));
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactTree(item, [...at, "*"], paths, matcher, state));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactTree(item, [...at, key], paths, matcher, state),
      ]),
    );
  }
  return value;
}

/**
 * safety: One leaf, in the matcher's two modes: a leaf that IS a short credential is
 * replaced whole; otherwise the long-credential forms are scanned once.
 *
 * Existing markers are BOUNDARIES, not scanned text: the leaf is split on the
 * literal marker, each segment is scanned once, and the markers are rejoined
 * verbatim. So a credential that is a substring of `[REDACTED]` (or spans its
 * edge) can never rewrite it, a model-printed marker shields nothing but
 * itself, and text the scan emitted is never re-examined — a second pass is a
 * no-op with no placeholder involved.
 */
function redactText(text: string, matcher: CredentialMatcher, state: RedactionState): string {
  if (matcher.exact.has(text)) {
    state.replaced += 1;
    return REDACTED;
  }
  const { pattern } = matcher;
  if (pattern === null) return text;
  let count = 0;
  const out = text
    .split(REDACTED)
    .map((segment) =>
      segment.replace(pattern, () => {
        count += 1;
        return REDACTED;
      }),
    )
    .join(REDACTED);
  state.replaced += count;
  return count === 0 ? text : out;
}

/** note: Parsed object/array of an optionally whitespace-padded JSON document. */
function parseDocument(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** note: One pattern for every form, longest first (leftmost match wins). */
function formPattern(forms: readonly string[]): RegExp {
  const alternatives = forms.map((form) => form.replace(REGEX_METACHARACTERS, "\\$&")).join("|");
  return new RegExp(alternatives, "g");
}

/** note: The model-controlled `incomplete` fact (declared cause + unscanned scope). */
type IncompleteFact = NonNullable<ReviewOutput["incomplete"]>;

/**
 * safety: Redact one `incomplete` fact (qc2 F-001): `reason` and every `unscanned`
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
      // why: Conditional spreads keep ABSENT optional fields absent (no
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
