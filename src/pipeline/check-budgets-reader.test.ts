/**
 * The pipeline's settings seam: `readCheckBudgets` / `readRecheckBacklogFill`.
 *
 * The store owns parsing, defaults and the degraded answer; these readers add
 * exactly one behaviour — ONE structured warn per degraded read, silence on
 * absent rows — and that is what these cases pin.
 */
import { describe, expect, test } from "bun:test";
import {
  CHECK_TERMINALIZE_DEFAULT,
  CHECK_TERMINALIZE_KEY,
  CHECK_UPDATE_DEFAULT,
} from "../dashboard/runtime-config-store";
import type { DashboardD1 } from "../dashboard/users";
import { createMigratedTestD1 } from "../../tests/store/helpers";
import { readCheckBudgets, type CheckBudgetsLogFields } from "./check-budgets-reader";

function spyLog<T>(): { calls: Array<{ fields: T; msg?: string }>; warn: (fields: T, msg?: string) => void } {
  const calls: Array<{ fields: T; msg?: string }> = [];
  return {
    calls,
    warn: (fields: T, msg?: string) => {
      calls.push({ fields, msg });
    },
  };
}

function db(): DashboardD1 {
  return createMigratedTestD1() as unknown as DashboardD1;
}

async function seed(target: DashboardD1, key: string, value: string): Promise<void> {
  await target
    .prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at)
       VALUES (?1, ?2, '2026-11-03T00:00:00.000Z')`,
    )
    .bind(key, value)
    .run();
}

describe("readCheckBudgets", () => {
  test("absent rows answer the defaults silently", async () => {
    const log = spyLog<CheckBudgetsLogFields>();
    expect(await readCheckBudgets(db(), log)).toEqual({
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: false,
    });
    expect(log.calls).toEqual([]);
  });

  test("a degraded read emits exactly ONE warn with both defaults", async () => {
    const log = spyLog<CheckBudgetsLogFields>();
    const target = db();
    await seed(target, CHECK_TERMINALIZE_KEY, "not-a-number");
    expect(await readCheckBudgets(target, log)).toEqual({
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: true,
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.fields).toEqual({
      event: "review_check_budgets_degraded",
      terminalize_ms: CHECK_TERMINALIZE_DEFAULT,
      update_ms: CHECK_UPDATE_DEFAULT,
    });
  });
});
