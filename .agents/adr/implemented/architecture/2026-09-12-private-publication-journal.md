# ADR: Recover publication with a private complete-payload journal

Status: implemented — Publication recovery preserves paid review work across the publish-to-persist crash window.

## Problem

A primary GitHub comment can succeed before result persistence, leaving no durable payload to apply after a crash. Recovery must not rerun a paid review or claim an unproved publication.

## Decision

The Worker stages the validated, redacted complete publication payload privately before the primary send, records positive publication proof, then applies public review/lifecycle rows idempotently. The journal has no result-reader exposure.

## Alternatives considered

- **Comment before any data:** the earlier formulation cannot recover the publish→persist crash window; the explicit private journal exception replaces it.
- **Reconstruct a result from assessments-only data or prose comments:** the source explicitly rejects this because the complete validated envelope and publication identity are required for recovery.

## Consequences

A crash after staging is recoverable without paid replay; public result rows still require proof. Payload and proof are retained on unknown outcomes. Staging failure means pre-publication failure, not a promise that an undurable model result is preserved. GitHub does not offer external exactly-once creation.
