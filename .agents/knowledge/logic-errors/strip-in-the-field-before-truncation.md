---
module: review-publication
date: 2026-11-21
problem_type: logic_error
category: logic-errors
severity: high
symptoms:
  - "the overall review comment repeated a finding's suggestion fence, so the same proposal appeared in both the inline comment and the summary"
  - "after stripping the fence from the rendered summary, a summary long enough to truncate inside a fence lost every finding that followed it"
  - "the published summary showed only the verdict head and an empty Review section, with no error and no log line"
root_cause: "The strip ran on the fully rendered body, after the truncation helper had already opened and closed a fence around its cut; the shared CommonMark scanner does not accept that synthetic close, so the fence stayed open and the strip deleted everything to the end of the rendered string."
resolution_type: code_fix
tags:
  - review-publication
  - markdown-fence
  - truncation
  - summary-body
  - github-suggestion
---

# Strip a structured block before truncation, not after rendering

## Problem

A finding's GitHub `suggestion` fence belongs to its anchored inline comment. It was also reaching the overall review summary, where there is no line anchor to apply it to. The obvious fix — strip the fence from the rendered body — silently deleted the findings after it once the summary was long enough to be truncated.

## Symptoms

- The same suggestion text appeared twice: once as an applicable inline comment, once as a plain code block in the summary.
- With a summary at the body budget and an unclosed `suggestion` fence, the published body contained the verdict head and an empty `## Review` section only; the findings table, the finding blocks and the footer were gone.
- Nothing failed: the review posted, the API accepted it, and no test covered the truncation boundary.

## What Didn't Work

- **Stripping after rendering**: the shared fence scanner is CommonMark-shaped; the truncation helper appends its close fence immediately before the ellipsis, which that scanner does not accept. An "unclosed" fence therefore means "delete to the end of the string", and the end of the string is not the finding that owned the fence.
- **Trusting the clamp to keep the body safe**: the clamp's job is to keep markdown well-formed enough that the publication marker survives; it was never a promise that a later parser would read its synthetic close the way the renderer wrote it.

## Solution

Strip on the summary-only copy of the fields that reach truncation and rendering — never on the rendered string:

```ts
// before: the whole-render strip runs after the clamp has cut a fence
let core = renderReviewMarkdown(rendered);
core = dropAllSuggestionFences(core);

// after: field-level strip before the clamp can see a fence; the caller's
// findings (and the inline path that reads them) stay untouched
rendered = {
  ...rendered,
  summary_md:
    rendered.summary_md === undefined ? undefined : dropAllSuggestionFences(rendered.summary_md),
  findings: rendered.findings.map((fnd) => ({ ...fnd, body: dropAllSuggestionFences(fnd.body) })),
};
let core = renderReviewMarkdown(rendered);
```

## Why This Works

The truncation helper and the fence scanner now never meet: by the time either runs, no `suggestion` fence exists in the fields they consume. The strip is a pure function over a copy, so the stored envelope keeps the fence for the inline publisher, and fence-free bodies pass through byte-identical. The failure mode was structural — an ordering bug, not a fence-parsing bug — which is why fixing the parser would not have helped.

## Prevention

- When a fix removes a structured block, ask first whether it runs before or after the truncation/assembly chain; prefer cleaning the input fields over editing the assembled output.
- Write the regression at the budget boundary: a body just over the limit whose cut lands inside the structure, plus a following block that must survive. A test with a short body proves nothing here.
- Keep the shared helper (here `dropAllSuggestionFences`) as the only strip rule, and assert separately that the caller's object is not mutated — the inline path depends on it.
- Reviewers: a "strip from the rendered body" hunk is a red flag whenever the same path also clamps, truncates or appends markers.
