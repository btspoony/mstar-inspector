/**
 * Plan 29 T4: i18n relative-time buckets (mirrors views.ts SQLite UTC stamps).
 */
import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "../../src/spa/relative-time";

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0); // 2026-09-02 12:00:00 UTC

function stamp(offsetMs: number): string {
  const d = new Date(NOW - offsetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

describe("formatRelativeTime", () => {
  test("null is never; junk is unknown", () => {
    expect(formatRelativeTime(null, "en", NOW)).toBe("never");
    expect(formatRelativeTime("not-a-stamp", "en", NOW)).toBe("unknown");
    expect(formatRelativeTime(null, "zh_CN", NOW)).toBe("从未");
  });

  test("en buckets match the legacy English phrases", () => {
    expect(formatRelativeTime(stamp(10_000), "en", NOW)).toBe("just now");
    expect(formatRelativeTime(stamp(60_000), "en", NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(stamp(120_000), "en", NOW)).toBe("2 minutes ago");
    expect(formatRelativeTime(stamp(3_600_000), "en", NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(stamp(86_400_000), "en", NOW)).toBe("1 day ago");
  });

  test("zh_CN uses dictionary copy", () => {
    expect(formatRelativeTime(stamp(10_000), "zh_CN", NOW)).toBe("刚刚");
    expect(formatRelativeTime(stamp(120_000), "zh_CN", NOW)).toBe("2 分钟前");
  });
});
