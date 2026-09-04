---
module: spa-settings-ui
date: 2026-09-04
problem_type: ui_bug
category: ui-bugs
severity: medium
symptoms:
  - "shadcn/Radix Tabs with forceMount renders ALL tab panels visible simultaneously (page reads as the old stacked list plus a decorative tab strip)"
  - "Tab strip changes data-state/aria-selected but nothing is hidden; N visible tabpanels vs 1 aria-selected trigger"
  - "Tests pass and typecheck is clean because no CSS/DOM assertion covers visibility of inactive panels"
root_cause: "Radix TabsContent renders hidden via Presence (hidden: !present); forceMount pins present=true, so `hidden` is never applied — and the repo had no data-[state=inactive] hiding CSS. In-active-panel hiding must be supplied by the consumer when forceMount is used."
resolution_type: code_fix
plan_id: 39-app-detail-model-chains
tags:
  - radix
  - tabs
  - force-mount
  - shadcn
  - accessibility
  - tailwind
---

# Radix Tabs + forceMount does not hide inactive panels

## Problem

Plan 39 wanted chain editors to stay mounted across tab switches (preserve in-progress edits) while showing exactly one panel. Adding `forceMount` to every `TabsContent` kept editors mounted — but also kept them **visible**: the "peer tabs" UI rendered as the old stacked list with a broken tab strip on top. Plan Done criterion 1 was unmet even though the suite was green.

## Symptoms

- All `TabsContent` panels visible at once; tab strip appears decorative
- `aria-selected` on exactly one trigger while N panels are in the accessibility tree as visible
- The in-code comment claiming "Radix applies `hidden` to inactive forced-mounted panels" was factually wrong for the pinned versions

## What Didn't Work

- Trusting the in-code comment / implementer rationale: wrong for `@radix-ui/react-tabs@1.1.21` + `@radix-ui/react-presence@1.1.10` — `hidden: !present` where forceMount pins `present=true` (verified against installed dist, not memory)
- Grepping for a global hiding rule: none existed (`src/**/*.css` had zero `data-[state=inactive]` hits; the shadcn wrapper only had `flex-1 outline-none`)
- Full-suite green as evidence: nothing asserted panel visibility, so the defect was invisible to tests

## Solution

Add the hiding class on the local `TabsContent` wrapper (single consumer verified by grep first):

```tsx
// src/spa/components/ui/tabs.tsx
<TabsContent
  ...
  className={cn("flex-1 outline-none data-[state=inactive]:hidden", className)}
/>
```

Radix emits `data-state="inactive"` independently of presence, so forced-mounted inactive panels get `display:none` while staying mounted (edit state preserved). Pin the mechanism with a source-contract test: the class exists on the wrapper AND the consumer's `forceMount` usages route through it.

## Why This Works

forceMount only changes Presence's lifecycle (`present` always true → children always mounted); visual hiding was always the consumer's job under forceMount. `data-[state=inactive]:hidden` restores the one-visible-panel invariant without giving up the mounting benefit. A11y semantics stay consistent: one `aria-selected` trigger ↔ one non-hidden panel; `display:none` removes inactive panels from the accessibility tree and tab order, so no hidden-focusable hazard.

## Prevention

- When introducing `forceMount`, assume **nothing** is hidden — assert visibility semantics in a source-contract test in the same change
- Correct wrong mechanism comments immediately; a plausible-but-false comment defeated one L2 review layer
- Reviewers: verify component-library behavior against the **installed dependency dist**, not memory or docs
- QA gate should own a real tab-switch render pass when a plan's headline is a tabbed UI
