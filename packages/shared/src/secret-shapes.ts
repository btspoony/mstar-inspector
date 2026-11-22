/**
 * why: Canonical secret-shaped patterns — ONE list, two consumers: the Worker's
 * text redaction (`src/pipeline/redact.ts`) and the sandbox runner's recheck
 * status error (`packages/runner/src/recheck.ts`). The runner is packaged
 * beside this package in the image and cannot import `src/**`, which is why
 * the list lives on this zero-runtime-dependency side; neither consumer keeps
 * a copy of its own. A caller that genuinely must skip a pattern declares the
 * exclusion at its call site rather than forking the list.
 */

/** Redaction marker replacing every matched secret-shaped span. */
export const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /gh[pous]_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\b(?:ARK_API_KEY|API_KEY|TOKEN|SECRET)["'\s:=]+\S+/g,
  /\b[A-Z0-9][A-Z0-9_]*_(?:API_KEY|ACCESS_TOKEN|TOKEN|SECRET)["'\s:=]+\S+/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /\b[0-9a-fA-F]{40,}\b/g,
];

/**
 * Replace every secret-shaped span in `text` with `[REDACTED]`.
 *
 * A non-string (a caller that coerced wrong) cannot be proven secret-free, so
 * it becomes the marker itself rather than riding through unredacted.
 */
export function redactSecretShapes(text: string): string {
  if (typeof text !== 'string') return REDACTED;
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
