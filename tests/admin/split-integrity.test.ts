import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { splitIntegrity } from "../../src/admin/data-upgrades/split-integrity";
import { orphanInstallStateSql } from "../../src/dashboard/apps-store";
import { orphanLedgerAttributionBot } from "../../src/admin/data-upgrades/usage-bot-attribution";
const TS = "2026-01-01T00:00:00.000Z";

let appSeq = 1;

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

/** One App row plus its same-id bot and ownership row — the split's pair. */
function seedApp(db: TestD1, id: string, workspaceId = "default"): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'fixture', 'active', ?, ?)`,
    )
    .run(id, 9000 + appSeq++, id, TS, TS);
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(id, workspaceId);
  seedBot(db, id, workspaceId);
}

function seedBot(db: TestD1, id: string, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, created_at, updated_at)
       VALUES (?, ?, ?, 'owned', 1, ?, ?)`,
    )
    .run(id, workspaceId, id, TS, TS);
}


/** One review row, and one usage row for it with bot attribution left NULL. */
function seedUsage(
  db: TestD1,
  input: { review: string; token: string; workspaceId: string; reviewBotId: string | null; rp: number },
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id)
       VALUES (?, 1, 'acme', 'widgets', 1, ?, ?, 'pass', ?)`,
    )
    .run(input.review, `sha-${input.review}`, TS, input.reviewBotId);
  db.raw
    .prepare(
      `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
       VALUES (?, 1, ?, ?, ?, ?, 'shared')`,
    )
    .run(input.review, input.token, input.workspaceId, TS, input.rp);
}

function seedState(db: TestD1, appId: string, workspaceId: string): void {
  db.raw
    .prepare("INSERT INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, ?)")
    .run(appId, workspaceId, TS);
}

function seedInstallation(
  db: TestD1,
  row: { appId: string; installationId: number; bound: string | null; removed?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO github_app_installations
         (id, app_id, installation_id, account_login, seen_at, removed_at, bound_workspace_id)
       VALUES (?, ?, ?, 'acme', ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      row.appId,
      row.installationId,
      TS,
      row.removed ? "2026-02-01T00:00:00.000Z" : null,
      row.bound,
    );
}

describe("split-integrity — preflight counts", () => {
  test("apps_without_bot counts a live App whose same-id Bot is gone or deleted", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-live");
    seedApp(db, "app-deleted-bot");
    db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = 'app-deleted-bot'").run(TS);
    seedApp(db, "app-deleted");
    db.raw.prepare("DELETE FROM review_bots WHERE id = 'app-deleted'").run();
    db.raw.prepare("UPDATE github_apps SET deleted_at = ? WHERE id = 'app-deleted'").run(TS);

    const counts = await splitIntegrity.preflight(db);
    // app-deleted-bot: live App, soft-deleted Bot → counted. app-deleted: the
    // App itself is deleted → not counted even though its Bot row is gone.
    expect(counts.apps_without_bot).toBe(1);
  });

  test("chain_rows_with_deleted_bot counts a chain row whose Bot is not live", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-chain");
    seedState(db, "app-chain", "default");
    db.raw
      .prepare(
        "INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES (?, ?, 1, ?)",
      )
      .run("app-chain", "default", "app-chain");
    // A live Bot is not counted.
    let counts = await splitIntegrity.preflight(db);
    expect(counts.chain_rows_with_deleted_bot).toBe(0);

    db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = 'app-chain'").run(TS);
    counts = await splitIntegrity.preflight(db);
    expect(counts.chain_rows_with_deleted_bot).toBe(1);
  });

  test("install_states_orphaned counts neither-nor states only", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-consumer");
    seedApp(db, "app-owner"); // owner state, zero physical installations — LEGAL
    seedState(db, "app-owner", "default");

    seedApp(db, "app-bound"); // consumer state with a live bound install — LEGAL
    seedInstallation(db, { appId: "app-bound", installationId: 501, bound: "ws-consumer" });
    db.raw.prepare("DELETE FROM app_workspaces WHERE app_id = 'app-bound'").run();
    seedState(db, "app-bound", "ws-consumer");

    seedApp(db, "app-orphan"); // neither ownership nor a live bind — ORPHAN
    seedState(db, "app-orphan", "default");
    db.raw.prepare("DELETE FROM app_workspaces WHERE app_id = 'app-orphan'").run();
    seedInstallation(db, { appId: "app-orphan", installationId: 502, bound: "default", removed: true });

    const counts = await splitIntegrity.preflight(db);
    expect(counts.install_states_orphaned).toBe(1);
  });

  test("unattributed_usage_rows counts charged rows still without a Bot", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-a", "default");
    seedUsage(db, { review: "r1", token: "t1", workspaceId: "default", reviewBotId: "bot-a", rp: 5 });
    seedUsage(db, { review: "r2", token: "t2", workspaceId: "default", reviewBotId: null, rp: 3 });
    seedUsage(db, { review: "r3", token: "t3", workspaceId: "default", reviewBotId: null, rp: 0 });
    // Attributed rows are not counted.
    db.raw.prepare("UPDATE usage_events SET bot_id = 'bot-a' WHERE execution_token = 't1'").run();

    const counts = await splitIntegrity.preflight(db);
    expect(counts.unattributed_usage_rows).toBe(1); // only t2: charged, unattributed
  });

  test("a clean database reads zero everywhere", async () => {
    const db = createMigratedTestD1();
    const counts = await splitIntegrity.preflight(db);
    expect(counts).toEqual({
      apps_without_bot: 0,
      chain_rows_with_deleted_bot: 0,
      install_states_orphaned: 0,
      unattributed_usage_rows: 0,
    });
  });
});

describe("split-integrity — identity with usage-bot-attribution", () => {
  test("unattributed_usage_rows equals attributable_rows + permanently_unattributable_rows", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    seedBot(db, "bot-a", "default");
    seedBot(db, "bot-foreign", "ws-other");
    // Attributable: same-workspace bot.
    seedUsage(db, { review: "r-att", token: "t-att", workspaceId: "default", reviewBotId: "bot-a", rp: 5 });
    // Permanent buckets: no evidence, cross-workspace, unmatched review.
    seedUsage(db, { review: "r-none", token: "t-none", workspaceId: "default", reviewBotId: null, rp: 4 });
    seedUsage(db, { review: "r-cross", token: "t-cross", workspaceId: "default", reviewBotId: "bot-foreign", rp: 2 });
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
         VALUES ('r-missing', 1, 't-missing', 'default', ?, 7, 'shared')`,
      )
      .run(TS);
    // Free rows (rp = 0) are outside every count.
    seedUsage(db, { review: "r-free", token: "t-free", workspaceId: "default", reviewBotId: null, rp: 0 });

    const integrity = await splitIntegrity.preflight(db);
    const attribution = await orphanLedgerAttributionBot.preflight(db);
    expect(integrity.unattributed_usage_rows).toBe(
      (attribution.attributable_rows ?? 0) + (attribution.permanently_unattributable_rows ?? 0),
    );
    expect(integrity.unattributed_usage_rows).toBe(4);
    expect(attribution.attributable_rows).toBe(1);
    expect(attribution.permanently_unattributable_rows).toBe(3);
  });
});

describe("split-integrity — verify-only shape", () => {
  test("runBatch performs zero work and is immediately done", async () => {
    const db = createMigratedTestD1();
    const batch = await splitIntegrity.runBatch(db, null);
    expect(batch).toEqual({ cursor: null, processed: 0, done: true });
  });

  test("verify returns the same four counts and every one is advisory", async () => {
    const db = createMigratedTestD1();
    const preflight = await splitIntegrity.preflight(db);
    const verify = await splitIntegrity.verify(db, { runStartedAt: null });
    expect(verify).toEqual(preflight);
    for (const key of Object.keys(verify)) {
      expect(splitIntegrity.advisoryChecks).toContain(key);
    }
  });

  test("the report and the sweep share one predicate", () => {
    const predicate = orphanInstallStateSql("s");
    // Both readers reference the one exported function; the sweep builds its
    // EXISTS around it and the report builds its count statement from it.
    const storeSrc = readFileSync(
      new URL("../../src/dashboard/apps-store.ts", import.meta.url).pathname,
      "utf8",
    );
    const reportSrc = readFileSync(
      new URL("../../src/admin/data-upgrades/split-integrity.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(storeSrc).toContain('orphanInstallStateSql("s")');
    expect(reportSrc).toContain('orphanInstallStateSql("s")');
    expect(typeof predicate).toBe("string");
  });
});
