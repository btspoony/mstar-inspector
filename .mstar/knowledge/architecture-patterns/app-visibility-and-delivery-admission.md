---
module: dashboard-worker
date: 2026-11-04
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
applies_when:
  - deciding whether a GitHub App is public or private
  - adding delivery admission rules to a webhook handler
  - choosing fail-open or fail-closed for a store read on the delivery path
tags: [github-apps, webhook, allowlist, visibility, fail-closed, admission]
---

# App visibility and delivery admission

## App visibility has no API field

`GET /app` (JWT-authenticated) returns the App object without any public/private
flag. There is no authenticated field to read.

The observable difference is anonymous reachability. `GET
https://api.github.com/apps/{slug}` without credentials answers `200` for a
public App and `404` for a private one. Probe it that way:

- `200` -> `public`
- `404` -> `private`
- anything else, or a timeout -> keep the previously stored value

A `404` is ambiguous: it is also what a missing or renamed slug returns, so a
stale cached slug can read as `private`. That no longer costs anything on the
delivery path — admission never reads this cache — and it no longer hides
anything: the owner allowlist control renders for every cached value, with a
note for `private` that the stored list still applies.

The probe runs on two occasions: after
a successful profile fetch, on the slug that fetch resolved (or the already
cached one when the payload carries none); and whenever the owner allowlist is
switched ON, so the control the settings page shows matches the App instead of a
stale cache. An uncertain answer (any other status, or a timeout) keeps the
previously stored value on the refresh path, while the enable path stores
`unknown` — the cache it replaces is exactly what may be wrong.

The probe must not send the App JWT or installation token; authenticating it
would make a private App answer `200` and erase the distinction.

`github_visibility` stays nullable. `null` means never probed, and consumers
must treat it as "cannot prove private", not as `private`. The probe runs
during metadata refresh and on an allowlist enable, so a row created before
this field existed reads `null` until one of those happens.

## Delivery admission runs before any record

An App can restrict review work to a set of repository owners. The switch is
off by default: off filters no owner, so every owner is reviewed as before.

Admission happens after classification and before the first write, for EVERY
cached visibility, and the switch does not scope the read: every classified
delivery that carries a repository owner reads the allowlist row whether the
switch is on or off, so the read failure below fails closed (a `500` GitHub
retries) on an App whose allowlist was never enabled. The switch only decides
whether the owner list is applied. `private` never exempts a delivery and
never hides the control; it only adds a note, so a stale `private` cache can
never leave the gate inert or unmanageable.

With the switch on, the repository owner the payload names decides:

- owner readable and listed -> continue
- owner readable and not listed -> respond `200` with a short body and write
  nothing: no delivery row, no PR ledger row, no `last_webhook_at` update, no
  enqueue
- owner unreadable -> continue; the gate cannot be applied

`200` is deliberate. A refusal is a policy outcome, not a retryable error, and
GitHub redelivers non-2xx responses.

## Read failures on the admission path fail closed

A failed allowlist read refuses the delivery with `500` and writes nothing: no
delivery row, no PR ledger row, no `last_webhook_at` update, no enqueue. GitHub
then retries the delivery.

The direction is deliberate, and it is the opposite of the earlier fail-open
choice:

- the read IS the gate: "cannot read" must not mean "admit every owner"
- a degraded D1 costs delayed deliveries (GitHub redelivers 5xx), never
  silently admitted work
- a store error and a null on an App row resolved moments earlier are both
  "unknown", so both refuse — the operator sees
  `owner_allowlist_read_failed` / `owner_allowlist_row_vanished`

A refusal the gate DOES produce is log-only (`owner_not_allowlisted`): the
delivery ledger never counts refusals, so an outage-caused refusal is
distinguishable by its `500`-warn event, not by any ledger row.

The Check path takes the same direction on unreadable configuration: an App row
or review row that cannot be read concludes `failure`, because a pass would
assert a review bar that was never evaluated. Both gates treat an unreadable
input as a refusal to pass; only the surface differs — a `500` GitHub retries
versus a Check conclusion a human reads.
