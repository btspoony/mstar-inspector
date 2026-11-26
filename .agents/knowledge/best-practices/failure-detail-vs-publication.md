---
module: review-lifecycle
date: 2026-11-26
problem_type: best_practice
category: best-practices
severity: high
topic: failure diagnostics
applies_when:
  - recording or rendering a review failure
  - publishing failure text to a public surface (GitHub Check, PR comment)
  - bounding or redacting a thrown message before persisting it
---
# A failure's detail and a failure's publication are two different surfaces

A review failure has to be diagnosable by the operator who owns the platform, and it must not
disclose the platform's internals to the pull request's author. Those are not the same field, and a
change that improves one without separating them improves the wrong thing.

## The incident shape

Three failed attempts recorded one row each:

```
error_code = review.internal.unclassified
error      = "Attempt failed due to internal workflows error"
stage      = pipeline
```

That sentence is Cloudflare's text for a Workflow instance whose step threw; it appears nowhere in
the product's source. The machinery to record better already existed — a stage on the transient
facts, a cause on the handoff observation — but the unclassified path arrived with those fields
empty, so every renderer could only print the platform sentence.

## Two surfaces, two rules

| Surface | Audience | Carries |
|---|---|---|
| `review_failures` row (D1) | the operator | phase, stage, error class, bounded message, the runner's stderr excerpt, the attempt id |
| GitHub Check summary | anyone who can read the repo | phase, stage, error class, attempt id — and a pointer to where the detail lives |

The Check is public. The row is not. Runner stderr carries provider errors and model-chain
diagnostics; publishing it turns a private incident into a repository-wide disclosure. So the Check
says *where* the detail is recorded, never *what* it is.

A corollary people get wrong in both directions: the sentence must match what actually happened on
that path. If the row insert failed, the Check must not claim a record exists; if the row failed but
the step's own log already holds the detail, the Check must name the log rather than say nothing
durable exists. Both wrong versions were shipped during this work, one in each direction, and both
sent the operator to the wrong artifact.

## Redaction order

Exact-value redaction needs the complete secret string. Any transformation before it — a truncation,
a newline collapse, a shape-pattern substitution — can destroy the match and leave the remainder
readable. The order is fixed:

```
exact redaction → shape redaction → normalization → truncation
```

Two sub-cases that escaped review for several rounds:

- A sealed value shaped like `ghp_<32 chars>-and-more` is rewritten by the shape pass into
  `[REDACTED]-and-more`; the exact pass then cannot find it, and the suffix survives.
- A credential that straddles a 400-character cut leaves its prefix behind, because exact matching
  only replaces complete values.

Every new free-text field (an error class read off a throw's own properties, a stage name parsed from
stderr) enters the same pipeline. "It is only a class name" is how a credential ends up in a log.

## Unknown is an answer; a fabricated failure is not

When the credential envelope cannot be opened, the settlement cannot prove the message clean. The
correct outcome is `unknown`: it says "we cannot tell", keeps the paid-state question open for the
reconciler, and writes nothing conclusive.

An earlier round replaced it with a recorded failure carrying a fixed diagnostic, then returned `ok`.
That converts "we cannot tell" into "it failed, here is the text" — an operator stops looking, and the
reconciler never gets its chance. More detail made the outcome worse.

## Why the guards kept being empty

Four assertions in this change looked like coverage and could not fail:

| Assertion | Why it could not fail |
|---|---|
| "first 30 characters of the secret are absent" | the regression leaves only 19 |
| a `slice(0, 240)` restored | no test drove the path it shortened |
| a proxy fixture with a throwing trap | the fixture omitted required keys, so validation returned before the trap |
| "the captured log line has no secret" | it read `fields` only, never `msg` |

An inversion is the only proof: remove the fix, watch the named test go red. Authors judge their own
assertions by intent, not by execution; an independent seat has to run the removal.
