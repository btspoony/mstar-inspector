/**
 * Plan 36 T2: `/dashboard/insights` is the review-records surface —
 * segmented window (HOME_WINDOWS) + shadcn Select repo filter.
 * No DOM runner — same source-scan contract as tests/spa/home.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { HOME_WINDOWS } from "../../src/spa/pages/homeModel";

const page = readFileSync(join(import.meta.dir, "../../src/spa/pages/InsightsPage.tsx"), "utf8");

describe("records page assembly (plan 36 T2)", () => {
  test("window switch is the same HOME_WINDOWS ToggleGroup as home", () => {
    expect(HOME_WINDOWS).toEqual(["7", "30", "90"]);
    expect(page).toContain("@/components/ui/toggle-group");
    expect(page).toContain("HOME_WINDOWS");
    expect(page).toContain("homeWindow");
  });

  test("repo filter is shadcn Select — zero native controls", () => {
    expect(page).toContain("@/components/ui/select");
    expect(page).toContain("INSIGHTS_REPO_ALL");
    expect(page).toContain("insightsRepoOptions");
    expect(page).toContain('searchHref("/dashboard/insights"');
    expect(page).not.toMatch(/<select[\s>]/);
    expect(page).not.toMatch(/<input[\s>]/);
    expect(page).not.toMatch(/<form[\s>]/);
    expect(page).not.toContain("pages.module.css");
    expect(page).not.toContain('name="repo"');
    expect(page).not.toContain("filterRepoPlaceholder");
    expect(page).not.toContain("insights.apply");
  });

  test("cards and typography are shadcn/Tailwind token driven (no raw hex)", () => {
    expect(page).toContain("@/components/ui/card");
    expect(page).toContain("text-muted-foreground");
    expect(page).toContain("bg-primary");
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("records page copy (plan 36 T2 / AC9)", () => {
  test("records heading and repo Select keys resolve in both locales", () => {
    expect(t("en", "insights.recordsHeading")).toBe("Review records");
    expect(t("zh_CN", "insights.recordsHeading")).toBe("审查记录");
    expect(t("en", "insights.filterRepoAll")).toBe("All");
    expect(t("zh_CN", "insights.filterRepoAll")).toBe("全部");
    expect(t("en", "insights.filterRepo")).toBe("Repo");
    expect(t("zh_CN", "insights.filterRepo")).toBe("仓库");
  });

  test("the page consumes the records keys and shared window copy", () => {
    for (const key of [
      "insights.recordsHeading",
      "insights.filterRepo",
      "insights.filterRepoAll",
      "insights.windowSegment",
      "insights.daysShort",
      "insights.noReviews",
    ]) {
      expect(page).toContain(`"${key}"`);
    }
  });
});
