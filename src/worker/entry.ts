/**
 * Production Worker entry (deploy) — re-exports the fetch/queue/scheduled
 * handler from ./index and the SandboxV1 Durable Object class so the wrangler
 * containers
 * binding resolves (review Important 2: `class_name: "SandboxV1"`
 * in wrangler.jsonc must be exported from the entry module or deploy fails).
 *
 * Kept as a separate file so the fetch hot path (src/worker/index.ts) never
 * imports the workerd-only `cloudflare:workers` builtin (via the sandbox
 * adapter): the fetch-path tests
 * import ./index directly and stay Bun-runnable without builtin mocks. The
 * runtime import point remains src/pipeline/sandbox.ts (compass contracts A).
 */
export { default } from "./index";
// `SandboxV1` is the live review-sandbox implementation and the ONLY class the
// wrangler CONTAINER config names (`class_name`); `Sandbox` exists solely so
// the retained `v1` `new_sqlite_classes` entry stays replayable on a fresh
// deploy (it has no container entry). Both must be exported from this entry
// module — see src/pipeline/sandbox.ts for the compatibility class contract.
export { Sandbox, SandboxV1 } from "../pipeline/sandbox";
