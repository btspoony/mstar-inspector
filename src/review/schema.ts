/**
 * Review output schema (plan 02 Task 1) — executable SSOT for solution §5.2.
 *
 * Mirrors `.mstar/iterations/iter-001-20260825/specs/findings-schema.md` field
 * for field. Findings `severity` is the QC-style enum
 * `critical | warning | suggestion | info` — NOT the residual register enum
 * (`critical/high/medium/low/nit`). Unknown keys are stripped (zod default),
 * required keys stay required, and `file_path` / `line_start` / `line_end` are
 * required-but-nullable.
 */

import { z } from "zod";

export type ReviewVerdict = "comment" | "request_changes" | "approve";
export type FindingSeverity = "critical" | "warning" | "suggestion" | "info";
export type FindingCategory =
  | "security"
  | "logic"
  | "style"
  | "perf"
  | "test"
  | "other";

export type ReviewFinding = {
  severity: FindingSeverity;
  category: FindingCategory;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  title: string;
  body: string;
  fingerprint_hint?: string;
};

export type ReviewOutput = {
  verdict: ReviewVerdict;
  summary_md: string;
  findings: ReviewFinding[];
};

const verdictSchema = z.enum(["comment", "request_changes", "approve"]);
const severitySchema = z.enum(["critical", "warning", "suggestion", "info"]);
const categorySchema = z.enum(["security", "logic", "style", "perf", "test", "other"]);

const findingSchema = z
  .object({
    severity: severitySchema,
    category: categorySchema,
    file_path: z.string().nullable(),
    line_start: z.number().int().nullable(),
    line_end: z.number().int().nullable(),
    title: z.string(),
    body: z.string(),
    fingerprint_hint: z.string().optional(),
  })
  .transform((f) => {
    // Empty fingerprint_hint is stripped as if absent (spec: "空串可在 parse 时剥掉当缺省").
    if (f.fingerprint_hint === undefined || f.fingerprint_hint === "") {
      const { fingerprint_hint: _drop, ...rest } = f;
      return rest;
    }
    return f;
  });

const outputSchema: z.ZodType<ReviewOutput> = z.object({
  verdict: verdictSchema,
  summary_md: z.string().min(1),
  findings: z.array(findingSchema),
});

/** Extract the first ```json / ``` fenced block, or null. */
function extractFenced(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1]!.trim() : null;
}

/** Extract the first `{` … last `}` span, or null. */
function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse raw model output into a validated ReviewOutput.
 *
 * Algorithm (iteration spec): trim → JSON.parse whole → fall back to the
 * fenced ```json / ``` block → fall back to first `{` … last `}` → zod.
 * Any failure returns `{ ok: false, error }` and never throws.
 */
export function parseReviewOutput(
  raw: string,
): { ok: true; output: ReviewOutput } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "empty input" };

  const candidates: string[] = [text];
  const fenced = extractFenced(text);
  if (fenced !== null) candidates.push(fenced);
  const braces = extractBraces(text);
  if (braces !== null) candidates.push(braces);

  let lastError = "not valid ReviewOutput JSON";
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = outputSchema.safeParse(parsed);
    if (result.success) return { ok: true, output: result.data };
    lastError = result.error.message;
  }
  return { ok: false, error: lastError };
}
