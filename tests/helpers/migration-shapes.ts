import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigration, execMigrationScript, migrationsAfter, type TestD1 } from "../store/helpers";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

const TAIL_ANCHOR = "0038_webhook_path_drop.sql";

/**
 * why: Migrations creating the below-anchor tables the derived tail reaches: 0048
 * indexes review_failures, 0047 indexes review_threads, and 0052 alters
 * review_checks. A future tail migration that touches another below-anchor
 * table adds its creating migration here — never to the individual shapes.
 */
export const TAIL_PREREQUISITES = [
  "0010_review_failures.sql",
  "0020_finding_lifecycle.sql",
  "0021_review_checks.sql",
  // 0047/0048 and the workspace tail reach this below-anchor table; the
  // shapes that need invites list 0028 themselves.
  "0023_removed_logins.sql",
  "0029_operator_support.sql",
  "0030_workspace_membership_cutover.sql",
  "0031_plans_usage.sql",
  "0032_unlimited_plan.sql",
] as const;

/** note: The directory-derived tail after the shared anchor. */
export const DERIVED_TAIL = migrationsAfter(TAIL_ANCHOR);

/** note: One migration's DDL — the single place the fixture migrations path is resolved. */
export function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/**
 * why: Apply migration files in the given order, each file in ONE transaction
 * with foreign-key enforcement on — the way D1 runs it and the only way SQLite
 * carries child foreign keys onto a renamed parent (the 0056/0115 rename
 * pair). The autocommit statement-by-statement path builds a schema no
 * production database has: renames leave references pointing at the pre-split
 * table (proven: app_workspaces.app_id → review_bots instead of github_apps).
 */
export function applyMigrations(db: TestD1, names: readonly string[]): void {
  // Shapes list migrations in dependency-authoring order, which is NOT always
  // numeric order — but numeric order IS the dependency order (a migration can
  // only reference tables created by lower numbers). Sorting here is the one
  // honest ordering; a mis-sorted list fails before any assertion runs.
  // Numeric order, each migration once: shapes compose shared prerequisite
  // lists, so the same file may appear twice in a composed list.
  const sorted = [...new Set(names)].sort();
  applyMigration(db.raw, sorted);
}

const SHAPES: Record<string, readonly string[]> = {};

function shape(name: string, migrations: readonly string[]): readonly string[] {
  SHAPES[name] = migrations;
  return migrations;
}

export const FIXTURE_SHAPES: Readonly<Record<string, readonly string[]>> = SHAPES;

/** note: `tests/worker/apps-ui.test.ts` — the Apps management UI world. */
export const APPS_UI_MIGRATIONS = shape("apps-ui", [
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
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0022_app_trigger_mode.sql",
  "0023_removed_logins.sql",
  "0026_workspaces.sql",
  "0028_workspace_invites.sql",
  "0033_platform_admin.sql",
  "0036_app_identity.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  ...DERIVED_TAIL,
]);

/** note: `tests/worker/provider-verify.test.ts` — pre-0015 provider tables, tests apply 0015. */
export const PROVIDER_VERIFY_MIGRATIONS = shape("provider-verify", [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0036_app_identity.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  ...TAIL_PREREQUISITES,
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0026_workspaces.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  ...DERIVED_TAIL.filter((name) => name < "0056_review_bots_rename.sql"),
]);

/** note: `tests/worker/spa-page-apis.test.ts` — the SPA JSON faces' world. */
export const SPA_PAGE_APIS_MIGRATIONS = shape("spa-page-apis", [
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
  "0023_removed_logins.sql",
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0026_workspaces.sql",
  "0027_workspace_backfill.sql",
  "0028_workspace_invites.sql",
  "0033_platform_admin.sql",
  "0036_app_identity.sql",
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  ...DERIVED_TAIL,
]);

/**
 * why: `tests/worker/webhook-deliveries.test.ts` — the shared prefix of both
 * delivery-recording branches. It carries `TAIL_PREREQUISITES` because the
 * delivery branch appends the derived tail; the failure branch appends none,
 * so there they are incidental (kept only so one shape serves both branches).
 */
export const WEBHOOK_DELIVERIES_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0007_reviews_app_id_index.sql",
  "0008_github_apps_ops.sql",
  ...TAIL_PREREQUISITES,
  "0026_workspaces.sql",
  "0023_removed_logins.sql",
  "0028_workspace_invites.sql",
  "0033_platform_admin.sql",
  "0036_app_identity.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
];

/**
 * why: 0011 plus every migration after the 0038 rebuild (the delivery branch's tail).
 * 0012 creates `app_custom_providers`, which a later tail migration alters,
 * and alters `app_provider_keys` (0006) — this shape never applied either in
 * its prefix, so both are listed here at their wrangler position instead of a
 * table-less tail failing at the ALTER.
 */
export const WEBHOOK_DELIVERIES_TAIL: readonly string[] = [
  "0006_app_provider_config.sql",
  "0009_app_model_roles.sql",
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0015_provider_verification.sql",
  "0017_app_model_chains.sql",
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  ...DERIVED_TAIL,
];

shape("webhook-deliveries", [...WEBHOOK_DELIVERIES_MIGRATIONS, ...WEBHOOK_DELIVERIES_TAIL]);

/**
 * why: `tests/worker/app-config.test.ts` base: 0001/0002 + a seeded review row, then
 * 0003/0004/0036/0005 (0036 applied early — it only touches github_apps) plus
 * the workspace plane createApp writes.
 */
export const APP_CONFIG_BASE_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0036_app_identity.sql",
  "0005_reviews_app_id.sql",
  "0007_reviews_app_id_index.sql",
  "0026_workspaces.sql",
  "0028_workspace_invites.sql",
];

/**
 * why: `app-config`'s pre-pool shape (0006 → 0038): app_provider_keys still carries
 * ONE row per (App, provider) under the two-segment AAD and app_custom_providers
 * still carries its key column. The sequence is 0006, 0008, 0009, the
 * `TAIL_PREREQUISITES` (0010, 0020, 0021, 0029, 0031), 0011, 0012, 0015, 0017, 0018, 0019,
 * 0022, 0023, 0037, 0038 — so the prerequisites land before 0011–0019. That
 * early slot is deliberate: 0020 only needs `github_apps(id)` from 0004, 0021
 * only needs `github_apps`/`review_publications`, and nothing between them and
 * the tail references either, so the produced schema is identical. The 0024
 * migration tests seed this shape, then apply the migration, exactly like the
 * wrangler order on a live deployment.
 */
export const APP_CONFIG_PRE_POOL_MIGRATIONS: readonly string[] = [
  "0006_app_provider_config.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  ...TAIL_PREREQUISITES,
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0015_provider_verification.sql",
  "0017_app_model_chains.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0022_app_trigger_mode.sql",
  "0023_removed_logins.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
];

/**
 * why: The config routes' shape: 0024/0025 (the per-key pools and their model
 * evidence), 0032/0033 (the unlimited tier and the `server_flags` table the
 * SPA boot reads), the index-only 0034/0035, then the derived tail. 0029
 * (the support-grant and audit tables, 0034's index target) and 0031 (the plan
 * catalogue, whose rows the tail's 0061 alters) already ride
 * `TAIL_PREREQUISITES` in the prefix this shape is always applied over.
 */
export const APP_CONFIG_MIGRATIONS: readonly string[] = [
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0033_platform_admin.sql",
  "0034_support_grant_indexes.sql",
  "0035_workspace_invite_expiry_index.sql",
  ...DERIVED_TAIL,
];

shape("app-config", [...APP_CONFIG_BASE_MIGRATIONS, ...APP_CONFIG_PRE_POOL_MIGRATIONS, ...APP_CONFIG_MIGRATIONS]);

/**
 * why: `tests/pipeline/app-credential-resolution.test.ts` — the consumer's
 * per-message read/write shape, then the directory-derived migrations after
 * 0036. 0011 sits before 0043 (which adds its delivery-source column);
 * 0010/0020 are the derived tail's index targets.
 */
export const APP_CREDENTIAL_RESOLUTION_MIGRATIONS = shape("app-credential-resolution", [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0007_reviews_app_id_index.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  "0010_review_failures.sql",
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0013_findings_review_id_index.sql",
  "0014_idx_reviews_reviewed_at.sql",
  "0015_provider_verification.sql",
  "0016_users_login_nocase_unique.sql",
  "0017_app_model_chains.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0020_finding_lifecycle.sql",
  "0021_review_checks.sql",
  "0022_app_trigger_mode.sql",
  "0023_removed_logins.sql",
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0026_workspaces.sql",
  "0027_workspace_backfill.sql",
  "0028_workspace_invites.sql",
  "0029_operator_support.sql",
  "0030_workspace_membership_cutover.sql",
  "0031_plans_usage.sql",
  "0032_unlimited_plan.sql",
  "0033_platform_admin.sql",
  "0034_support_grant_indexes.sql",
  "0035_workspace_invite_expiry_index.sql",
  "0036_app_identity.sql",
...migrationsAfter("0036_app_identity.sql"),
]);

/**
 * why: `tests/pipeline/consumer.test.ts` migration equivalence, pre-chains half:
 * 0003–0016 in filename order (the chains migration NOT yet applied) — the
 * wrangler state before 0017, which the fixture seeds and then applies itself.
 */
export const CONSUMER_PRE_CHAINS_MIGRATIONS: readonly string[] = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0007_reviews_app_id_index.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
  "0010_review_failures.sql",
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0013_findings_review_id_index.sql",
  "0014_idx_reviews_reviewed_at.sql",
  "0015_provider_verification.sql",
  "0016_users_login_nocase_unique.sql",
];

/**
 * why: The equivalence fixture's post-0017 half: the lifecycle journal (0020) the
 * §7.7 step-2 read queries, the check / trigger columns (0021–0022), the
 * per-key pools (0024), then every migration after 0036 (0039–0041 included:
 * admission reads the runtime caps and writes the `review_inflight` row).
 */
export const CONSUMER_POST_CHAINS_MIGRATIONS: readonly string[] = [
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0020_finding_lifecycle.sql",
  "0021_review_checks.sql",
  "0022_app_trigger_mode.sql",
  "0023_removed_logins.sql",
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0026_workspaces.sql",
  "0027_workspace_backfill.sql",
  "0028_workspace_invites.sql",
  "0029_operator_support.sql",
  "0030_workspace_membership_cutover.sql",
  "0031_plans_usage.sql",
  "0032_unlimited_plan.sql",
  "0033_platform_admin.sql",
  "0034_support_grant_indexes.sql",
  "0035_workspace_invite_expiry_index.sql",
  "0036_app_identity.sql",
  ...migrationsAfter(36),
];

shape("consumer", [
  ...CONSUMER_PRE_CHAINS_MIGRATIONS,
  "0017_app_model_chains.sql",
  ...CONSUMER_POST_CHAINS_MIGRATIONS,
]);
