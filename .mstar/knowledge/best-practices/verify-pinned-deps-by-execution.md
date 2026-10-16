---
module: review-runtime-omp
date: 2026-10-17
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - "Writing or correcting a comment that states what a pinned dependency does"
  - "Reviewing prose about SDK behaviour after a dependency upgrade"
  - "Two reports disagree about an installed package's mechanism"
  - "The only artefact at hand is a package's built bundle"
topic: verifying pinned dependency behaviour
tags:
  - dependency-verification
  - sdk
  - minified-bundle
  - prose-contracts
---

# Verify a pinned dependency by running it, not by reading its bundle

## Context

This repo pins exact dependency cohorts, and tracked comments and knowledge documents describe what those pins do. Correcting that prose went wrong twice in a row for one sentence: the first attempt read the installed package's minified `dist/cli.js` and claimed a parse-time `yield` append that does not exist; the replacement claimed the append happens whenever a tool list parses, which is also not the rule. Two independent reviewers disagreed with the implementer's report, and nobody's reading of the bundle settled it. What settled it was running the parser.

## Guidance

When prose has to state what a pinned dependency does, take the behaviour from the dependency's **own entry points**, and state which layer you are describing.

1. **Call it.** Import the module the repo actually resolves (its declared `main`) and exercise the exact input in question — an object-shaped value, an empty array, a missing key. Record the raw stdout. That output is the authority; a paraphrase is not.
2. **Prefer shipped sources over `dist/**`.** A bundled function has been renamed, inlined and minified. The identifiers you read there are not the ones the source uses, and one apparent rule in the bundle can be two rules in the source. When only a bundle is readable, treat any mechanism claim from it as a hypothesis to test, never as evidence.
3. **Name the layer.** The same symbol can behave differently at parse time and at run time. A claim that does not say *which* layer it describes will be false about the other one, and reworded corrections tend to overshoot in the opposite direction once a reviewer catches the first error.
4. **Let the experiment beat every report — including your own.** If two reports conflict, do not average them or pick the more confident one: reproduce the call and let the output decide. Record the provenance of a mistake too, so the next reader checks the source rather than repeating the read.

## Worked example — the `yield` tool in `@oh-my-pi/pi-coding-agent`

Two layers, in the observed output of the pinned package:

| Layer | Behaviour | Where |
|-------|-----------|-------|
| declaration parse | an object-shaped `tools:` map and an explicit `tools: []` both become the **empty built-in allowlist**; the declaration parse adds nothing of its own | the package's `parseAgentFields` / `parseAgent` |
| runtime augmentation | `yield` is pushed onto a requested list only when the spawn is structured (`requireYieldTool === true`) | the task executor and the tool registry |

So a seat built from an OpenCode-style role file ends up with **no tools at all**, and a deep seat needs `yield` named explicitly *and* `structured: true` — two separate facts that a single "the SDK appends nothing" sentence flattens into a wrong one.

## Why This Matters

A wrong mechanism in a tracked comment or knowledge document is not cosmetic: it is a false statement about a dependency, and it survives review precisely because it reads plausibly. This one cost two review rounds and a fix round, on a change whose only product was prose — the debugging cost of a wrong mechanism is paid far later, by whoever trusts it. A minified bundle makes that failure mode easy to reach: it looks like primary evidence and is not.

## When to Apply

Before writing or accepting any claim about installed-package behaviour — especially after an SDK bump, when correcting a comment that was already wrong once, or when a review and an implementer report disagree. Also when a package ships sources alongside its bundle: reading the sources and running the entry point together is what makes the claim checkable by the next reader.
