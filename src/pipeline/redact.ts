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

/** Stands in for an existing marker while secrets are replaced; restored after. */
const MARKER_SENTINEL = "\u0000marker\u0000";

// why: a value shorter than a credential cannot be redacted safely — it would
// match ordinary text (and a 3-char secret matches inside a SHA).
const MIN_SECRET_LENGTH = 8;

/** A retained document whose host-written identity paths are protected. */
export type RetainedDocument = "run" | "recheck" | "report" | "text";

/**
 * The identity paths, per document. Protection is STRUCTURAL — by position, not
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
    // The recheck wire's evidence is one object per result, not a list.
    ["doc", "results", "*", "evidence", "sliceId"],
  ],
  // The report wire's only host-bound field; it carries no checkKey/generation.
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

/** What one document redaction changed. */
export type RedactionOutcome<T> = {
  value: T;
  /** Occurrences replaced across every string leaf. */
  replaced: number;
};

/** Mutable counter one walk threads through its leaves. */
type RedactionState = { replaced: number };

/** The applicable credential forms, longest first. */
function applicableForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of new Set(secrets)) {
    if (secret === "" || secret.length < MIN_SECRET_LENGTH) continue;
    for (const form of Object.values(secretTransforms(secret))) {
      if (form !== "") forms.add(form);
    }
  }
  // A shorter form that is a substring of a longer one must not shred the
  // longer match first.
  return [...forms].sort((left, right) => right.length - left.length);
}

/**
 * Credentials this pass will NOT apply, counted ONCE per distinct value: a skip
 * is a property of the secret list, not of a document count, so four documents
 * with one short value report 1. Empty values are not credentials.
 */
export function skippedSecrets(secrets: readonly string[]): number {
  let skipped = 0;
  for (const secret of new Set(secrets)) {
    if (secret !== "" && secret.length < MIN_SECRET_LENGTH) skipped += 1;
  }
  return skipped;
}

/**
 * Redact ONE retained document root.
 *
 * Identity is protected by explicit path (`IDENTITY_PATHS` for `document`), not
 * by key name: each value found at a host-written path is parked behind a
 * sentinel, the whole document is redacted, and the value is restored. A path
 * the document does not carry is simply absent. Forged model text — e.g. a
 * `summary_md` containing `{"head_sha": …}` — is at no protected path, so it is
 * redacted like any other text.
 *
 * A string document that parses as JSON (after trimming) is worked on as a
 * structure: `\u002f`, `\/` and `\n` are decoded before matching, and the result
 * is serialized again ONLY when a replacement happened — an untouched document
 * keeps its exact bytes, surrounding whitespace included. A changed one loses
 * that padding. Any other string is redacted as text.
 *
 * Every string leaf at every depth is redacted; non-string leaves, object keys
 * and container shape pass through. Idempotence is structural: an existing
 * `[redacted]` marker is parked before secret replacement and restored after, so
 * a second pass is a no-op and a model-printed marker shields nothing.
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
  const forms = applicableForms(secrets);
  const state: RedactionState = { replaced: 0 };
  if (forms.length === 0) return { value, replaced: 0 };
  const redacted = redactRoot(value, forms, state, IDENTITY_PATHS[document]);
  return { value: redacted as T, replaced: state.replaced };
}

function redactRoot(
  value: unknown,
  forms: readonly string[],
  state: RedactionState,
  paths: readonly (readonly string[])[],
): unknown {
  const saved = new Map<string, string>();
  if (typeof value === "string") {
    const parsed = parseDocument(value);
    if (parsed === undefined) return redactText(value, forms, state);
    const protectedDoc = protectIdentity(parsed, paths, saved);
    const redacted = redactAny(protectedDoc, forms, state);
    // Untouched document: return the original bytes, trimming included.
    return state.replaced === 0 ? value : JSON.stringify(restoreIdentity(redacted, saved));
  }
  return restoreIdentity(redactAny(protectIdentity(value, paths, saved), forms, state), saved);
}

/** Every string leaf at every depth; no key is exempt at this stage. */
function redactAny(value: unknown, forms: readonly string[], state: RedactionState): unknown {
  if (typeof value === "string") return redactText(value, forms, state);
  // A Set is not walked by `Object.entries`: `attempt.recheck.rejected` is one.
  if (value instanceof Set) return new Set([...value].map((item) => redactAny(item, forms, state)));
  if (Array.isArray(value)) return value.map((item) => redactAny(item, forms, state));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactAny(item, forms, state)]),
    );
  }
  return value;
}

/**
 * One text leaf: park every existing marker, replace every form of every
 * secret, restore the markers. Parking is what makes a second pass a no-op and
 * stops a model-printed `[redacted]` from shielding anything.
 */
function redactText(text: string, forms: readonly string[], state: RedactionState): string {
  const parked = text.split(TRANSFORMED_REDACTED).join(MARKER_SENTINEL);
  let out = parked;
  for (const form of forms) {
    const parts = out.split(form);
    if (parts.length === 1) continue;
    state.replaced += parts.length - 1;
    out = parts.join(TRANSFORMED_REDACTED);
  }
  return out === parked ? text : out.split(MARKER_SENTINEL).join(TRANSFORMED_REDACTED);
}

/** Parsed object/array of an optionally whitespace-padded JSON document. */
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

/** Replace each protected path's string value with a sentinel, remembering it. */
function protectIdentity(
  value: unknown,
  paths: readonly (readonly string[])[],
  saved: Map<string, string>,
): unknown {
  const walk = (node: unknown, at: readonly string[]): unknown => {
    if (typeof node === "string") {
      // `*` in a table path matches an array index; everything else exactly.
      const protectedPath = paths.some(
        (path) => path.length === at.length && path.every((segment, index) => segment === at[index]),
      );
      if (!protectedPath) return node;
      const token = `\u0000id:${saved.size}\u0000`;
      saved.set(token, node);
      return token;
    }
    if (node instanceof Set) return new Set([...node].map((item) => walk(item, [...at, "*"])));
    if (Array.isArray(node)) return node.map((item) => walk(item, [...at, "*"]));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, item]) => [key, walk(item, [...at, key])]),
      );
    }
    return node;
  };
  return walk(value, []);
}

/** Put every parked identity value back. */
function restoreIdentity(value: unknown, saved: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return saved.get(value) ?? value;
  if (value instanceof Set) return new Set([...value].map((item) => restoreIdentity(item, saved)));
  if (Array.isArray(value)) return value.map((item) => restoreIdentity(item, saved));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restoreIdentity(item, saved)]),
    );
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
