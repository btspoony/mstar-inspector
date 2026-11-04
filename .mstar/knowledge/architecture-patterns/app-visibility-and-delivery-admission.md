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
tags: [github-apps, webhook, allowlist, visibility, fail-open, admission]
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
stale cached slug can read as `private`. The probe runs only after a successful
profile fetch, on the slug that fetch resolved (or the already cached one when
the payload carries none) — never on its own, which is what keeps that case
rare. An uncertain answer (any other status, or a timeout) keeps the previously
stored value rather than guessing.

The probe must not send the App JWT or installation token; authenticating it
would make a private App answer `200` and erase the distinction.

`github_visibility` stays nullable. `null` means never probed, and consumers
must treat it as "cannot prove private", not as `private`. The probe runs
during metadata refresh, so a row created before this field existed reads
`null` until its next refresh.

## Delivery admission runs before any record

An App can restrict review work to a set of repository owners. The switch is
off by default and off means the pre-existing behavior exactly.

When the switch is on, admission happens after classification and before the
first write:

- owner readable and listed -> continue
- owner readable and not listed -> respond `200` with a short body and write
  nothing: no delivery row, no PR ledger row, no `last_webhook_at` update, no
  enqueue
- owner unreadable -> continue; the gate cannot be applied
- App visibility is `private` -> ignore stored allowlist rows entirely

`200` is deliberate. A refusal is a policy outcome, not a retryable error, and
GitHub redelivers non-2xx responses.

## Read failures on the admission path fail open

A failed allowlist read (store error, timeout, missing row) lets the delivery
proceed, and logs a structured warning. This is the chosen direction, recorded
here because it is not obvious from the code:

- signature verification and installation identity already ran; an attacker
  cannot reach this point without a valid App-signed payload
- the opposite direction silently drops real review work whenever D1 is
  degraded, and the tenant has no surface that would show the drop
- the refusal count of a working allowlist remains visible in the delivery
  ledger, so an outage-caused pass is distinguishable from a policy pass

The Check path takes the opposite direction on unreadable configuration: an
App row or review row that cannot be read concludes `failure`, because a pass
would assert a review bar that was never evaluated. Read failure on an
admission gate and read failure on an evidence gate are not symmetric.
