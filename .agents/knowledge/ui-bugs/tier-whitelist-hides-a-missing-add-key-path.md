---
module: spa-settings-ui
date: 2026-11-13
problem_type: ui_bug
category: ui-bugs
severity: medium
symptoms:
  - "In App settings, the per-provider Add key button refuses every provider that is not a builtin: the operator sees 'provider returned an unexpected response — nothing was stored'."
  - "The only working workaround is re-opening Add provider and re-submitting the same provider with the new key, which appends it only because that path carries a declaration (base URL + protocol) and never asks the verify route."
  - "The defect is silent in tests: every unit and worker suite passes, because the failing case is a route branch the SPA reaches only through one dialog."
root_cause: "The SPA add-key dialog posts {provider, key} to POST /keys/verify, and the route's first check was !PROVIDER_IDS.includes(provider) -> 400 unexpected. PROVIDER_IDS is the builtin tier only; template-tier and custom declarations live in app_custom_providers. A grouped-providers refactor deleted the custom row's inline form (which used op=add-custom-provider-key) and routed every group through the builtin-only verify dialog, so the declaration pool lost its only append entry point while the server-side op stayed alive and uncalled."
resolution_type: code_fix
topic: provider settings / key pools
tags:
  - provider-tier
  - byok
  - verify-route
  - spa-dialog
  - refactor-regression
  - catalog-labels
---

# A tier whitelist on the verify route hides a missing add-key path

## Problem

An operator configuring a template-tier provider (OpenCode Go, workers-ai, …) or a custom declaration could not store a second key. The Add-key dialog answered "provider returned an unexpected response" for every non-builtin provider, and the operator's only escape was to re-submit the whole Add-provider form with the new key.

## Symptoms

- POST /api/apps/:appId/keys/verify returns 400 {ok:false, reason:"unexpected"} for a provider the App had already configured and used.
- Builtin providers (openai, anthropic, …) were unaffected.
- Re-submitting the provider through Add provider succeeded: op=add-template-provider / op=add-custom-provider verify against the declaration and append, so the same key landed.
- A repository-wide grep showed op=add-custom-provider-key reachable only from the server and its worker test — the SPA had no caller.

## Root cause

Two facts composed into the failure:

1. The verify route treated PROVIDER_IDS (the builtin allowlist) as the universe of providers, so any declared provider was refused before verification.
2. The grouped-providers refactor removed the custom row's inline form that used add-custom-provider-key and pointed every group header at the new Add-key dialog, which only knew the builtin verify path.

The store, the declaration pool and the append action were all intact; the product simply stopped calling them. The route's refusal copy ("unexpected response") described a provider fault for what was a client-side routing gap, which is why the report read like a provider outage.

## What did not work

- Re-typing the key, retrying, and switching providers: all non-builtin providers failed identically.
- Reading provider logs: no request ever left the Worker for these ids — the guard precedes the probe, so a "provider problem" had no provider traffic.
- Treating it as an environment difference: stage and production behaved the same because the code path is the same.

## Fix

- The verify route drops the id whitelist and splits on tier: a builtin keeps its harness precheck + catalog-endpoint verify + app_provider_keys; any other id is read from the App's stored declaration, verified against THAT base URL/protocol/model ids, and appended with addCustomProviderKey; an undeclared id is a keyed 400 with zero writes.
- The verify-and-append body is shared with op=add-custom-provider-key, so the two entry points cannot drift again.
- The model-details editor and the catalog's duplicate labels (one row per protocol, identical label) were fixed in the same change; the label rule now appends the protocol for multi-record providers.

## Prevention

- A route that refuses by an id list should name the tier, not "unexpected response" — a refusal copy that blames the provider sends the reader to the wrong side of the wire.
- When a refactor deletes a UI path, grep the op it used for surviving callers; an op covered only by tests is dead product code.
- Declared providers are first-class: any new provider action must be exercised against a template id and a custom declaration, not just a builtin.
