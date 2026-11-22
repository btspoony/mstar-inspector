# ADR: Make durable claims through evidence-coupled transitions
Status: implemented — the rule is shipped as spec §7.9a and applied by four plans' guards
Spec: docs/specs/feature/review-lifecycle.md § 7.9a Evidence-coupled transitions

## Problem

The same mistake keeps surviving local fixes: a writer stores what it expects to happen, and a later reader treats the record as evidence that it happened. A settlement stamp can shorten an operator's duration report while work is still owed; a fence can admit two callers that each won a different claim. Persistence makes either mistake survive a restart. The [publication journal](../../../../docs/specs/feature/review-lifecycle.md#77-publication-journal-complete-payload-and-crash-recovery) already separates prepared intent, remote confirmation and local apply; other records needed the same rule, without another store or protocol.

## Decision

Every durable record used to assert an outcome, close an obligation or authorize a side effect passes the **evidence-coupled transition**:

> A committed record proves a claim only if it binds the exact subject and generation, every writer commits it under a guard requiring sufficient evidence for that claim, and the evidence still applies at the point of use.

Three checks apply to each such record, and to every path that can set or preserve it, including recovery and backfill:

1. **Binding** — the record binds its evidence to the same subject, generation and operation the reader asks about, using the identity fixed when the work was admitted or staged.
2. **Evidence** — the writer names the source and the exact condition it checks. A local transition establishes its own effect; a remote outcome needs a validated response or readback for the exact target and outcome. Absence is not a witness unless an enforced invariant excludes the missing event.
3. **Guarded commit and use** — the transition that sets the claim enforces the binding and its evidence and commits the evidence (or its durable reference) with it; competing claims of authority contend on the same conditional transition and use its committed result, never a later lookup; mutable conditions are rechecked at the point of use.

A missing answer is a fail. **Falsification test:** if any path can commit the same claim-bearing record while the asserted fact is false or unobserved — after an interruption, a lost reply or a competing write — the record is not proof of that claim.

The rule forbids promoting an in-memory counter, elapsed duration, local flag, exception class, message substring, entry stamp, bare missing row or re-derived identity into a claim it does not establish; splitting proof from its guarded transition; naming an attempted effect as an observed one; using a read as a destructive claim; and using a lease or a deadline as proof of remote completion or process death. Those values remain usable as diagnostics, scheduling inputs or evidence of a narrower fact they do establish.

## Alternatives considered

- **Keep fixing each consumer's inference.** Preserves availability when evidence is missing, but leaves the choice of proxy to whoever writes next; the writer can still commit the same terminal mark before or after the real event, so the reader inherits the ambiguity.
- **Let a persisted enum or a schema constraint suffice.** Catches malformed rows, not a valid-looking outcome produced from a timeout, an entry stamp or evidence for another generation. The writer's evidence guard is load-bearing.
- **Add a common proof service or journal.** A second record cannot observe a missing remote fact or validate a claim written elsewhere; it adds a handoff and a new place for the claim and its evidence to diverge.

## Consequences

Applied across the iteration that adopted it:

- The launch row's state is coupled to its facts by schema CHECKs; destruction requires a won cleanup claim; `launched` is never destroyable. A rejected exec, lost reply, stream error, timeout or restart is `unknown` and authorizes nothing.
- Every rejection on the attempt path — provisioning claim, marker claim, replay proof, launch claim, result write — is `unknown` rather than a settleable failure.
- A phase records only what it observed; no later phase infers an outcome from a local absence.
- Identity (attempt key and Check generation) is frozen at creation; a moved head is a new attempt.
- A terminal conclusion recorded without proof carries a mark and is corrected exactly once when its own publication confirms; a frozen category is not rewritten by a later write.
- The operator's duration report measures a sample only when its settlement recorded the obligation as discharged, counts five named exclusions, and states that delivery idempotency is not part of the interval.
- The write control shows no number the store did not return; between a save's dispatch and a successful re-read it shows that it does not know.

Costs, taken deliberately and recorded as issues rather than patched: a container whose stop cannot be observed is retained (its absolute reclamation bound is unverified); an unresolved degraded delete excludes its target permanently; an unconfirmed mark is retained indefinitely; a scope-mismatched link can sort ahead of due work. Transformed-output confidentiality is **not** covered — proof of which attempt produced a result does not prove the result is safe to disclose.

The rule decides whether the evidence on hand warrants a claim. It does not decide which obligation the product should require, whether missing evidence will arrive, or how a remote service orders requests already sent. Where the platform cannot establish a fact, the record must not certify it; whether to require an observable guarantee before enabling such a path is the deployment owner's decision.
