---
module: design-system gate (scripts/design-system-check.ts) and its SPA tests
date: 2026-11-06
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "A guard must reason about source text with a construct its own grammar does not cover"
  - "Deciding whether a check may delete, blank, or normalize text before matching"
  - "Repairing a guard that passes on the exact input it exists to reject"
tags:
  - guards
  - preprocessing
  - lexer
  - fail-open
  - false-alarm
  - text-scan
---

# A guard that writes a lexer fails open

## Context

The design-system gate finds every `var(--x)` / `bg-(--x)` reference in the SPA's
stylesheets, HTML shells and `.ts`/`.tsx` modules, and reports any name the checked
themes do not declare. To do that it has to decide which bytes are comments: a retired
token quoted in prose is not a reference.

For `.ts`/`.tsx` that decision is a lexer question, not a regex question. Which `//`
opens a comment depends on whether the byte stream is inside a template, a regex body,
JSX text or a string, and the answer belongs to the parser. The gate grew five
comment-handling rules across five rounds. Each rule closed the counterexample in front
of it and opened a new path on which a live reference disappeared. Every round was green
in its own tests; every new path was found by review.

The outcome, stated in `danglingReferences` and documented in the source beside it, is
that a script is never stripped at all.

## Guidance

**When a guard must choose between deleting text it is unsure about and over-reporting,
choose over-reporting.**

- **State the invariant as monotonicity, not as coverage.** For every preprocessing
  step, name the set of bytes it is allowed to lose, and prove the reference channel is
  not in it. A step whose loss set you cannot bound does not get to delete. Returning a
  script's text unchanged makes the loss set empty by construction rather than by
  argument.
- **Do not answer a silent miss with another exception.** Each attempt below added a
  prefix rule, a keyword list or a state so that the last counterexample would pass. The
  exception list is unbounded because the lexer is; a rule that needs a growing list to
  stay sound is not converging.
- **Give the two channels separate polarities.** References must be read from bytes that
  were never removed. Excuses — declarations that let a name pass — may be *rejected*,
  never *edited*: rejecting a whole match removes an excuse and can only add reports,
  while truncating one manufactured an excuse out of thin air. A half-open interval
  overlap against the raw text is enough.

  ```ts
  // deny an excuse by dropping the whole match; never shorten it
  .filter((m) => !spans.some(([from, to]) => m.index < to && m.index + m[0].length > from))
  ```

- **Test the class, not the counterexample.** A regression assertion per reported shape
  ratchets behind the defect: the assertions written for the fourth attempt all pass
  under the fifth because they assert output, not the deletion path. Where the input
  class is unbounded, the load-bearing test is the property — feed text whose comment
  structure the scan cannot be sure about, and require the reference to survive.
- **Record the residual where the scan lives, in the `shortcut:` form.** One line: the
  limit, then the condition to upgrade.

  ```ts
  // shortcut: a script is never comment-stripped, so a token named only in a
  // TS/TSX comment is reported as dangling; restore stripping when a parser that
  // can answer "is this '/' a comment" is available.
  ```

- **Measure the over-reporting cost before accepting it.** An unmeasured false alarm is
  how "acceptable" turns into an exemption list. Across the 66 script consumers the gate
  reads, the number of token references inside comment spans was zero, and the widened
  gate exited 0 on the live tree.
- **Check the dependency before writing the lexer.** The installed `typescript` exposes a
  scanner but no parser, and a bare scan cannot answer the comment question — the answer
  depends on the parser's rescans. A probe over a template and over JSX text both
  reported a live class string as `SingleLineCommentTrivia`, deleting a reference in each
  case. If a future dependency ships a parser, stripping can return; that is the recorded
  upgrade condition, not a reason to try a third lexer now.

### The five attempts, and what each one lost

| Rule the gate used for scripts | Live reference it lost |
|---|---|
| blank `//` to end of line wherever whitespace precedes it | `const u = " // "; const k = "bg-(--retired-900)";` — the string's `//` eats the rest of the line |
| token-scanning lexer, first pass (quoted strings and template text preserved) | `if (ok) /[//]/.test(value); const k = "bg-(--retired-900)";` — after a control-condition `)` the regex body's `//` is read as a comment |
| second pass (regex openers; keyword test inverted so `return` / `throw` / `case` stopped being openers) | `return /[//]/;` loses the next statement; `for await (` accumulates to `forawait`, so its `)` is read as an expression end; JSX text `/[//</div>` reaches the failed-regex fallback |
| blank only context-free comments: a line whose first non-space characters are `//`, and `/* … */` | a template's middle line starting `//`; `"/*"` … `"*/"` as separate strings swallow the class string between them; a declaration's value truncated at a URL's `//` stops looking self-referential and starts excusing its own reference |
| read scripts raw; drop whole declarations a candidate comment span touches | none by construction — the cost is a visible false alarm |

The fourth row's last case is the sharpest. No reference was deleted: the *declaration*
view was truncated, which turned "this alias's value references itself, so it cannot
excuse the name" into "excuses it". A scan whose only job was removing prose manufactured
a silent pass.

## Why This Matters

The gate's value is that its failure mode is louder than the defect. A comment stripper
breaks that in the one direction nobody can see: the guard prints "every link is intact"
over a tree that still contains the dangling reference it was built to catch, and it does
so with *more* authority than before, because it now covers `.tsx`. Five rules shipped
with green tests, and every new path was found by a reviewer tracing one spelling through
the new control flow — not by the suite.

A false alarm costs an operator one visible minute and one debatable exemption. A silent
pass costs the defect class returning with the guard's endorsement, which is the failure
this repository keeps paying for.

## When to Apply

- A check that must reason about source text with a construct its own grammar does not
  cover: comments, strings, templates, regex literals, JSX.
- Adding any preprocessing step — strip, blank, normalize, truncate, decode — before a
  match in a guard.
- Repairing a guard that passes on the exact input it exists to reject.
- Reviewing such a guard: ask for the loss set of every step, not for another test.

## Examples

### Before — the fourth attempt, condensed, still deleting live bytes

```ts
// strip only what is context-free
const live = text
  .replace(/^[ \t]*\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
```

Both halves are context-sensitive in TSX: a template's middle line and a string pair
each spell those delimiters.

### After — the reference channel has no preprocessing at all

```ts
// withoutComments: style → block comments blanked; html → block and line blanked;
// script → the text itself, unchanged.
const live = withoutComments(file, text);
const commented = consumerKind(file) === "script" ? scriptCommentSpans(live) : [];
```

References match `live`, which is the file's own bytes. Declarations match `live` too,
and any declaration that a candidate comment span intersects is dropped whole, so a
commented-out declaration excuses nothing while a live one is never truncated.
