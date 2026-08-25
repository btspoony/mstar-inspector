---
module: review-orchestrator
date: 2026-08-25
problem_type: best_practice
category: best-practices
severity: high
plan_id: 02-omp-review-spike
tags:
  - omp
  - pi-coding-agent
  - review-session
  - tool-whitelist
  - settings-isolation
  - sandbox
applies_when:
  - Building one-shot AI review/analysis sessions on @oh-my-pi/pi-coding-agent
  - Restricting agent tool surface to read-only
  - Disabling outbound network inside agent sessions
related_components:
  - mstar-harness plugin
  - findings schema parser
---

# Isolated omp review sessions: verified SDK surface and hardening gates

## Context

mstar-inspector M0 spike (plan 02) verified that `@oh-my-pi/pi-coding-agent@18.0.4` can host one-shot, read-only PR review sessions under Bun 1.4.0. Everything below was verified against installed `.d.ts` files and two live runs (smoke + CLI e2e). Plugin: morning-star-harness 3.2.6 loaded from a local checkout.

## Guidance

Verified API surface (with type anchors at 18.0.4):

| Need | API | Anchor |
|------|-----|--------|
| In-memory session manager | `SessionManager.inMemory()` | `session-manager.d.ts:466` |
| Create session | `createAgentSession({...})` → `{ session }` | `sdk.d.ts` |
| Read-only tools | `restrictToolNames: true` + `toolNames: ["read","grep","glob"]` | `sdk.d.ts:177-179` |
| Local plugin load | `additionalExtensionPaths: [<plugin root>]` + `disableExtensionDiscovery: true`; root resolved via **`M0_HARNESS_PLUGIN_ROOT` env var (primary, portable — CI-proven)** → sibling dir → absolute local path (dev fallbacks) | `sdk.d.ts:104-106` |
| Skill load | `loadSkillsFromDir(<dir>)` | `skills.d.ts:51-57` |
| Lifecycle | `AgentSession.prompt()` / `getLastAssistantMessage()` / `dispose()` | `agent-session.d.ts:210/278/540` |
| Settings isolation | `Settings.isolated({ "fetch.enabled": false })` passed as `options.settings` | `settings.d.ts:56-63`, `sdk.d.ts:228` |

Hard rules learned the hard way:

1. **Tool whitelist ≠ network isolation.** `restrictToolNames` keeps the `read` tool's URL-fetch path; `fetch.enabled` defaults to `true`. Pass `Settings.isolated({ "fetch.enabled": false })` as `options.settings` — this also skips `Settings.init()`, so user `~/.omp` config never leaks into the session. Residual gap: `ssh://` internal-read protocol is NOT settings-gated; file it under container/Sandbox isolation for production.
2. **One session per review, dispose in `finally`, fresh `mkdtemp` cwd.** Never reuse sessions across requests; never run with cwd = repo root.
3. **Parse defensively**: model output → trim → `JSON.parse`; only on parse failure try ` ```json ` fence, then bare fence, then first-`{`..last-`}`. After ANY successful parse, run schema validation exactly once and return — never retry extraction after a schema miss (that silently recovers rejected payloads like `[{...valid finding...}]`).
4. **Degrade, don't crash**: schema failure → summary mode carrying the raw assistant text; session-level failure → explicit error (CLI exits non-zero with stderr only).
5. **Version discipline**: pin the SDK exactly; record plugin version in outputs; expect fast API iteration.

## Why This Matters

These gates are the product's security boundary: reviewer sessions handle untrusted PR content. The fetch-isolation and no-retry-parse findings were both raised by QC after initial implementation looked green — surface-level whitelist checks miss them.

## When to Apply

Any `pi-coding-agent` embedding that must be read-only and offline. For multi-tenant/target-repo work, add Cloudflare Sandbox per-repo isolation on top (M1 plan).

## Examples

Working reference: `src/review/session.ts` + `src/review/schema.ts` (integration branch `iteration/iter-001-20260825`). Live evidence: raw output 9423 chars → 5 findings (smoke), CLI e2e 4 then 3 findings, verdict `request_changes`, ~136 s per review — budget queue timeouts accordingly.
