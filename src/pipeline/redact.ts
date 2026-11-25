
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
 * The Check excerpt of a composed failure detail. The attempt reference is the
 * lookup key an operator pastes into the store, so it survives any cut: a
 * detail too long for the Check is truncated before it with a marker, and the
 * reference is re-appended intact.
 */
export function boundedCheckDetail(detail: string, maxChars = 240): string {
  const attemptMatch = /(\(attempt [^)]+\))$/.exec(detail);
  const tail = attemptMatch?.[1];
  const body = tail === undefined ? detail : detail.slice(0, detail.length - tail.length - 1);
  const budget = maxChars - (tail === undefined ? 0 : tail.length + 1);
  if (detail.length <= maxChars) return detail;
  const marker = "…";
  const cut = body.slice(0, Math.max(0, budget - marker.length));
  return tail === undefined ? `${cut}${marker}` : `${cut}${marker} ${tail}`;
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

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

const SUBSTRING_MIN_LENGTH = 8;

const MIN_ENCODED_SUBSTRING_LENGTH = 6;

/** A retained document whose host-written identity paths are protected. */
export type RetainedDocument = "run" | "recheck" | "report" | "text";

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
    ["doc", "results", "*", "evidence", "sliceId"],
  ],
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

/**
 * Whether `text` carries a credential form the publish gate must refuse
 * (SEC-01). A short secret's RAW spelling is skipped: write-time exact-leaf
 * redaction already removed it, and the trusted markers contain ordinary words
 * a short key may equal. Encodings still match — as substrings only when long
 * enough to be specific; shorter ones are exact-only.
 */
export function carriesSecretForm(text: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (secret === "") continue;
    const short = secret.length < SUBSTRING_MIN_LENGTH;
    for (const form of Object.values(secretTransforms(secret))) {
      if (form === "" || (short && form === secret)) continue;
      if (form.length >= MIN_ENCODED_SUBSTRING_LENGTH ? text.includes(form) : text === form) return true;
    }
  }
  return false;
}

/** What one document redaction changed. */
export type RedactionOutcome<T> = {
  value: T;
  replaced: number;
};

type RedactionState = { replaced: number };

type CredentialMatcher = {
  pattern: RegExp | null;
  exact: ReadonlySet<string>;
};

function credentialMatcher(secrets: readonly string[]): CredentialMatcher {
  const forms = new Set<string>();
  const exact = new Set<string>();
  for (const secret of new Set(secrets)) {
    if (secret === "") continue;
    const short = secret.length < SUBSTRING_MIN_LENGTH;
    if (short) exact.add(secret);
    for (const form of Object.values(secretTransforms(secret))) {
      if (form === "" || (short && form === secret)) continue;
      if (form.length < MIN_ENCODED_SUBSTRING_LENGTH) {
        exact.add(form);
        continue;
      }
      forms.add(form);
    }
  }
  const ordered = [...forms].sort((left, right) => right.length - left.length);
  return { pattern: ordered.length === 0 ? null : formPattern(ordered), exact };
}

/**
 * Redact every form of each secret from a text WE persist — an attribution log
 * line, a durable failure row — for seat-authored text that never passes through
 * `redactDocument`.
 *
 * Deliberately stricter than the publish gate's matcher: the gate REFUSES model
 * output, so it matches a short raw value — and an encoding under its
 * six-character substring floor — only as a whole leaf, to avoid false
 * positives. A ledger write has the opposite cost: over-redaction is cheap, a
 * durable leak is not. So EVERY form is removed wherever it appears — the long
 * forms (`credentialMatcher`'s patterns) first, then the whole-leaf-only ones as
 * substrings longest-first, then every raw value at any length.
 */
export function redactLedgerText(text: string, secrets: readonly string[]): string {
  const matcher = credentialMatcher(secrets);
  let out = redactText(text, matcher, { replaced: 0 });
  for (const form of [...matcher.exact].sort((left, right) => right.length - left.length)) {
    out = out.split(form).join(REDACTED);
  }
  return redactExactSecrets(out, secrets);
}

/**
 * Redact ONE retained document root.
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
// limit: a credential split across two leaves, or one the model double-escaped (it decodes to literal `\uXXXX` text), is missed.
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
    return state.replaced === 0 ? value : JSON.stringify(redacted);
  }
  return redactTree(value, [], paths, matcher, state);
}

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

function formPattern(forms: readonly string[]): RegExp {
  const alternatives = forms.map((form) => form.replace(REGEX_METACHARACTERS, "\\$&")).join("|");
  return new RegExp(alternatives, "g");
}

type IncompleteFact = NonNullable<ReviewOutput["incomplete"]>;

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
