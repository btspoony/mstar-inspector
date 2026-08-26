/**
 * Production Worker entry (deploy) — re-exports the fetch/queue handler from
 * ./index and the Sandbox Durable Object class so the wrangler containers
 * binding resolves (plan 06 T3 fix, review Important 2: `class_name: "Sandbox"`
 * in wrangler.jsonc must be exported from the entry module or deploy fails).
 *
 * Kept as a separate file so the fetch hot path (src/worker/index.ts) never
 * imports the workerd-only @cloudflare/sandbox SDK: the fetch-path tests
 * import ./index directly and stay Bun-runnable without SDK mocks. The SDK
 * import point remains src/pipeline/sandbox.ts (compass contracts A).
 */
export { default } from "./index";
export { Sandbox } from "../pipeline/sandbox";
