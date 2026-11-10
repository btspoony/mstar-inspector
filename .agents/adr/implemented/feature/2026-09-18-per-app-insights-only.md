# ADR: Remove the global insights face

Status: implemented — Insights are App-scoped and restricted to App managers.

## Problem

Membership-only global insights expose every App’s repositories, findings and verdicts to members, despite there being no legitimate global member consumer.

## Decision

Insights exist only as a manager-gated per-App tab and data endpoint. The global page, navigation, SPA route and summary endpoint are removed for everyone.

## Alternatives considered

- **Keep membership-gated global insights:** the source identifies cross-App audit-data exposure and no legitimate member-wide consumer.
- **Add an admin-only global variant:** the source explicitly rejects it because insights have no global concept.

## Consequences

Each App has an insights home on its detail face, with creator/admin authorization. Non-managers retain identity-only detail access and receive 403 for insights. Both the main aggregates and opt-in repository list must compose the App filter to avoid leaking other Apps’ repository names.
