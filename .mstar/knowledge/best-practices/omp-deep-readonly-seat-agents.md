---
module: review-runtime-omp
date: 2026-08-29
last_updated: 2026-10-16
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Spawning omp parent-session deep review seats from HARNESS_PLUGIN_ROOT"
  - "Copying mstar-harness agents/*.md into a sandbox .omp/agents directory"
  - "Bumping the omp SDK (the seat contract is coupled to its tool-list and structured-result handling)"
topic: review deep-runner orchestration
tags:
  - omp
  - deep-review
  - restrictToolNames
  - seat-agents
---

# Deep seats must be OMP-native read-only agents

## Context

Copying harness `agents/*.md` unchanged into `<worktree>/.omp/agents/` looks like zero-copy skill reuse. Those files use OpenCode-style `tools: { write: true, ... }` objects. omp `parseAgentFields` accepts an array or a CSV string (installed `@oh-my-pi/pi-coding-agent`, `src/discovery/helpers.ts`), so an object map parses to an **empty** tool list (`parseArrayOrCSV` returns `undefined`, coalesced to `[]`, logged as a declaration naming no tools). The parent's `restrictToolNames: true` never widens that empty declaration, so the seat gets **no tools at all**: it cannot `read` the clone, and the declaration parse adds nothing of its own, so `yield` reaches the seat only from a structured spawn — which the deep parent's `task` tool is not — leaving a blind seat whose turn ends as plain text.

## Guidance

Install **OMP-native** seat definitions through `toOmpSeatDefinition` in `packages/runner/src/runtime-omp.ts`: `tools: [read, grep, glob, yield]` **and** `structured: true`. Both are required: the deep parent dispatches these seats with the SDK built-in `task` tool, and the deep session's isolated settings leave `task.structured` off (it sets only `fetch.enabled`, `retry.*` and `task.agentModelOverrides`), so an unstructured spawn filters `yield` out of the child's tool list unless the definition's own `structured: true` opts it back in. Load harness **prompt/skill bodies** from `HARNESS_PLUGIN_ROOT` at runtime; do not copy role frontmatter. Limit installs to `DEEP_SEAT_ROLES`. Parse installed agents in tests the way `parseAgentFields` does.

## Why This Matters

A seat that cannot `read` still returns a plausible report, and nothing downstream distinguishes it from a seat that did read the clone: the caller's `validateMstarReviewV1` gate validates the assembled review envelope, not how the evidence was gathered. A wrong seat definition therefore buys a shape-valid deep review built on nothing.

## When to Apply

- Any parent `createAgentSession({ restrictToolNames: true })` that spawns `task` seats
- Changing how harness agents are discovered in the sandbox
- Bumping the omp SDK: the seat definition contract tracks its tool-list and structured-result handling (the version lives in `package.json`)

## Examples

### Before

`copyFile(pluginRoot/agents/*.md → worktree/.omp/agents/)`

### After

Rewrite frontmatter to `tools: [read, grep, glob, yield]` + `structured: true` for `DEEP_SEAT_ROLES` only; still `readFile` the amazing-pr-review command from the plugin root.
