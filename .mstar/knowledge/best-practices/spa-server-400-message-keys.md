---
module: dashboard / server-400 message-key localization (worker inventory + SPA resolver)
date: 2026-09-06
last_updated: 2026-09-06
description: "Plain-text server 400s localize via a compile-gated key inventory: worker emits { key, message, params? } with the English face interpolated from the same dictionary entry; the SPA resolves t(key) through an isDictionaryKey gate with a never-blank fallback chain"
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 45-dashboard-uiux-polish
source_plan: 45-dashboard-uiux-polish (T4; contract amendments ratified in plan)
status: active
tags:
  - i18n
  - spa
  - worker
  - error-copy
  - hono
---

# SPA server-400 message-key localization

## Context

Before plan 45 (iteration 014), ~50 plain-text server 400 sites on the dashboard settings family surfaced raw English to zh_CN operators, while structured reasons (verify/membership) already localized. The task: localize without breaking (a) `.toContain(<English substring>)` worker pins, (b) native HTML-form posts that never see the response body (302), and (c) the fail-visible principle — no failure surface may render blank.

## Guidance

1. **Worker side — one compile-gated inventory, one emitter.**
   - `SETTINGS_400_KEYS` is a single `as const satisfies Record<string, DictionaryKey>` map: every key is compile-checked against the dictionary, so an orphan entry or a typo cannot compile. Runtime access is O(1) per call site.
   - `settings400Response(c, slug, key, params?)` emits `c.json({ key, message, params? }, 400)` where **`message = t("en", key, params)`** — the English face is *interpolated from the same dictionary entry*, making face/dictionary drift structurally impossible. Existing English-substring pins survive unedited because the face still rides in `message`.
   - `settingsPostResponse` narrowed to `200 | 500`: after this contract, a raw-text 400 in the settings family **cannot compile** — the type system enforces the migration is total.
   - Keep the inventory as the mapping table of record (site → key), not scattered literals.

2. **SPA side — key-first resolution behind a dictionary gate.**
   - `isDictionaryKey` (`src/i18n/t.ts`) walks the dictionary tree with the same traversal as `lookup`, rejecting prototype-path segments (`constructor`/`__proto__`) and non-string nodes — the validator and resolver cannot diverge. This also guards against version skew: a NEWER server naming a key an OLDER client bundle lacks falls through safely.
   - Resolution order in `settingsErrorMessage`: `parsed.key` present AND `isDictionaryKey(parsed.key)` → `t(locale, key, params)`; else membership `code` → `t()` (existing structured family); else the English `message` face; else raw `body.trim()`. **Never blank — fail-visible at every rung.**
   - All raw-body render paths (including pinned-op helpers) route through the ONE resolver; do not add second render paths.

3. **Extending structured families is additive-safe.** The closed `{ ok, reason }` verify family gained optional `key`/`message`/`params` for the runtime-image eligibility cause without a new reason value: stale clients read `reason` only; new clients prefer the mapped key. Both directions pinned.

4. **Scope discipline.** Structured verify/membership reasons keep their existing mapping; native-form 302 paths never see the body (the English face loses no consumer); unmapped/future server text renders raw by design — mapping is opt-in per site, and "no raw-English site survives" is enforced by the narrowed response type, not by hope.

## Why This Matters

The naive alternative — translating at the render layer by matching English substrings — is unmaintainable and drifts silently. The inventory-plus-interpolation design turns "all 400s are localized" into a compile-time property, keeps every existing test pin green, and gives a safe fallback chain for skew in both directions.

## When to Apply

- Any Worker-served surface where operator-facing error copy must be bilingual.
- Extending an existing structured JSON error family without breaking older clients: add optional fields, never new required semantics.
- When adding a new plain-text 400: add the key to the inventory in the same change (the type system will force you).

## Examples

- Plan 45 T4 (`src/dashboard/index.ts` `SETTINGS_400_KEYS` + `settings400Response`; `src/spa/pages/SettingsPage.tsx` `settingsErrorMessage`; `src/i18n/t.ts` `isDictionaryKey`), tests `tests/worker/settings-400-keys.test.ts` / `tests/spa/settings-error-keys.test.ts`.
- Related contracts: `dashboard-spa-shell-dispatch.md` (SPA shell dispatch + i18n chain), `spa-op-refresh-background-reload.md` (op feedback placement), `dashboard-provider-catalog-ai-sdk.md` (structured verify reasons).
