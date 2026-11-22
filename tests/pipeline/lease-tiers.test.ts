
import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
import { describe, expect, test } from "bun:test";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import {
  CHECK_LEASE_MS,
  CHECK_RECOVERY_LEASE_MS,
  claimAttempt,
  claimCheckRecovery,
  deferCheckRecovery,
  releaseCheckClaim,
  renewCheckLease,
  type Lease,
} from "../../src/store/review-checks";
import {
  PUBLICATION_LEASE_MS,
  claimPublicationLease,
  releasePublicationLease,
} from "../../src/store/finding-lifecycle";
import type { D1Like, ReviewCheckRow } from "../../src/store/types";
import { createMigratedTestD1, mapAppToDefaultWorkspace, type TestD1 } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;
const ACTION = "check:complete";

async function seededDb(): Promise<TestD1> {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'lease-tiers-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  await mapAppToDefaultWorkspace(db, APP_ID);
  return db;
}

async function claimed(db: D1Like, executionDeadlineMs: number): Promise<{ attemptId: string; lease: Lease }> {
  const result = await claimAttempt(db, {
    scope: SCOPE,
    githubAppId: GITHUB_APP_ID,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    holder: "run-a",
    nowMs: T0,
    executionDeadlineMs,
  });
  if (result.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${result.kind}`);
  return { attemptId: result.attempt.identity.attemptId, lease: result.lease };
}

async function checkRow(db: D1Like, attemptId: string): Promise<ReviewCheckRow> {
  const row = await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(attemptId).first<ReviewCheckRow>();
  if (row === null) throw new Error("fixture: attempt row vanished");
  return row;
}

describe("execution lease renewal", () => {
  test("renewal re-stamps the window and leaves execution_deadline_ms byte-identical", async () => {
    const db = await seededDb();
    const deadline = T0 + 1_500_000;
    const claim = await claimed(db, deadline);

    expect(
      await deferCheckRecovery(
        db, claim.attemptId, claim.lease,
        { state: "pending", nextAttemptMs: T0 + 60_000, reason: "renewal fixture" },
        T0,
      ),
    ).toBe(true);
    const T1 = T0 + 60_000;
    const recovered = await claimCheckRecovery(db, claim.attemptId, "recovery:1", T1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(recovered).not.toBeNull();
    expect(recovered!.untilMs).toBe(T1 + CHECK_RECOVERY_LEASE_MS);

    const renewed = await renewCheckLease(db, claim.attemptId, recovered!, T1);
    expect(renewed).not.toBeNull();
    expect(renewed!.untilMs).toBe(Math.min(T1 + CHECK_LEASE_MS, deadline));
    expect(renewed!.untilMs).toBeGreaterThan(recovered!.untilMs);
    expect(renewed!.holder).toBe(recovered!.holder);
    expect(renewed!.epoch).toBe(recovered!.epoch);

    const row = await checkRow(db, claim.attemptId);
    expect(row.execution_deadline_ms).toBe(deadline);
    expect(row.lease_until_ms).toBe(renewed!.untilMs);

    expect((await renewCheckLease(db, claim.attemptId, renewed!, T1))!.untilMs).toBe(renewed!.untilMs);
    expect(await renewCheckLease(db, claim.attemptId, { ...renewed!, holder: "run-b" }, T1)).toBeNull();
    expect(await renewCheckLease(db, claim.attemptId, renewed!, renewed!.untilMs)).toBeNull();
    expect((await checkRow(db, claim.attemptId)).execution_deadline_ms).toBe(deadline);
  });

  test("a delayed renewal whose epoch has moved is refused, not renewed onto the newer lease", async () => {
    const db = await seededDb();
    const deadline = T0 + 1_500_000;
    const claim = await claimed(db, deadline);
    const mine = await renewCheckLease(db, claim.attemptId, claim.lease, T0);
    expect(mine).not.toBeNull();

    expect(
      await deferCheckRecovery(
        db, claim.attemptId, mine!,
        { state: "pending", nextAttemptMs: T0 + 60_000, reason: "delay fixture" },
        T0,
      ),
    ).toBe(true);
    const T1 = T0 + 60_000;
    const takeover = await claimCheckRecovery(db, claim.attemptId, "recovery:2", T1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(takeover).not.toBeNull();
    expect(takeover!.epoch).toBe(mine!.epoch + 1);

    expect(await renewCheckLease(db, claim.attemptId, mine!, T1)).toBeNull();
    const row = await checkRow(db, claim.attemptId);
    expect(row.holder).toBe("recovery:2");
    expect(row.lease_epoch).toBe(takeover!.epoch);
    expect(row.lease_until_ms).toBe(takeover!.untilMs);
    expect(row.execution_deadline_ms).toBe(deadline);
  });
});

describe("publication lease is separate from execution", () => {
  test("a publication acquisition succeeds while execution is held; releasing execution keeps it held", async () => {
    const db = await seededDb();
    const deadline = T0 + 1_500_000;
    const claim = await claimed(db, deadline);

    const held = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:send-a", mode: "send", nowMs: T0,
    });
    expect(held).not.toBeNull();
    expect(held!.epoch).toBe(1);
    expect(held!.untilMs).toBe(T0 + PUBLICATION_LEASE_MS);

    const renewed = await renewCheckLease(db, claim.attemptId, claim.lease, T0);
    expect(renewed).not.toBeNull();
    expect((await checkRow(db, claim.attemptId)).execution_deadline_ms).toBe(deadline);

    expect(await releaseCheckClaim(db, claim.attemptId, renewed!, T0)).toBe(true);
    expect((await checkRow(db, claim.attemptId)).holder).toBeNull();
    const contended = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:send-b", mode: "send", nowMs: T0,
    });
    expect(contended).toBeNull();

    expect(await releasePublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, lease: held!, nowMs: T0,
    })).toBe(true);
    const reclaimed = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:send-b", mode: "send", nowMs: T0,
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.epoch).toBe(held!.epoch + 1);

    expect(await releasePublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, lease: held!, nowMs: T0,
    })).toBe(false);
    expect((await checkRow(db, claim.attemptId)).holder).toBeNull();
  });

  test("releasing a publication lease leaves execution and the Check row untouched", async () => {
    const db = await seededDb();
    const claim = await claimed(db, T0 + 1_500_000);

    const held = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:send-a", mode: "send", nowMs: T0,
    });
    expect(held).not.toBeNull();
    const before = await checkRow(db, claim.attemptId);

    expect(await releasePublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, lease: held!, nowMs: T0,
    })).toBe(true);

    const after = await checkRow(db, claim.attemptId);
    expect(after.holder).toBe(before.holder);
    expect(after.lease_epoch).toBe(before.lease_epoch);
    expect(after.lease_until_ms).toBe(before.lease_until_ms);
    expect(after.execution_deadline_ms).toBe(before.execution_deadline_ms);
    expect(await renewCheckLease(db, claim.attemptId, claim.lease, T0)).not.toBeNull();
  });

  test("send and recover contend on one action key; distinct actions do not", async () => {
    const db = await seededDb();
    const claim = await claimed(db, T0 + 1_500_000);

    const send = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:send-a", mode: "send", nowMs: T0,
    });
    expect(send).not.toBeNull();

    expect(await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:recover-a", mode: "recover", nowMs: T0,
    })).toBeNull();

    const other = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: "comment:pub-1", holder: "pub:comment", mode: "send", nowMs: T0,
    });
    expect(other).not.toBeNull();
    expect(other!.epoch).toBe(1);

    const later = T0 + PUBLICATION_LEASE_MS + 1;
    const recovered = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: "pub:recover-b", mode: "recover", nowMs: later,
    });
    expect(recovered).not.toBeNull();
    expect(recovered!.epoch).toBe(send!.epoch + 1);
    expect(recovered!.untilMs).toBe(later + PUBLICATION_LEASE_MS);

    const rows = await db.raw
      .query(`SELECT * FROM publication_leases WHERE attempt_id = ? ORDER BY action_key`)
      .all(claim.attemptId) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.action_key)).toEqual(["check:complete", "comment:pub-1"]);
    expect(rows[0]).toMatchObject({
      attempt_id: claim.attemptId,
      action_key: ACTION,
      holder: "pub:recover-b",
      lease_epoch: 2,
      lease_until_ms: later + PUBLICATION_LEASE_MS,
      mode: "recover",
      updated_ms: later,
    });
  });

  test("a delayed claim cannot read a later same-holder acquisition as its own", async () => {
    const db = await seededDb();
    const claim = await claimed(db, T0 + 1_500_000);
    const HOLDER = "pub:send-a";

    const mine = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: HOLDER, mode: "send", nowMs: T0,
    });
    expect(mine).not.toBeNull();
    expect(mine!.epoch).toBe(1);

    const later = T0 + PUBLICATION_LEASE_MS;
    const takeover = await claimPublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, holder: HOLDER, mode: "send", nowMs: later,
    });
    expect(takeover).not.toBeNull();
    expect(takeover!.epoch).toBe(2);

    expect(await releasePublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, lease: mine!, nowMs: later,
    })).toBe(false);
    const row = await db.raw
      .query(`SELECT holder, lease_epoch, lease_until_ms FROM publication_leases WHERE attempt_id = ? AND action_key = ?`)
      .get(claim.attemptId, ACTION) as Record<string, unknown>;
    expect(row).toMatchObject({
      holder: HOLDER,
      lease_epoch: takeover!.epoch,
      lease_until_ms: later + PUBLICATION_LEASE_MS,
    });
    expect(await releasePublicationLease(db, {
      attemptId: claim.attemptId, actionKey: ACTION, lease: takeover!, nowMs: later,
    })).toBe(true);
  });
});
