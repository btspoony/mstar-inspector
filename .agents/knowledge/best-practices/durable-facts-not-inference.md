# Inference is not evidence: designing attempt lifecycles around durable facts

**Problem class:** a pipeline that must decide *what happened to a paid, unobservable process* — collect its result, destroy its container, release its capacity, settle its Check — keeps reaching for something cheap and available: a counter, a timestamp, a timeout, an error class, a local variable. Each of those is a guess dressed as an observation, and every one of them produced a defect that survived multiple review rounds.

**What the reviews actually found, in order of how late they were caught**

| Guess | What it looked like | The defect it caused |
|---|---|---|
| an in-memory counter | `inFlightRuns` | a container destroyed while its paid child still ran |
| a duration | "it has been longer than the timeout" | same, one layer up |
| a local flag | `runnerStartedAt` unset ⇒ never paid | a resumed host destroying a running attempt |
| an error class | `TypeError` ⇒ the call did not land | admitting a second run beside a live one |
| a message substring | `"already exists"` ⇒ the instance exists | believing a create succeeded when it did not |
| an entry mark | `settled_ms` written at the start | a settlement certified as done that never ran |
| "no row" | absent ⇒ nothing was provisioned | a second cleanup releasing capacity a first still owned |
| a derived key | recompute `attempt_key` at publication | associating the wrong Check row |

**The shape of the fix, stated once**

1. **A row, not a variable, owns the decision.** The attempt row carries its state, and the state schema couples each state to its facts (`CHECK ((result_json IS NOT NULL) = (state = 'persisted'))`). Recording an outcome *is* the transition; there is no state in which "terminal but missing its fact" can exist.
2. **Destruction is authorised by a claim, not by a read.** Cleanup writes the row into a cleanup-owned state and destroys only when that write reports the row. "There is no row" is a state read like any other and gets the same treatment.
3. **Only two facts authorise destruction:** the paid call returned a status and that outcome is durably written, or the attempt never reached the paid call. Everything else — rejected exec, lost reply, stream error, timeout, restart, expired lease — is `unknown`, and `unknown` destroys nothing and releases nothing.
4. **Every rejection is `unknown`.** Provisioning claim, marker claim, replay proof, launch claim, result write: six paths, one rule. A rejection does not tell you whether the effect landed.
5. **A phase records only what it observed.** The phase that sees a nonzero exit writes `failed`; nobody infers it later from a local absence.
6. **Identity is frozen at creation** (key *and* generation) and read from the row afterwards. A moved head is a new attempt, not a mutation of the old one.
7. **Completion is proven, not entered.** A mark either records which effects landed and replays the rest, or it does not exist.

**Why this matters more than the numbers**

The first production framing was "we need more than 900 s". The actual defect was that *execution lifetime was tied to a queue message*, which left every guarantee — one paid call, one hard stop, one owner — to be re-derived inside a box with no room for them. Fixing the number would have moved the boundary; the six-state row removed the need to guess.

**Transferable tests**

- *A test that cannot fail is not evidence.* Every contract claim needs a mutation: revert the fix, watch the named test go red. Review found three tests that asserted a shape both before and after the fix.
- *A record written after its effect cannot recover it.* Order every handoff record before the thing it protects.
- *A partial-completion record needs a named replayer*, or it is a silent stall. Name the owner, the quiet window and the row bound.
- *An interruption test beats a happy-path test* for anything that spans a process boundary: seed the failpoint where the host dies, not the state you hope it left.

**Known limits, recorded rather than papered over**

- A container suspended between reading its clock and starting its bound may overrun; no SDK watchdog exists.
- A stranded container has no verified absolute reclamation bound.
- Exact-value redaction misses a transformed echo; a shape pass corrupts the envelope.
- A settlement replayer grown under review pressure needs a design pass, not another patch.

## Corollary: a surface may not claim more than its evidence

The same rule applies to what an operator *reads*, not only to what the system stores. Three shapes recurred across the duration report and its write control:

| Shape | What it looked like | What replaced it |
|---|---|---|
| A distribution that silently drops what it cannot measure | percentiles over a cohort whose end boundary was written early | five counted exclusions with a tested accounting identity, disclosed on the surface |
| A number the store may not hold | the card rendering its own save echo | re-read after save; on any doubt show *that it does not know*, never a candidate value |
| A statement broader than the record | "obligations are proven closed" / "every sample has a concluded Check" | the conditional the code actually implements |

Two rules fall out, both cheap to apply and expensive to skip:

1. **A rejection is not an observation.** A 4xx proves the store did not change *this time*; it says nothing about what happened between the last read and now. Re-read, or show unknown.
2. **A sentence must be derivable from the selection code.** If a claim needs a condition the code does not enforce, the sentence is wrong — not the code. "Where the attempt has a frozen Check" is honest; "every sample has a concluded Check" is not, even when most do.

The failure mode this prevents is quiet: nothing errors, no test turns red, and an operator makes a costly decision on a number that was never true.
