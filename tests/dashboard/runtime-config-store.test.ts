/**
 * The platform parameter store's official-workspace row and its key-domain
 * registry (contract § 7.2).
 *
 * Pinned here:
 *   - the read degrades to `null` for an absent row, an unknown id, a
 *     soft-deleted workspace and an unusable value — "no official workspace"
 *     is a legal steady state, not an error;
 *   - the write validates the id against a LIVE workspace and refuses anything
 *     else with zero stored rows and zero audit rows;
 *   - clearing DELETEs the row and is idempotent, so a second clear answers
 *     the same and appends nothing;
 *   - every accepted write carries exactly one `runtime.official_workspace.set`
 *     row with the before/after pair, in the same batch;
 *   - `isRuntimeSettingKey` admits the two registered domains and refuses a
 *     bare domain, an empty segment and an unregistered prefix.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import {
  CHECK_TERMINALIZE_KEY,
  CHECK_UPDATE_KEY,
  COMMENT_CLAIM_ATTEMPTS_KEY,
  COMMENT_CLAIM_OUTBOX_KEY,
  COMMENT_CLAIM_RETRY_KEY,
  OFFICIAL_WORKSPACE_KEY,
  RECHECK_ASSIGNMENT_KEY,
  REVIEW_LEVEL_KEY,
  RUNTIME_SETTING_DOMAINS,
  SYSTEM_CONCURRENCY_KEY,
  UnknownWorkspaceError,
  isRuntimeSettingKey,
  readOfficialWorkspaceId,
  setOfficialWorkspace,
} from "../../src/dashboard/runtime-config-store";

const NOW = "2026-02-01T00:00:00.000Z";
const LATER = "2026-02-02T00:00:00.000Z";

/** A workspace beside the seeded `default`; `deleted` stamps `deleted_at`. */
function seedWorkspace(db: TestD1, id: string, deleted = false): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ${deleted ? "'2026-01-02T00:00:00.000Z'" : "NULL"})`,
    )
    .run(id, id, id);
}

/** The raw row the write path would produce — a read fixture, not a write. */
function seedOfficialRow(db: TestD1, value: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, 'fixture')`,
    )
    .run(OFFICIAL_WORKSPACE_KEY, value, NOW);
}

function storedValue(db: TestD1): string | null {
  const row = db.raw
    .query("SELECT value FROM review_runtime_settings WHERE key = ?")
    .get(OFFICIAL_WORKSPACE_KEY) as { value: string } | null;
  return row?.value ?? null;
}

type Audit = { action: string; target_type: string; target_id: string; detail: unknown };

function audits(db: TestD1): Audit[] {
  return (
    db.raw
      .prepare(
        `SELECT action, target_type, target_id, detail_json
           FROM platform_audit_events ORDER BY rowid`,
      )
      .all() as Array<{ action: string; target_type: string; target_id: string; detail_json: string | null }>
  ).map((row) => ({
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: JSON.parse(row.detail_json ?? "null"),
  }));
}

describe("official workspace read (contract § 7.2.1)", () => {
  test("an absent row means no official workspace", async () => {
    const db = createMigratedTestD1();
    expect(await readOfficialWorkspaceId(db)).toBeNull();
  });

  test("a live workspace id round-trips", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "acme");
    seedOfficialRow(db, "acme");
    expect(await readOfficialWorkspaceId(db)).toBe("acme");
  });

  test("an unknown, soft-deleted or unusable value degrades to null", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "retired", true);

    for (const value of ["nope", "retired", "", "default "]) {
      db.raw.prepare("DELETE FROM review_runtime_settings WHERE key = ?").run(OFFICIAL_WORKSPACE_KEY);
      seedOfficialRow(db, value);
      expect(await readOfficialWorkspaceId(db), `value ${JSON.stringify(value)}`).toBeNull();
    }
  });
});

describe("official workspace write (contract § 7.2.2)", () => {
  test("an accepted id is stored with one audit row carrying before/after", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "acme");
    seedWorkspace(db, "other");

    expect(await setOfficialWorkspace(db, { workspaceId: "acme", actor: "operator", now: NOW })).toBe("acme");
    expect(storedValue(db)).toBe("acme");
    expect(await readOfficialWorkspaceId(db)).toBe("acme");

    expect(await setOfficialWorkspace(db, { workspaceId: "other", actor: "operator", now: LATER })).toBe("other");
    expect(storedValue(db)).toBe("other");

    expect(audits(db)).toEqual([
      {
        action: "runtime.official_workspace.set",
        target_type: "runtime",
        target_id: OFFICIAL_WORKSPACE_KEY,
        detail: { before: null, after: "acme" },
      },
      {
        action: "runtime.official_workspace.set",
        target_type: "runtime",
        target_id: OFFICIAL_WORKSPACE_KEY,
        detail: { before: "acme", after: "other" },
      },
    ]);
  });

  test("a padded id is stored trimmed", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "acme");

    expect(await setOfficialWorkspace(db, { workspaceId: " acme ", actor: "operator", now: NOW })).toBe("acme");
    expect(storedValue(db)).toBe("acme");
    expect(await readOfficialWorkspaceId(db)).toBe("acme");
    expect(audits(db)).toEqual([
      {
        action: "runtime.official_workspace.set",
        target_type: "runtime",
        target_id: OFFICIAL_WORKSPACE_KEY,
        detail: { before: null, after: "acme" },
      },
    ]);
  });

  test("an unknown, retired or malformed id is refused with no row and no audit row", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "retired", true);

    for (const workspaceId of ["nope", "retired", "a b", "x".repeat(65), "acme/dev"]) {
      await expect(
        setOfficialWorkspace(db, { workspaceId, actor: "operator", now: NOW }),
        `workspaceId ${JSON.stringify(workspaceId)}`,
      ).rejects.toThrow(UnknownWorkspaceError);
    }

    expect(storedValue(db)).toBeNull();
    expect(audits(db)).toEqual([]);
  });

  test("clearing deletes the row, audits it once and is idempotent", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "acme");
    await setOfficialWorkspace(db, { workspaceId: "acme", actor: "operator", now: NOW });

    expect(await setOfficialWorkspace(db, { workspaceId: null, actor: "operator", now: LATER })).toBeNull();
    expect(storedValue(db)).toBeNull();
    expect(audits(db).at(-1)).toEqual({
      action: "runtime.official_workspace.set",
      target_type: "runtime",
      target_id: OFFICIAL_WORKSPACE_KEY,
      detail: { before: "acme", after: null },
    });

    const auditCount = audits(db).length;
    expect(
      await setOfficialWorkspace(db, { workspaceId: null, actor: "operator", now: "2026-03-01T00:00:00.000Z" }),
    ).toBeNull();
    expect(audits(db)).toHaveLength(auditCount);
  });

  test("clearing an already-absent row writes nothing and appends nothing", async () => {
    const db = createMigratedTestD1();
    expect(await setOfficialWorkspace(db, { workspaceId: null, actor: "operator", now: NOW })).toBeNull();
    expect(storedValue(db)).toBeNull();
    expect(audits(db)).toEqual([]);
  });
});

describe("key domain registry (contract § 7.2.5)", () => {
  /** Every key an existing writer stores — read from the constants, not a copy. */
  const EXISTING_KEYS = [
    SYSTEM_CONCURRENCY_KEY,
    CHECK_TERMINALIZE_KEY,
    CHECK_UPDATE_KEY,
    COMMENT_CLAIM_RETRY_KEY,
    COMMENT_CLAIM_ATTEMPTS_KEY,
    COMMENT_CLAIM_OUTBOX_KEY,
    REVIEW_LEVEL_KEY,
    RECHECK_ASSIGNMENT_KEY,
    OFFICIAL_WORKSPACE_KEY,
  ];

  test("every registered domain is a prefix of at least one accepted key", () => {
    for (const domain of RUNTIME_SETTING_DOMAINS) {
      expect(isRuntimeSettingKey(`${domain}sample_key`), domain).toBe(true);
      expect(isRuntimeSettingKey(`${domain}nested.key_1`), domain).toBe(true);
      // The bare domain and its trailing dot are not keys.
      expect(isRuntimeSettingKey(domain.slice(0, -1)), domain).toBe(false);
      expect(isRuntimeSettingKey(domain), domain).toBe(false);
    }
  });

  test("every existing writer key is on the registry", () => {
    for (const key of EXISTING_KEYS) {
      expect(isRuntimeSettingKey(key), key).toBe(true);
    }
    // The one non-`review.` key is the platform parameter this plan adds.
    expect(EXISTING_KEYS.filter((key) => !key.startsWith("review."))).toEqual([OFFICIAL_WORKSPACE_KEY]);
    expect(isRuntimeSettingKey(OFFICIAL_WORKSPACE_KEY)).toBe(true);
  });

  test("a bare domain, an empty segment and an unregistered prefix are refused", () => {
    for (const key of [
      "nope.x",
      "platform.X",
      "platform.official-workspace-id",
      "Platform.official_workspace_id",
      "review..x",
      "review.a.",
      "",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isRuntimeSettingKey(key), JSON.stringify(key) ?? String(key)).toBe(false);
    }
  });
});
