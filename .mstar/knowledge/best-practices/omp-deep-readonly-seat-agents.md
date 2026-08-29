---
module: review-runtime-omp
date: 2026-08-29
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Spawning omp parent-session deep review seats from HARNESS_PLUGIN_ROOT"
  - "Copying mstar-harness agents/*.md into a sandbox .omp/agents directory"
plan_id: 09-review-deep-parent
tags:
  - omp
  - deep-review
  - restrictToolNames
  - seat-agents
---

# Deep seats must be OMP-native read-only agents

## Context

Copying harness `agents/*.md` unchanged into `<worktree>/.omp/agents/` looks like zero-copy skill reuse. Those files use OpenCode-style `tools: { write: true, ... }` objects. omp `parseAgentFields` expects a string list; objects become `undefined`. Under parent `restrictToolNames: true`, child seats then get an **empty whitelist** plus `yield` — they cannot `read` the clone but can still yield a shape-valid envelope (hallucinated deep review).

## Guidance

Install **OMP-native** seat definitions: `tools: [read, grep, glob]` (same contract as `src/review/seat-agent.md`). Load harness **prompt/skill bodies** from `HARNESS_PLUGIN_ROOT` at runtime; do not copy role frontmatter. Limit installs to the Stage 2 roles actually dispatched (`code-reviewer`, `fullstack-dev`, `frontend-dev`). Parse installed agents in tests the way `parseAgentFields` does.

## Why This Matters

A yield-only seat satisfies `requireYieldTool` + `validateMstarReviewV1` without ever seeing the tree.

## When to Apply

- Any parent `createAgentSession({ restrictToolNames: true })` that spawns `task` seats
- Changing how harness agents are discovered in the sandbox

## Examples

### Before

`copyFile(pluginRoot/agents/*.md → worktree/.omp/agents/)`

### After

Rewrite frontmatter to `tools: [read, grep, glob]` for `DEEP_SEAT_ROLES` only; still `readFile` the amazing-pr-review command from the plugin root.
