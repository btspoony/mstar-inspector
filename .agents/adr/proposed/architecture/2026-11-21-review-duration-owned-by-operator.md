# ADR: Put the hard end-to-end review duration cap under operator control
Status: proposed — the cap's owner is decided, but its value requires duration evidence and the cap has not shipped
Spec: docs/specs/architecture/review-budget.md § Known limits

## Problem

The [Queue invocation clock](../../../../docs/specs/architecture/review-budget.md#one-round-clock) describes the non-configurable platform cap the current review derives its budget from. A [handoff beyond that ceiling](../../../../docs/specs/architecture/review-budget.md#known-limits) removes the Queue invocation bound ([Cloudflare wall-time limits by invocation type](https://developers.cloudflare.com/workflows/reference/limits/#wall-time-limits-by-invocation-type)); this decision makes the replacement cap configurable and operator-owned.

## Proposal

The platform operator will own one hard end-to-end cap on the Workflow route. The narrowest surface for this platform-wide number is one system row in the existing operator admin runtime settings (`review_runtime_settings`, `/api/runtime`; `AGENTS.md:79–95`).

Before setting the number, the operator needs a duration analysis report in operator admin. It must show the distribution of observed review durations and separate queue wait, execution, and publication or recovery time so the operator can judge what the cap would cut off. This record sets neither the value nor the clock origin.

## Alternatives considered

- **Workspace-level duration limits.** Workspaces are billed per review, not per minute (`src/store/usage-store.ts:2–5,26–42`). A tenant-side duration limit has no cost rationale under that billing model; the cap addresses platform runtime and capacity.
- **App-level duration limits.** Copying the same platform cap across Apps fragments one operating policy and lets the values drift, without an App-specific reason to differ.

## Acceptance criteria

- The operator can point to the admin duration analysis report as evidence for the chosen value and set it in the single system runtime setting, with no workspace or App overrides. The Workflow route enforces the cap end to end.
- The change that adds enforcement must ship the configuration surface and document and enforce the absent-row default: which cap applies before the operator saves a value (`AGENTS.md:79–95`).

## Risks

A cap set from averages alone can cut off valid long reviews; a cap set too high lets slow reviews hold shared capacity longer. The report must expose the upper tail before the operator sets the value.

The customer outcome is unresolved if the cap terminates a review that has already consumed paid work. What the customer receives and whether the review is billed must be decided alongside the cap's value.
