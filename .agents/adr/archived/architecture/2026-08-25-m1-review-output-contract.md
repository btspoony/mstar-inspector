# ADR: M1 structured review output contract

Status: implemented — M1 stored rows use the historical ReviewOutput shape.
Archived: 2026-11-10 — New writes and publication use harness mstar.review/v1; this contract is retained only to interpret historical M1 rows.

## Problem

M1 needs a parseable review output shared by the parser, validation, D1 finding columns and comment rendering. Historical decoding still needs the original enum and nullability rules. This is not the residual severity schema; the same word `critical` belongs to different registration domains.

## Decision

The M1 contract uses the following ReviewOutput shape for historical rows. It is write-retired: no new ArtifactStore or comment rendering takes its vocabulary as authority.

### Wire shape

```json
{
  "verdict": "comment | request_changes | approve",
  "summary_md": "Complete human-readable report Markdown",
  "findings": [
    {
      "severity": "critical | warning | suggestion | info",
      "category": "security | logic | style | perf | test | other",
      "file_path": "string | null",
      "line_start": "number | null",
      "line_end": "number | null",
      "title": "string",
      "body": "string",
      "fingerprint_hint": "Optional normalization hint"
    }
  ]
}
```

A legal instance (not an enum notation string):

```json
{
  "verdict": "comment",
  "summary_md": "No blocking issues.",
  "findings": []
}
```

### TypeScript

```ts
export type ReviewVerdict = "comment" | "request_changes" | "approve"
export type FindingSeverity = "critical" | "warning" | "suggestion" | "info"
export type FindingCategory =
  | "security"
  | "logic"
  | "style"
  | "perf"
  | "test"
  | "other"

export type ReviewFinding = {
  severity: FindingSeverity
  category: FindingCategory
  file_path: string | null
  line_start: number | null
  line_end: number | null
  title: string
  body: string
  fingerprint_hint?: string
}

export type ReviewOutput = {
  verdict: ReviewVerdict
  summary_md: string
  findings: ReviewFinding[]
}

/** Orchestration-only envelope; not part of ReviewOutput. */
export type ReviewRunResult = {
  mode: "structured" | "summary"
  result: ReviewOutput
}
```

### Enums

| Field | Legal values |
|---|---|
| `verdict` | `comment` / `request_changes` / `approve` |
| `findings[].severity` | `critical` / `warning` / `suggestion` / `info` |
| `findings[].category` | `security` / `logic` / `style` / `perf` / `test` / `other` |

### Validation

| Key | Location / presence | Rule |
|---|---|---|
| `verdict` | Root, required | Enum above |
| `summary_md` | Root, required | String; structured mode length ≥1 |
| `findings` | Root, required | Array; `[]` allowed |
| `severity` / `category` / `title` / `body` | Finding, required | Enums/string rules below |
| `file_path` | Finding, key required | String or null; omission rejected |
| `line_start` / `line_end` | Finding, keys required | Finite JSON integer or null; omission and `1.5` rejected |
| `fingerprint_hint` | Finding, optional | String if present; empty string may be stripped during parsing |

- Root is a JSON object.
- `title` and `body` are strings; empty strings still parse to tolerate model variation. Structured `summary_md` cannot be empty.
- Unknown keys are stripped rather than rejected.
- An invalid severity, including `high`, `medium`, `low`, or `nit`, fails the whole output with `{ ok: false }`. `critical` is legal.
- No location uses `file_path: null` and null line numbers, not empty string or zero as an absence sentinel. Zero is nevertheless a legal integer; the implementation need not rewrite it.

### Parser

`parseReviewOutput(raw)` returns `{ ok: true, output: ReviewOutput } | { ok: false, error: string }`. It trims, tries full JSON.parse, then JSON/plain fenced content, then the substring from the first `{` to the last `}`, and validates with zod. Failure returns `ok: false`, never throws.

### Degradation

Runner parse failure makes `reviewDiff` return `{ mode: "summary", result: { verdict: "comment", summary_md: <nonempty>, findings: [] } }`. Prefer raw model text (recommended ≤8000 UTF-16 code units); empty raw uses `Review output could not be parsed.`. The historical M1 main path required structured output. The historical v0.3 parse-failure path neither published nor inserted a result; summary-only GitHub publication belonged to a later milestone, not that review-engine version. Current degraded publication is governed by the current publication/lifecycle specs, not this record.

## Alternatives considered

No alternatives are recorded in the source contract.

## Consequences

Historical M1 rows retain a precise interpretation, including enum rejection, nullable locations and tolerant unknown-key stripping. New review persist/publication uses harness `mstar.review/v1` and [GitHub publication mapping](../../../../docs/specs/architecture/github-review-comment-mapping.md). The historical severity vocabulary does not define residual machine severity (`critical/high/medium/low/nit`), and this record invents no mapping between them.
