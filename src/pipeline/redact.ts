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

import type { ReviewOutput } from "../review/schema";

/** Redaction marker replacing every matched secret-shaped span. */
export const REDACTED = "[REDACTED]";

/**
 * Secret-shaped patterns, applied in order. The PEM block comes first — it
 * contains base64/hex lines that the later fine-grained patterns would
 * otherwise shred in pieces.
 */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private-key blocks (any header/body form).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Authorization-style bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  // GitHub tokens (classic + fine-grained).
  /gh[pous]_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  // OpenAI-style API keys (sk- + 8+ alnum/underscore/hyphen chars).
  /sk-[A-Za-z0-9_-]{8,}/g,
  // AWS access key ids (AKIA + 16 chars).
  /AKIA[0-9A-Z]{16}/g,
  // Key/secret assignment-ish references: `ARK_API_KEY=...`, `API_KEY: ...`,
  // `TOKEN "..."`, `SECRET = ...` (Phase 5 B2 pattern, verbatim).
  /\b(?:ARK_API_KEY|API_KEY|TOKEN|SECRET)["'\s:=]+\S+/g,
  // Provider-key assignment lines (SEC-01): `GEMINI_API_KEY=…`,
  // `CURSOR_ACCESS_TOKEN=…`, `AZURE_OPENAI_API_KEY=…` — the `_` before
  // API_KEY/ACCESS_TOKEN/TOKEN/SECRET is a word char, so the alternation
  // above cannot see past it; this form anchors on the full `PREFIX_SUFFIX`
  // name (the old alternation keeps working for the bare names).
  /\b[A-Z0-9][A-Z0-9_]*_(?:API_KEY|ACCESS_TOKEN|TOKEN|SECRET)["'\s:=]+\S+/g,
  // Forwarded-provider value shapes (SEC-01): Gemini / Groq / xAI keys —
  // bare-value forms that may appear without an assignment line.
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  // Long hex strings (40+ chars — git object ids, API key material).
  /\b[0-9a-fA-F]{40,}\b/g,
];

/** Replace every secret-shaped span in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
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
    summary_md: redactSecrets(output.summary_md),
    ...(output.tally === undefined
      ? {}
      : { tally: { ...output.tally, chatHeader: redactSecrets(output.tally.chatHeader) } }),
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
    summary_md: redactExactSecrets(output.summary_md, values),
    ...(output.tally === undefined
      ? {}
      : { tally: { ...output.tally, chatHeader: redactExactSecrets(output.tally.chatHeader, values) } }),
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
