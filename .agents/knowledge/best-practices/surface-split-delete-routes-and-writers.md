---
module: dashboard IA / route ownership
date: 2026-11-17
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - an entity's configuration is split across two surfaces
  - a page stops owning a section but its handler routes remain
  - a split is implemented in the render tree first
tags:
  - dashboard
  - route-ownership
  - dead-code
  - surface-split
  - qc
related_components:
  - dashboard-routes
  - app-detail-page
  - repository-detail-page
---

# A surface split is not done until the route table and the old writers are gone

## Problem

Moving review policy from the app surface to the repository surface was implemented in the render tree: the new page mounted the policy form, the app page stopped rendering it. The app's POST routes still existed, and the old settings component still mounted a manager branch that posted to them. Tests kept the dead writers green by stubbing `fetch`, so nothing failed while two surfaces could write the same store.

## Why it matters

- A reachable-but-unrendered writer is a second authority: a saved form, a stale bundle, or a direct POST still changes the record the new surface owns.
- A dead branch in a component keeps importing deleted endpoints; a later rename of the live route leaves it silently writing 404s.
- Test stubs hide the drift: a suite that asserts a wire address against `fetch` passes after the server stops serving it.

## Working practice

1. Split in this order: route table → handler → component → tests. Removing the route first makes every remaining caller a compile/route error instead of a silent 404.
2. Delete the old writers in the same change as the new surface. If a writer serves two entities (bot ops vs target policy), give the remaining surface its own route rather than sharing one.
3. Delete the component's manager branch when its only caller passes `can_manage: false`; a branch that cannot render is not coverage.
4. Tests for a removed surface are deleted with it, not rewritten to a stub of the removed address. Keep tests that assert the surviving surface's contract.
5. When a payload can mean "no entity" or "several entities", make it explicit (`target_id: null` + `targets_many`) and keep the parser fail-closed on every other malformed combination.

## Prevention

- Grep the route table for the old paths after a split; the page's absence from `render` is not evidence.
- Treat a component branch with no reachable caller as dead code, even if its tests pass.
- Prefer one writer per stored fact; a second surface that needs the same fact calls the first surface's route.
