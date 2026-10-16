---
module: review-runtime-omp
date: 2026-10-17
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - "Writing or correcting a comment that states what a pinned dependency does"
  - "Reviewing prose about SDK behaviour after a dependency upgrade"
  - "Two descriptions disagree about an installed package's mechanism"
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

This repo pins exact dependency cohorts, and tracked comments and knowledge documents describe what those pins do. Such descriptions are easy to get wrong in a way review does not catch, because a plausible mechanism reads like a verified one. The reliable way to settle what a pinned package does is to call it.

## Guidance

1. **Call it.** Import the module the repo actually resolves (its declared `main`) and exercise the exact input in question — an object-shaped value, an empty array, a missing key. Record the raw stdout. That output is the authority; a paraphrase is not.
2. **Prefer shipped sources over `dist/**`.** A bundled function has been renamed, inlined and minified. The identifiers you read there are not the ones the source uses, and one apparent rule in the bundle can be two rules in the source.
3. **Name the layer.** The same symbol can behave differently at parse time and at run time. A claim that does not say *which* layer it describes will be false about the other one, and a reworded correction tends to overshoot in the opposite direction once a reader catches the first error.
4. **Treat a bundle reading as a hypothesis, never as evidence.** When two descriptions conflict, do not average them or trust the more confident one: reproduce the call and let the output decide. Record the provenance of the wrong version too, so the next reader checks the source rather than repeating the read.

## Worked example — the `yield` tool in `@oh-my-pi/pi-coding-agent`

Two layers, in the observed output of the pinned package:

| Layer | Behaviour | Where |
|-------|-----------|-------|
| declaration parse | an object-shaped `tools:` map and an explicit `tools: []` both become the **empty built-in allowlist**; the declaration parse adds nothing of its own | the package's `parseAgentFields` / `parseAgent` |
| runtime augmentation | `yield` is pushed onto a requested list only when the spawn is structured (`requireYieldTool === true`) | the task executor and the tool registry |

The layers have to be stated together. An empty declaration leaves a seat with none of the tools it may use **on an unstructured spawn** — but a *structured* spawn still adds `yield` at run time, so "the declaration names no tools, therefore the seat gets no `yield`" is false in exactly the case a deep seat cares about. This repo's own seat definitions both name `yield` and set `structured: true`; that pairing is a repo convention, not an SDK requirement — once a spawn is structured, the tool arrives without the definition spelling it out.

## Why This Matters

A wrong mechanism in a tracked comment or knowledge document is not cosmetic: it is a false statement about a dependency, and it survives review precisely because it reads plausibly. The cost lands later, on whoever trusts it — debugging a behaviour that was never described correctly in the first place. A minified bundle makes that failure mode easy to reach: it looks like primary evidence and is not.

## When to Apply

Before writing or accepting any claim about installed-package behaviour — especially after an SDK bump, when correcting a description that was already wrong once, or when two descriptions disagree. When a package ships sources alongside its bundle, reading the sources and running the entry point together is what makes the claim checkable by the next reader.
