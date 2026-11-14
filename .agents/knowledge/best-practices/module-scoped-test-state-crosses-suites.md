---
module: tests — shared pipeline harness (`tests/helpers/consumer-harness.ts` and the `tests/pipeline/consumer*` suites)
date: 2026-11-14
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - a test helper exports a mutable array or object that several test files import
  - a `reset()`-style hook is the only thing keeping suites apart
  - a helper destructures a namespace from a module-scope `await import`
  - migrating a shared-state test helper to a per-test factory
tags:
  - testing
  - test-harness
  - shared-state
  - module-loading
  - migration
---

# Test state that crosses suites fails for reasons the suite did not test

`assertion-migration-equivalence.md` and `guards-must-state-their-coverage.md` both judge a
replacement *assertion* and whether it is as strong as what it replaced; this page judges the
*shared state* around the assertions — where the recorders live, and which file is allowed to
clear them.

## Context

`tests/helpers/consumer-harness.ts` serves nine suites under `tests/pipeline/` — `consumer.test.ts`
plus eight per-concern files. The runner loads several test files into one process by default, so
the helper is instantiated once and every suite imports the same module instance.

The pre-factory helper published the doubles themselves: `commenterCalls`, `commenterState`,
`fakeCommenter`, `logLines`, `testLog`, `kvState`, `kvPuts`, `queueState`, `messageRetryCalls`,
`messageAckCalls`, `sandbox`, `testOverrides` — plus a `reset()` that zeroed them and a
destructured namespace from a module-scope `await import("../../src/pipeline/consumer")`. Two
independent defects follow: one file's `reset()` clears another file's recorder, and a load that
races yields `undefined` for every destructured binding. Both fail cases for reasons unrelated to
what the case tests.

## Guidance

One factory per test; nothing mutable at module scope.

- `createConsumerHarness()` creates every recorder, the sandbox and commenter doubles, the KV
  double and its `kvState`, the queue counter, and the override pair inside its own call.
- The builders the instance exposes close over that instance: `makeEnv` wires that instance's KV
  double, `makeBatch` declares its gitops commands on that instance's sandbox and records its
  acks/retries on that instance's arrays, `expectFailureRedacted` drives that instance's batch and
  reads the failure rows the caller passed.
- The consumer module is reached through one cached promise, `loadConsumer()`, which rejects when
  the namespace came back without `createReviewConsumer`. The shim import
  (`./cloudflare-workers-mock`) stays above it, and the module type is a type-only namespace
  import (`import type * as consumerModuleNs`), erased at compile time, so nothing can load the
  consumer before the shim is registered.
- `reset()` is deleted. There is no shared recorder to clear, so the hook has nothing to do.
- Suites keep `let h = createConsumerHarness()` and rebuild it in `beforeEach`; a case that
  re-runs a round does `h = createConsumerHarness()` where it would have called `reset()`.

```ts
// tests/helpers/consumer-harness.ts (head)
let consumerLoad: Promise<ConsumerModule> | undefined;

export function loadConsumer(): Promise<ConsumerModule> {
  consumerLoad ??= import("../../src/pipeline/consumer").then((mod) => {
    if (typeof mod.createReviewConsumer !== "function") {
      throw new Error("consumer-harness: consumer loaded without its exports — …");
    }
    return mod;
  });
  return consumerLoad;
}

export function createConsumerHarness(): ConsumerHarness {
  const fakeSandbox = createFakeSandbox();
  const commenterCalls: CommenterCall[] = [];
  const { lines: logLines, log: testLog } = createTestLog();
  const kvPuts: ConsumerHarness["kvPuts"] = [];
  const messageAckCalls: ConsumerHarness["messageAckCalls"] = [];

  function makeBatch(payload: ReviewJobPayload) { /* acks land on messageAckCalls */ }
  // …
  return { fakeSandbox, commenterCalls, logLines, testLog, kvPuts, messageAckCalls, makeBatch, /* … */ };
}
```

The isolation contract is itself a test: `consumer harness isolation > a call recorded on one
instance is invisible to another` records an ack and a commenter op on one instance and asserts
the other instance's two recorders are empty. Sharing one array across instances turns that case
red, which is what makes it a guard rather than a description.

## What Did Not Work

- **A mutable compatibility shim** — keeping the old export names as a facade over a
  "current instance" slot. It preserves the defect under a new name: the slot is exactly the
  cross-suite state the factory removes, so file A's new instance is still visible to file B. It
  is also adopted to keep the branch compiling, and it does not decide that: the branch-wide
  typecheck is red until the last suite stops importing the removed names, which is the migration
  itself. No shim was added.
- **The honest intermediate state.** With the helper's mutable exports gone and eight suites still
  importing them, each unmigrated suite fails at import time (`Export named 'commenterCalls' not
  found …`) and `bun run typecheck` fails, every error `TS2305` (plus its `TS7006` fallout) inside
  those eight files. That is the expected shape of a factory-first landing, and
  the typecheck gate is discharged by the last suite's migration, not by the helper.
- **Treating greenness under `--isolate` as proof.** Isolated runs pass on the broken helper too;
  the defect only exists where several files share the process, which is the default.

## Why This Matters

The two defects have different mechanics and neither is visible per file.

- **`reset()` is a global operation issued per test.** With files interleaved in one process, file
  A's `beforeEach` clears file B's recorder between B's arrange and assert. The failing assertion
  is whatever B happened to write next — a commenter call count, a log line, a KV write, an
  ack/retry sequence — so the failure names neither the helper nor the other file.
- **Destructuring snapshots a namespace.** `const { createReviewConsumer, runnerTimeoutMs } = …`
  copies values at evaluation time. If the load resolves before the namespace is complete, every
  copied binding is `undefined` permanently, and each case fails later at its own call site with
  "x is not a function". A promise that throws inside its `then` rejects at the load, so one suite
  fails once naming the cause instead of every case failing on its own.

The cost is not flakiness alone. A suite that can only be trusted alone, or only with `--isolate`,
has its isolation claim inverted: the harness that exists to make each case independent is the
thing coupling the files.

## The migration check

Migrating a shared-state helper is bookkeeping, not judgement — and only the parts where control
flow changes are worth reading.

- **Per suite, compare the assertion-line multiset, base → head.** Take every line matching
  `expect(` or `toMatchObject(` (both carry assertion subjects), strip the instance qualifier
  (`h.`) and leading whitespace, and compare as multisets so duplicates survive. Eight of nine
  suites are identical; `consumer-recheck-round.test.ts` adds exactly the four lines of the new
  isolation case and retains its original fourteen. A single count is not the check: a lowered
  count is a deletion until proven otherwise, and a raised one needs a reason.
- **Read only the hunks where removing `reset()` changed control flow.** Three shapes, and each
  needs a decision, not a rename: a loop iteration that re-runs a round (rebuild `h` before
  seeding), a case with two rounds (`h = createConsumerHarness()` for the second unless it
  deliberately keeps one consumer with the overrides it was built with, and then clear only the
  knob the retry needs), and a module-scope object that spread a sandbox (it becomes a factory,
  because no sandbox exists at module scope any more). Everything else — `sandbox.x` →
  `h.sandbox.x`, `makeBatch` → `h.makeBatch` — is re-qualification.

## When to Apply

- A helper exports a mutable recorder that more than one test file imports.
- The only thing separating suites is a `reset()`-shaped hook called in `beforeEach`.
- A helper destructures bindings from a module-scope `await import`, or caches a module handle in
  a way that can publish a half-built namespace.
- Migrating any of the above: write the factory first, migrate one suite as the reference, then
  let the branch's typecheck land with the last one.

## Examples

### Before

```ts
// tests/helpers/consumer-harness.ts
export const commenterCalls: CommenterCall[] = [];
export const fakeCommenter = createFakeCommenter(commenterState, commenterCalls);
export const { lines: logLines, log: testLog } = createTestLog();
export const messageAckCalls: Array<{ attempts: number }> = [];

const consumerModule = await import("../../src/pipeline/consumer");
export const { createReviewConsumer, runnerTimeoutMs } = consumerModule;

export function reset(): void {
  commenterCalls.length = 0;
  logLines.length = 0;
  messageAckCalls.length = 0;
}
```

```ts
// a suite
beforeEach(() => reset());        // clears every other file's recorders too
```

### After

```ts
// a suite
const { createReviewConsumer } = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();    // this file's recorders only
});
```
