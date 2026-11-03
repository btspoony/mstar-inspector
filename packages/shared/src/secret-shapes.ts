/**
 * Canonical secret-shaped patterns — ONE list, two consumers: the Worker's
 * text redaction (`src/pipeline/redact.ts`) and the sandbox runner's recheck
 * status error (`packages/runner/src/recheck.ts`). The runner is packaged
 * beside this package in the image and cannot import `src/**`, which is why
 * the list lives on this zero-runtime-dependency side; neither consumer keeps
 * a copy of its own. A caller that genuinely must skip a pattern declares the
 * exclusion at its call site rather than forking the list.
 */

/** Redaction marker replacing every matched secret-shaped span. */
export const REDACTED = '[REDACTED]';

/**
 * Secret-shaped patterns, applied in order. The PEM block comes first — it
 * contains base64/hex lines that the later fine-grained patterns would
 * otherwise shred in pieces. Every pattern is global, so `String.replace`
 * applies it to all matches and resets its own `lastIndex`.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
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
export function redactSecretShapes(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
