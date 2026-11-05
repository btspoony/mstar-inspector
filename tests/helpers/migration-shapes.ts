/**
 * Hand-listed migration shapes for the worker fixtures, plus the ONE
 * declaration of what the derived tail needs below its anchor.
 *
 * A fixture rebuilds production's schema up to a point by hand, then appends
 * `migrationsAfter(TAIL_ANCHOR)` so a new migration joins without a lockstep
 * edit. That tail may index a table a hand-listed shape skipped, so every
 * below-anchor prerequisite lives in `TAIL_PREREQUISITES` here — one place,
 * spread by every shape — instead of a per-fixture copy of the same rationale.
 *
 * The prerequisite migrations create only their own tables, and nothing between
 * their old slot and the tail references them (only 0047/0048 do), so a shape
 * applies the pair at the first one's old position and still produces the
 * identical schema.
 *
 * `tests/store/helpers.test.ts` enforces that coverage: it parses every tail
 * migration's `CREATE INDEX … ON <table>` / `ALTER TABLE <table>` targets and
 * asserts each table exists when the tail reaches it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsAfter, type TestD1 } from "../store/helpers";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

/** The 0038 github_apps rebuild every fixture anchors its derived tail on. */
const TAIL_ANCHOR = "0038_webhook_path_drop.sql";

/**
 * Migrations creating the below-anchor tables the derived tail indexes:
 * 0048 indexes review_failures and 0047 indexes review_threads. A future tail
 * migration that touches another below-anchor table adds its creating
 * migration here — never to the individual shapes.
 */
export const TAIL_PREREQUISITES = ["0010_review_failures.sql", "0020_finding_lifecycle.sql"] as const;

/** The directory-derived tail after the shared anchor. */
export const DERIVED_TAIL = migrationsAfter(TAIL_ANCHOR);

/** One migration's DDL — the single place the fixture migrations path is resolved. */
export function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/** Apply migration files verbatim, in the given order (wrangler order = filename order). */
export function applyMigrations(db: TestD1, names: readonly string[]): void {
  for (const name of names) db.raw.exec(migrationSql(name));
}

/** `tests/worker/apps-ui.test.ts` — the Apps management UI world. */
export const APPS_UI_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0007_reviews_app_id_index.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  ...TAIL_PREREQUISITES,
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0022_app_trigger_mode.sql",
  "0023_removed_logins.sql",
  // 0026: createApp also writes the App's workspace mapping.
  "0026_workspaces.sql",
  // 0028: the SPA boot reads pending invites.
  "0028_workspace_invites.sql",
  // 0033: the SPA boot reads the `workspace_creation_open` server flag.
  "0033_platform_admin.sql",
  // 0036: github_apps.slug → webhook_path plus the cached github_slug.
  "0036_app_identity.sql",
  // 0038 rebuilds github_apps, so the fixture must carry every column the
  // rebuild copies.
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  ...DERIVED_TAIL,
];

/** `tests/worker/provider-verify.test.ts` — pre-0015 provider tables, tests apply 0015. */
export const PROVIDER_VERIFY_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  // 0036: the cached github_slug column (createApp writes it).
  "0036_app_identity.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  ...TAIL_PREREQUISITES,
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  // 0026: createApp's atomic app_workspaces mapping.
  "0026_workspaces.sql",
  // 0038 rebuilds github_apps, so the fixture must carry every column the
  // rebuild copies.
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  ...DERIVED_TAIL,
];

/** `tests/worker/spa-page-apis.test.ts` — the SPA JSON faces' world. */
export const SPA_PAGE_APIS_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0007_reviews_app_id_index.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  ...TAIL_PREREQUISITES,
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0015_provider_verification.sql",
  "0017_app_model_chains.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  // The settings face reads the custom-provider KEY pool (the settings key
  // rows cover both pools), so this world needs the per-key shape too.
  "0023_removed_logins.sql",
  "0024_provider_multi_key.sql",
  // 0026: createApp also writes the App's workspace mapping.
  "0026_workspaces.sql",
  // 0027/0028: the shell boot names the caller's workspaces (switcher rows)
  // and their pending invites, so this world carries both tables.
  "0027_workspace_backfill.sql",
  "0028_workspace_invites.sql",
  // The shell boot reads the support-grant table, the plan catalogue +
  // subscriptions and `server_flags`, so the dispatch face runs on the
  // production shape.
  "0029_operator_support.sql",
  "0031_plans_usage.sql",
  "0032_unlimited_plan.sql",
  "0033_platform_admin.sql",
  // 0036: github_apps.slug → webhook_path plus the cached github_slug.
  "0036_app_identity.sql",
  // 0038 rebuilds github_apps, so the fixture must carry every column the
  // rebuild copies (0018/0019 already applied above).
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  ...DERIVED_TAIL,
];

/**
 * `tests/worker/webhook-deliveries.test.ts` — the shared prefix of both
 * delivery-recording branches. It carries `TAIL_PREREQUISITES` because the
 * delivery branch appends the derived tail; the failure branch appends none,
 * so there they are incidental (kept only so one shape serves both branches).
 */
export const WEBHOOK_DELIVERIES_MIGRATIONS: readonly string[] = [
  // 0008: the github_apps ops columns (review_enabled / last_webhook_at) the
  // pause gate + touch read and write on every delivery.
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0008_github_apps_ops.sql",
  ...TAIL_PREREQUISITES,
  // 0026: the webhook's slug lookup is the joined tenant read, so the fixture
  // carries the workspace plane and the App's mapping.
  "0026_workspaces.sql",
  // 0033: the enqueue decision reads the `review_global` server flag.
  "0033_platform_admin.sql",
  // 0036: webhook_path (renamed from slug) + the cached github_slug.
  "0036_app_identity.sql",
  // 0038 rebuilds github_apps, so the fixture must carry every column the
  // rebuild copies.
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
];

/** 0011 plus every migration after the 0038 rebuild (the delivery branch's tail). */
export const WEBHOOK_DELIVERIES_TAIL: readonly string[] = ["0011_webhook_deliveries.sql", ...DERIVED_TAIL];

/**
 * `tests/worker/webhook-deliveries.test.ts` failure branch: 0045's table backs
 * the fail-closed owner allowlist every review-triggering delivery reads.
 */
export const WEBHOOK_DELIVERIES_FAILURE_ONLY: readonly string[] = ["0045_review_gate_and_owner_allowlist.sql"];

/**
 * `tests/worker/app-config.test.ts` base: 0001/0002 + a seeded review row, then
 * 0003/0004/0036/0005 (0036 applied early — it only touches github_apps) plus
 * the workspace plane createApp writes.
 */
export const APP_CONFIG_BASE_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  // 0036 renames github_apps.slug → webhook_path and adds github_slug; every
  // fixture that seeds an App through createApp needs it (it only touches
  // github_apps, so applying it early keeps the later files' order intact).
  "0036_app_identity.sql",
  "0005_reviews_app_id.sql",
  // 0026: createApp writes its app_workspaces mapping in the same batch, so
  // every fixture that seeds an App needs the workspace data plane. Applied
  // after 0004 (its FK parent); the file only creates new tables.
  "0026_workspaces.sql",
  // 0028: the SPA boot reads pending invites.
  "0028_workspace_invites.sql",
];

/**
 * `app-config`'s pre-pool shape (0006 → 0038): app_provider_keys still carries
 * ONE row per (App, provider) under the two-segment AAD and app_custom_providers
 * still carries its key column. The sequence is 0006, 0008, 0009, the
 * `TAIL_PREREQUISITES` (0010, 0020), 0011, 0012, 0015, 0017, 0018, 0019, 0022,
 * 0023, 0037, 0038 — so 0010/0020 land before 0011–0019. That early slot is
 * deliberate: 0020 only needs `github_apps(id)` from 0004 and nothing between
 * it and the tail references it, so the produced schema is identical. The 0024
 * migration tests seed this shape, then apply the migration, exactly like the
 * wrangler order on a live deployment.
 */
export const APP_CONFIG_PRE_POOL_MIGRATIONS: readonly string[] = [
  "0006_app_provider_config.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  ...TAIL_PREREQUISITES,
  // 0011: the settings page renders the recent-deliveries panel from
  // webhook_deliveries on every render — the fixture must carry the table or
  // every settings route 500s.
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0015_provider_verification.sql",
  // 0017: the chains store tests + the settings routes run on the chains
  // shape (app_model_chains + app_model_chain_seats).
  "0017_app_model_chains.sql",
  // 0018: the settings routes + the sandbox-image selection run on the shape
  // carrying github_apps.sandbox_image_id.
  "0018_app_sandbox_images.sql",
  // 0019: the settings JSON GET reads/writes the five github_* metadata
  // columns — the route must run on the production shape.
  "0019_github_apps_metadata.sql",
  // 0022: the settings read face serves github_apps.review_trigger_mode and
  // the trigger-mode route validates against the CHECK enum.
  "0022_app_trigger_mode.sql",
  // 0023: createUser clears a removal record in the same batch as its insert.
  "0023_removed_logins.sql",
  // 0037/0038: the metadata-attempt marker plus the github_apps rebuild that
  // drops the local route key — every App seeded through createApp needs the
  // post-0038 shape.
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
];

/**
 * The config routes' shape: 0024/0025 (the per-key pools and their model
 * evidence), 0029/0031–0033 (the support-grant, plan and `server_flags` tables
 * the SPA boot reads), the index-only 0034/0035, then the derived tail.
 */
export const APP_CONFIG_MIGRATIONS: readonly string[] = [
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0029_operator_support.sql",
  "0031_plans_usage.sql",
  "0032_unlimited_plan.sql",
  "0033_platform_admin.sql",
  // 0034/0035 index the support-grant and lapsed-invite predicates: index-only,
  // and they must follow 0029/0028.
  "0034_support_grant_indexes.sql",
  "0035_workspace_invite_expiry_index.sql",
  ...DERIVED_TAIL,
];
