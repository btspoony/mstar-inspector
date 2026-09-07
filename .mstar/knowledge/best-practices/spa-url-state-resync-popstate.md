---
module: dashboard / SPA URL-derived page state (router popstate contract)
date: 2026-09-07
last_updated: 2026-09-07
description: "Pages with URL-derived state must re-derive from location via one []-mounted popstate listener on shared pure helpers: navigate() dispatches a synthetic popstate so pushes and history both reach the page, replaceState writes never fire it (loop-free), and remount-key is inert (setPath same-path bail)"
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 49-dashboard-polish-r2
source_plan: 49-dashboard-polish-r2 (T2; ruling spec 015-scope.md AD-1)
status: active
tags:
  - spa
  - router
  - popstate
  - url-state
  - insights-page
---

# SPA URL-state re-sync on same-route navigation: the synthetic popstate contract

## Context

The dashboard SPA (`src/spa/`) has a hand-rolled router (`router.tsx`) and several pages whose state is URL-coupled (the Insights records page derives `window`/`repo` filters from `?window=`/`?repo=`). Page state initializes from `location.search` **once at mount**; the router never remounts a page on same-path navigation, and history traversal does not re-run mount code. Audit finding F-15-02 (iteration 015): with a filter applied, clicking the sidebar link for the same route — or history back/forward — rewrote the address bar while the page kept its old filter. URL and state diverged silently.

## Guidance

**The router's contract (verified in `src/spa/router.tsx`):**

1. `navigate(href)` calls `pushState`, then **synchronously dispatches a synthetic `popstate` event**. Native back/forward fires real `popstate`. So **every URL transition the app can produce — push or history — reaches the current page as a `popstate`**.
2. `usePathname`'s `setPath` bails on `Object.is` pathname equality: a same-route navigation does **not** re-render the shell, does not remount the page, and does not re-evaluate any `key` prop on the routed element. Remount-based resync is inert without shell-wide router changes.
3. `replaceState` (used by `commitSearch` and the plan-36 mount-time normalize rewrite) **never fires `popstate`** — programmatic state→URL writes cannot loop with a popstate listener.

**Therefore, for any page with URL-derived state:**

- Derive initial state from the URL via a **shared module-scope pure function** (e.g. `insightsSearchFromLocation()` built on the pinned `parseInsightsSearch`/`insightsWindow` helpers) — used both as the `useState` initializer and inside the listener, so mount and re-sync cannot drift.
- Add one `[]`-mounted `popstate` listener that **re-derives state from `location`** (state := URL), with `removeEventListener` cleanup.
- Keep all state→URL writes on `replaceState` (`commitSearch`) — URL := state, loop-free by contract.
- Do **not** reach for a `key={location.search}` remount: it is inert for same-route pushes (bail-out above) and, even if wired up, trades a cheap re-derive for a full unmount/refetch flash.

Recorded semantics (spec 015 AD-1): after navigation, **state equals what the URL says**; after in-page edits, **the URL equals what state says**. Consistency is the invariant — a same-route click to the bare path legitimately resets both.

## Why This Matters

Without the listener, every URL-coupled page silently diverges from the address bar on the most common operator action (clicking the sidebar link for the page they're on). The bug is invisible in tests that only mount-and-assert; it needs a popstate-path pin. The dispatch-site census matters too: exactly one synthetic dispatch exists (`router.tsx`), so the listener cannot double-fire from app code.

## When to Apply

- Any `src/spa/pages/*` component that reads `location.search`/`location.hash` into state.
- Any future page added to `pages.tsx`: if it parses the query at mount, it needs the popstate re-derive.
- When reviewing: check for the listener + cleanup + shared-derivation trio, and for pins covering **both** the same-route-click path (synthetic popstate) and the history path (native popstate) — see `tests/spa/insights-page.test.ts` (3 pins: two paths + no-loop guard).

## Examples

- `src/spa/pages/InsightsPage.tsx` — `insightsSearchFromLocation()` + `[]`-effect popstate listener (plan 49 Task 2, commit `3b7796a`).
- Negative precedent (audit F-15-02 / plan-36 QC F-002 tension): mount-time `normalizeWindowSearch` `replaceState` rewrite stayed byte-identical — the resync must not rewrite the URL on mount, only read it.
- Rejected alternative on record: `pages.tsx` remount-key (AD-1 ruling; inert per bail-out #2, and a refetch/flash regression even if fixed).
