# ADR: Make durable claims through evidence-coupled transitions
Status: proposed — the guards are not yet implemented and verified
Spec: docs/specs/feature/review-lifecycle.md § 7.9a Evidence-coupled transitions

## Problem

The same mistake keeps surviving local fixes: a writer stores what it expects to happen, and a later reader treats the record as evidence that it happened. A settlement stamp can shorten an operator's duration report while work is still owed; a fence can admit two callers that each won a different claim. Persistence makes either mistake survive a restart. The [publication journal](../../../../docs/specs/feature/review-lifecycle.md#77-publication-journal-complete-payload-and-crash-recovery) already separates prepared intent, remote confirmation, and local apply. We need a rule for deciding which other records deserve the same trust, without inventing another store or protocol.

## Proposal

Adopt the **evidence-coupled transition** as the review rule for any durable record used to assert an outcome, close an obligation, or authorize a side effect.

This iteration applies [§7.9a](../../../../docs/specs/feature/review-lifecycle.md#79a-evidence-coupled-transitions) as the review criterion. Promote this record to `implemented/` when the guards required by that criterion are implemented and verified.

**Decision rule: A committed record proves a claim only if it binds the exact subject and generation, every writer of the claim commits it under a guard requiring sufficient evidence for that claim, and the evidence still applies at the point of use.**

To apply the rule, name the fact, its subject and generation, and whether it describes a past event or current authority. For each path that can set or preserve the claim, including recovery and backfill, point to three things:

1. **Binding.** The record binds the evidence to the same subject, generation, and operation the reader is asking about. Use the identity frozen by the owning transition, not a key rebuilt from mutable inputs or a nearby record selected by recency.
2. **Evidence.** Name the source and the exact condition the writer checks. A local fact can be established by the committing operation itself; a remote fact needs a validated response or readback that establishes the promised outcome on the exact target. Facts may be derived from already proven inputs if the derivation entails the stated claim. Absence is not a witness unless an enforced invariant excludes the missing event; for mutually exclusive actions, a winning conditional claim can establish that exclusion where a lookup cannot.
3. **Commit and use.** Point to the write that records the evidence (or binds its durable reference) and sets the claim together. Schema constraints can exclude invalid state/evidence combinations; the writer's guard establishes what the evidence means. For claims of authority, conflicting local actions must contend on the same authoritative decision, and a successful conditional mutation must return its own committed result (for example, `RETURNING`), not borrow a row from a later lookup. Recheck mutable authority at use; an acquisition proves who won then, not that they still own it or that an earlier remote request was canceled.

A missing answer is a fail: the record is not proof of that claim. **One-line falsification test:** Can a writer commit the same claim-bearing record with the claimed fact false or unobserved—for example after an interruption, a lost reply, or a competing write? If yes, reject the claim.

This is the shape of the six-state retention decision: the state and its required facts are coupled; destruction on the never-launched path follows a winning claim even when the initial lookup found nothing. A rejection on an ambiguous path remains `unknown`. The same shape permits settlement only when each required obligation has proof of closure or explicit unconfirmed closure under its own policy. Across a remote boundary, record owed work before the call and record observed completion only after matching evidence comes back. The existing [Check intent versus observation contract](../../../../docs/specs/feature/review-lifecycle.md#79-app-owned-check-attempt-fencing-and-conclusions) and [inline apply fence](../../../../docs/specs/feature/review-lifecycle.md#7113-local-apply-separate-chunking-and-the-inline-lease-fence) show why neither an intent nor an earlier probe can serve as that evidence.

**Forbidden:** promoting an in-memory counter, elapsed duration, local flag, exception class, message substring, entry stamp, bare missing row, or re-derived identity into a claim it does not establish. Also forbidden: splitting proof from the guarded transition, naming an attempted effect as an observed one, using a read as a destructive claim, or using a lease or deadline as proof of remote completion or process death. These values may still be diagnostics, scheduling inputs, or evidence of a narrower fact they actually establish.

### Issue coverage

Coverage means the rule decides the disputed claim, not that the issue is fixed.

| Open issue | Coverage | What the rule decides—and what remains |
|---|---|---|
| `I-000665` — Settlement replayer | Partial | Entry cannot prove completion. A replay can certify Check completion only from evidence matching the exact attempt and required terminal update; an unproven obligation stays owed or explicitly unconfirmed. This does not choose which recovery lane owns pre-launch failures, which effects it may perform, or how a permanently refused row is kept from starving the queue. |
| `I-000666` — Transformed credential echo | Separate concern | A record can prove which attempt returned a result and still store unsafe bytes. Exact-value matching misses transformed echoes; an envelope-wide shape pass can damage valid metadata. Output-aware redaction and envelope preservation need their own design and tests. A persisted result is not a confidentiality guarantee, and this ADR does not clear the deployment gate. |
| `I-000667` — Duration report end boundary | Covered | `settled_ms` can contribute to the timed cohort only when the same attempt's required publication and Check work is proven discharged, with explicit unconfirmed closure kept distinct. A missing launch or matching Check record proves no such thing; an attempt with a missed final write, an unhandled recovered Check, or no pre-prepare boundary remains excluded with a reason unless closure can be proven. The rule does not turn exclusions into durations or guarantee they eventually become measurable. |
| `I-000668` — Terminal status and deadline | Partial | A named clock requires an observed stop tied to the binding limit at enforcement; elapsed time or the runner's generic stop alone is insufficient. Settlers must use the frozen winning fields, not recompute a conclusion or silently widen the live deadline. The rule exposes the race between known-stop and unknown intent, but does not choose their precedence or whether post-deadline settlement-only writes are permitted, under which authority, and from which durable record. |
| `I-000669` — Publication fence interactions | Partial | Separate winners do not prove global authority over the same action: Check send and recovery must meet at one authority decision, a cleared claim cannot authorize a later line comment, and a delete cannot rely on a fence that ignores newer evidence. The rule rejects these claims but does not assign the no-Check post-apply owner, choose the delete scope, or order already-dispatched relabel and terminal requests at the remote service. |

## Alternatives considered

- **Keep fixing each consumer's inference.** This preserves availability when evidence is missing but keeps changing which proxy a reader trusts. The writer can still commit the same terminal mark before or after the real event, so the next reader inherits the ambiguity.
- **Let a persisted enum or a schema constraint suffice.** This catches malformed rows, not a valid-looking outcome produced from a timeout, an entry stamp, or evidence for another generation. The writer's evidence guard is load-bearing.
- **Add a common proof service or journal.** A second record cannot observe a missing remote fact or validate a claim written elsewhere. It adds another handoff and a new place for the claim and its evidence to diverge; existing domain writers and stores can enforce the rule directly.

## Acceptance criteria

- A reviewer can identify the binding, evidence, and guarded commit for an allowed record and reject an otherwise identical terminal record written before its obligation closes. Removing the decisive guard in an interruption or contention case must expose the false claim.
- Applying the rule distinguishes unknown from false, a winning claim from an eligible read, and an observed outcome from a durable intent, without naming a particular table or requiring new machinery.

## Risks

Conservative claims can keep capacity held, leave a Check pending, or exclude a sample when evidence is missing. This rule decides whether the evidence on hand warrants a claim, not whether evidence will ever arrive, which obligation the product ought to require, or what a platform can observe. For example, if the platform cannot establish that a suspended process stopped by its deadline, the record must not certify it did. The deployment owner must decide whether to require an observable guarantee before enabling the route or explicitly accept the documented operational risk under the existing deployment gate. Such acceptance changes policy, not the fact recorded; it does not change the retention table, the two facts that allow destruction, the unknown-on-rejection rule, or frozen identity.
