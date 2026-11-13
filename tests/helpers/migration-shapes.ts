/**
 * Hand-listed migration shapes for the worker and pipeline fixtures, plus the
 * ONE declaration of what the derived tail needs below its anchor.
 *
 * A fixture rebuilds production's schema up to a point by hand, then appends
 * `migrationsAfter(TAIL_ANCHOR)` so a new migration joins without a lockstep
 * edit. That tail may index a table a hand-listed shape skipped, so every
 * below-anchor prerequisite lives in `TAIL_PREREQUISITES` here — one place,
 * spread by every shape — instead of a per-fixture copy of the same rationale.
 *
 * The prerequisite migrations create only their own tables, and nothing between
 * their old slot and the tail references them (0047/0048 index the first two;
 * 0052 alters `review_checks`), so a shape applies them at the first one's old
 * position and still produces the identical schema.
 *
 * Every complete shape is declared with `shape()`, and
 * `tests/helpers/migration-shapes.test.ts` replays each registered one: it
 * parses every migration's `CREATE INDEX … ON <table>` / `ALTER TABLE <table>`
 * targets and asserts that table exists when the migration runs. The probe
 * reads ONLY those two statement forms. A below-anchor table reached through
 * DML (`INSERT INTO … SELECT` / `UPDATE`, the 0027 backfill shape) is invisible
 * to it and still fails as a raw SQLite `no such table`, so the rule stays
 * "declare the creating migration in `TAIL_PREREQUISITES`".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsAfter, type TestD1 } from "../store/helpers";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

/** The 0038 github_apps rebuild every fixture anchors its derived tail on. */
const TAIL_ANCHOR = "0038_webhook_path_drop.sql";

/**
 * Migrations creating the below-anchor tables the derived tail reaches: 0048
 * indexes review_failures, 0047 indexes review_threads, 0052 alters
 * review_checks, and 0056 rewrites app_provider_models (created by 0015 and
 * rebuilt by 0025). A future tail migration that touches another below-anchor
 * table adds its creating migration here — never to the individual shapes.
 */
export const TAIL_PREREQUISITES = [
  "0010_review_failures.sql",
  "0020_finding_lifecycle.sql",
  "0021_review_checks.sql",
] as const;

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

/**
 * Every complete fixture shape, keyed by the shape it builds. The prerequisite
 * guard replays all of them, so a new shape is covered by declaring it through
 * `shape()` — the guard never carries a list of its own to drift from.
 */
const SHAPES: Record<string, readonly string[]> = {};

/** Declare a complete shape: the exported list AND its registration for the guard. */
function shape(name: string, migrations: readonly string[]): readonly string[] {
  SHAPES[name] = migrations;
  return migrations;
}

export const FIXTURE_SHAPES: Readonly<Record<string, readonly string[]>> = SHAPES;

/** `tests/worker/apps-ui.test.ts` — the Apps management UI world. */
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
]);

/** `tests/worker/provider-verify.test.ts` — pre-0015 provider tables, tests apply 0015. */
export const PROVIDER_VERIFY_MIGRATIONS = shape("provider-verify", [
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
]);

/** `tests/worker/spa-page-apis.test.ts` — the SPA JSON faces' world. */
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
]);

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

/**
 * 0011 plus every migration after the 0038 rebuild (the delivery branch's tail).
 * 0012 creates `app_custom_providers`, which a later tail migration alters,
 * and alters `app_provider_keys` (0006) — this shape never applied either in
 * its prefix, so both are listed here at their wrangler position instead of a
 * table-less tail failing at the ALTER.
 */
export const WEBHOOK_DELIVERIES_TAIL: readonly string[] = [
  "0006_app_provider_config.sql",
  "0011_webhook_deliveries.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  ...DERIVED_TAIL,
];

// The delivery branch's full shape: the shared prefix, then 0011 + the tail.
shape("webhook-deliveries", [...WEBHOOK_DELIVERIES_MIGRATIONS, ...WEBHOOK_DELIVERIES_TAIL]);

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
 * `TAIL_PREREQUISITES` (0010, 0020, 0021), 0011, 0012, 0015, 0017, 0018, 0019,
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

// The settings suite's full shape: hand-listed base, pre-pool shape, then the
// config routes' migrations — the order the fixture applies them in.
shape("app-config", [...APP_CONFIG_BASE_MIGRATIONS, ...APP_CONFIG_PRE_POOL_MIGRATIONS, ...APP_CONFIG_MIGRATIONS]);

/**
 * `tests/pipeline/app-credential-resolution.test.ts` — the consumer's
 * per-message read/write shape, then the directory-derived migrations after
 * 0036. 0011 sits before 0043 (which adds its delivery-source column);
 * 0010/0020 are the derived tail's index targets.
 */
export const APP_CREDENTIAL_RESOLUTION_MIGRATIONS = shape("app-credential-resolution", [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  // 0006: the per-App config tables the settings consumer now reads
  // on EVERY app-path message — the fixture must stay production-shaped.
  "0006_app_provider_config.sql",
  // 0008: the github_apps ops columns (review_enabled) the
  // paused gate reads on every app-path message.
  "0008_github_apps_ops.sql",
  // 0009: the per-role table the consumer's modelOverrides read
  // queries on every app-path message.
  "0009_app_model_roles.sql",
  // 0010: the derived tail's 0048 indexes review_failures, so the table this
  // hand-listed shape skipped must exist before the tail runs.
  "0010_review_failures.sql",
  // 0011: the delivery table — 0043 adds a column to it, so the fixture must
  // carry it before the derived tail runs. Listed here at its wrangler
  // position (after 0009/0010), not appended where the need was noticed.
  "0011_webhook_deliveries.sql",
  // 0012: app_provider_keys.updated_at — the store's upsert writes
  // it, so the fixture must carry the column.
  "0012_custom_providers_and_key_updated_at.sql",
  // 0015: the store's addProviderKey upsert now writes the
  // verified_* columns, so the fixture must carry them too.
  "0015_provider_verification.sql",
  // 0017: the store's setModelChain now writes the default
  // app_model_chains row, so the fixture must carry the chains tables.
  "0017_app_model_chains.sql",
  // 0018: github_apps.sandbox_image_id — the consumer's per-message
  // sandbox-image resolution reads it on EVERY app-path message.
  "0018_app_sandbox_images.sql",
  // 0019–0021 complete the shipped schema the same per-message path now
  // reads, so the fixture must carry it too (the migration order below is
  // wrangler's apply order; 0021's FKs target 0020, which targets 0004):
  // 0019: the github_apps github_* metadata columns — the app
  //     row the consumer re-reads per message is the production `SELECT *`
  //     shape, which carries them.
  "0019_github_apps_metadata.sql",
  // 0020: the finding-lifecycle journal. The consumer's step-2
  //     journal handoff queries review_publications on EVERY app-path
  //     message (journalHandoffRow), and its lifecycle-context step
  //     reads review_findings (selectAssessmentTargets / countRecheckableFindings).
  "0020_finding_lifecycle.sql",
  // 0021: review_checks — the Check-attempt registry the
  //     consumer's §7.10 lifecycle seam owns; its publication_id FK
  //     resolves against 0020's review_publications.
  "0021_review_checks.sql",
  "0022_app_trigger_mode.sql",
  "0024_provider_multi_key.sql",
  // 0026: createApp also writes the App's workspace mapping.
  "0026_workspaces.sql",
  "0036_app_identity.sql",
  // Every later migration, derived from the directory (0040–… included):
  // the consumer's per-message admission reads the runtime caps and writes
  // the `review_inflight` row on EVERY admitted message, and 0043 adds the
  // delivery source column.
  ...migrationsAfter("0036_app_identity.sql"),
]);

/**
 * `tests/pipeline/consumer.test.ts` migration equivalence, pre-chains half:
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
 * The equivalence fixture's post-0017 half: the lifecycle journal (0020) the
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
  "0024_provider_multi_key.sql",
  // 0026 the workspace plane every App read joins; 0027 attributes the legacy
  // App to the 'default' workspace exactly as a real deployment does.
  "0026_workspaces.sql",
  "0027_workspace_backfill.sql",
  // 0031 meters every started execution into usage_events.
  "0031_plans_usage.sql",
  "0036_app_identity.sql",
  ...migrationsAfter(36),
];

// The fixture's full shape: both halves with 0017 (the migration under test)
// between them.
shape("consumer", [
  ...CONSUMER_PRE_CHAINS_MIGRATIONS,
  "0017_app_model_chains.sql",
  ...CONSUMER_POST_CHAINS_MIGRATIONS,
]);
