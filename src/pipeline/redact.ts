/**
 * Secret redaction for model-produced text (Phase 5 B2 / SEC-02) — pure,
 * unit-tested. The review session can be prompt-injected into echoing
 * secrets (provider keys, installation tokens, PEM material) into
 * summary_md / finding bodies; everything that can reach the PUBLIC PR
 * review comment or D1 raw_output passes through here first (consumer choke
 * point, applied before postReview and insertReview).
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

/** Redact summary_md and every finding body of a ReviewOutput. */
export function redactReviewOutput(output: ReviewOutput): ReviewOutput {
  return {
    ...output,
    summary_md: redactSecrets(output.summary_md),
    findings: output.findings.map((finding) => ({
      ...finding,
      body: redactSecrets(finding.body),
    })),
  };
}
