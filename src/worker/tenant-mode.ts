/**
 * `WORKSPACE_TENANT_MODE` (migration 0026 data plane) — the ONE runtime
 * reader of the deploy-level tenant read mode.
 *
 * Deploy wiring supplies the value (`wrangler deploy --var
 * WORKSPACE_TENANT_MODE:<off|strict>`, both workflows); every face that acts
 * on it (the queue consumer's App reads, the dashboard routing gate) resolves
 * it through here, so the two cannot drift and neither has a private fallback.
 */
export type TenantMode = "off" | "strict";

/**
 * Unset / empty → `off` (the pre-0026 face). The two legal values pass
 * through unchanged. Anything else throws: a typo'd deploy var must fail the
 * face it governs instead of silently downgrading to `off` — the dashboard
 * answers 500 and the consumer throws before it touches a message.
 */
export function tenantModeOf(value: string | undefined): TenantMode {
  if (value === undefined || value === "") return "off";
  if (value === "off" || value === "strict") return value;
  throw new Error(`invalid WORKSPACE_TENANT_MODE ${value} — expected "off" or "strict"`);
}
