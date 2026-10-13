/**
 * The suite's ONE `cloudflare:workers` mock registration — imported for its
 * side effect, before anything else, by every test file that (transitively)
 * loads the sandbox adapter (`src/pipeline/sandbox.ts` is the only importer of
 * the workerd builtin, and Bun's test runner cannot resolve it).
 *
 * Why one shared factory: `mock.module`'s registry for a specifier is shared
 * across the test files a `bun test` process runs, so per-file registrations
 * made the EFFECTIVE `DurableObject` base depend on Bun's file execution
 * order — on CI a bare `class {}` from another file won and every DO
 * construction in tests/pipeline/sandbox.test.ts lost its `ctx`. With a single
 * shared factory the registration order is irrelevant: whichever registration
 * is in effect installs the same ctx/env-storing base. Adding a new test file
 * that needs the builtin imports THIS module instead of calling `mock.module`.
 *
 * The real base only stores `(ctx, env)`; tests drive behaviour through the
 * ctx/container doubles they pass to the subclass.
 */
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
