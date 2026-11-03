/**
 * Pull request detail face (App detail IA): the bounded record face.
 *
 * Static-SSR pins over the pure face (the InsightsRecordsView idiom): the
 * header facts and metric band, the severity buckets, the folds, the failures
 * panel, and the aside timeline. Mounted (happy-dom) pins cover what only real
 * effects and events prove: the family switch, fold toggles, and the copy
 * action's per-block outcome. Payloads shared with the list suite live in
 * `pull-request-fixtures.ts`.
 */
import { describe, expect, jest, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  appPullRequestDetailUrl,
  parsePullRequestDetail,
  type PullRequestDetail,
} from "../../src/spa/pages/data";
import { currentDetailRead, PullRequestDetailView, type DetailRead } from "../../src/spa/pages/PullRequestDetail";
import { withMarkup } from "./dom";
import { DETAIL, ROW_OPEN, mountDetailView, press } from "./pull-request-fixtures";

describe("pull request detail data plane (pure helpers)", () => {
  test("the detail URL builder encodes owner/repo so a value cannot break out of the path family", () => {
    expect(appPullRequestDetailUrl("/dashboard", "1", { owner: "acme", repo: "web", number: 42 })).toBe(
      "/dashboard/api/apps/1/pull-requests/acme/web/42",
    );
    // Segment-boundary characters are encoded, not trusted raw.
    expect(
      appPullRequestDetailUrl("/dashboard", "1", { owner: "a/b", repo: "settings?x", number: 42 }),
    ).toBe("/dashboard/api/apps/1/pull-requests/a%2Fb/settings%3Fx/42");
  });

  test("the detail parser keeps the envelope strict but drops drifted entries (QC)", () => {
    expect(parsePullRequestDetail(DETAIL)).toEqual(DETAIL);
    // One drifted failure / finding drops that entry, not the whole detail.
    expect(parsePullRequestDetail({ ...DETAIL, failures: [{ stage: 1 }] })?.failures).toEqual([]);
    expect(
      parsePullRequestDetail({ ...DETAIL, findings: [{ ...DETAIL.findings[0], line: "42" }] })?.findings,
    ).toEqual([]);
    // A pull_request without its address still fails the envelope.
    expect(
      parsePullRequestDetail({ ...DETAIL, pull_request: { ...DETAIL.pull_request, owner: null } }),
    ).toBeNull();
    expect(parsePullRequestDetail(null)).toBeNull();
  });

  test("a review with provider null parses and renders without a null leak (QC)", () => {
    const withNulls = {
      ...DETAIL,
      reviews: [
        { ...DETAIL.reviews[0], verdict: null, summary_md: null, model: null, provider: null },
      ],
      findings: [{ ...DETAIL.findings[0], title: null, file_path: null, body: null }],
    };
    const parsed = parsePullRequestDetail(withNulls);
    // The nullable text fields coerce to "" at the parse boundary; the
    // address fields pass through untouched.
    expect(parsed?.reviews[0]).toEqual({
      verdict: "",
      summary_md: "",
      model: "",
      provider: "",
      reviewed_at: "2026-11-01 08:00:00",
      head_sha: "aaa111bbb222",
    });
    expect(parsed?.findings[0]).toEqual({
      finding_id: "f-1",
      severity: "must-fix",
      title: "",
      file_path: "",
      line: 42,
      body: "",
    });
    // And the view renders the coerced row: an unattributed review (both fields
    // coerced empty) renders no attribution span and no "Latest review" meta —
    // an empty value would read as a missing fact — and the empty finding path
    // renders no location at all, no bare `:line` (N12). Each negative is read
    // off the node that owns the field, so unrelated text cannot satisfy it.
    withMarkup(renderToStaticMarkup(createElement(PullRequestDetailView, { locale: "en", detail: parsed ?? DETAIL })), (container) => {
      const meta = container.querySelector('[data-slot="pr-meta"]');
      expect(meta?.textContent ?? "").not.toContain(t("en", "pullRequests.latestReview"));
      const finding = container.querySelector('[data-slot="finding"]');
      expect(finding, "the coerced finding row renders").not.toBeNull();
      expect(finding?.textContent ?? "").not.toContain(":42");
      expect(finding?.textContent ?? "").not.toContain("null");
    });
  });
});

describe("pull request detail face (static SSR)", () => {
  const render = (detail: PullRequestDetail) =>
    renderToStaticMarkup(createElement(PullRequestDetailView, { locale: "en", detail }));

  /** The family triggers in render order: selected state + their text content. */
  const familyTabs = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
      selected: tab.getAttribute("aria-selected") === "true",
      text: tab.textContent ?? "",
    }));

  /**
   * The severity buckets in render order: their key and their header text —
   * label and count are both text in the header, so the rendered group carries
   * its own count without the test reading serialized tag adjacency.
   */
  const severityGroups = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-slot="severity-group"]')].map((group) => ({
      severity: group.getAttribute("data-severity"),
      header: group.querySelector("h3")?.textContent ?? "",
      text: group.textContent ?? "",
    }));

  /** The positions of `needles` in `markup`, asserted to be present first. */
  const positions = (markup: string, needles: readonly string[]) =>
    needles.map((needle) => {
      const at = markup.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });

  /**
   * Which family triggers wear the danger dot, keyed by the trigger's own
   * label: the dot is a semantic hook, so the claim never reads a class name.
   */
  const familyDots = (container: HTMLElement): Record<string, boolean> =>
    Object.fromEntries(
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => [
        (tab.textContent ?? "").replace(/\d+/g, ""),
        tab.querySelector('[data-slot="family-dot"]') !== null,
      ]),
    );

  /**
   * The head line (verdict, attribution, when, sha) of the review row that owns
   * `summary` — the row's own text, so a claim about it reads the rendered
   * content rather than the serialized tag around it. The head carries no
   * identifying text of its own, so it is selected by its slot inside the row
   * the summary identifies.
   */
  const reviewHead = (container: HTMLElement, summary: string): string => {
    const row = [...container.querySelectorAll<HTMLElement>("li")].find((item) =>
      [...item.querySelectorAll("p")].some((node) => node.textContent === summary),
    );
    expect(row, summary).toBeDefined();
    return row?.querySelector<HTMLElement>('[data-slot="review-head"]')?.textContent ?? "";
  };

  /**
   * A failure-only detail: no finding carries a must-fix or a should-fix, so
   * the face opens on the failures family and the diagnostic payload is in the
   * markup.
   */
  const FAILING: PullRequestDetail = { ...DETAIL, findings: [] };

  test("the header names the PR's own facts; the band aggregates them", () => {
    const markup = render(DETAIL);
    expect(markup).toContain("Fix the login flow");
    expect(markup).toContain("acme/web #133");
    expect(markup).toContain(t("en", "pullRequests.state.merged"));
    // Short-sha chip over the head sha, titled with the full-name tooltip.
    const chips = withMarkup(render(DETAIL), (container) =>
      [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map((chip) => chip.textContent ?? ""),
    );
    expect(chips).toEqual(["aaa111b"]);
    expect(markup).toContain(t("en", "pullRequests.headSha"));
    // Meta line: first seen, last seen.
    for (const label of ["firstSeen", "lastSeen"] as const) {
      expect(markup).toContain(t("en", `pullRequests.${label}`));
    }
    // The latest-review attribution is the header meta line's own item; the
    // reviews panel renders the same string, so it is read off that line —
    // selected by its slot, not by its position among the header's children.
    const headerMeta = withMarkup(
      render(DETAIL),
      (container) => container.querySelector('[data-slot="pr-meta"]')?.textContent ?? "",
    );
    expect(headerMeta).toContain(t("en", "pullRequests.latestReview"));
    expect(headerMeta).toContain(
      t("en", "pullRequests.reviewMeta", { model: "kimi-for-coding", provider: "openrouter" }),
    );
    // A review that records neither model nor provider has no attribution to
    // show: the item disappears rather than rendering an empty label.
    expect(
      withMarkup(
        render({
          ...DETAIL,
          reviews: [
            {
              verdict: "needs fixes",
              summary_md: "An unattributed round.",
              model: "",
              provider: "",
              reviewed_at: "2026-11-01 08:00:00",
              head_sha: "aaa111b",
            },
          ],
        }),
        (container) => container.querySelector('[data-slot="pr-meta"]')?.textContent ?? "",
      ),
    ).not.toContain(t("en", "pullRequests.latestReview"));
    // Band: the four label/figure pairs, in order — the aggregate the header
    // claims, read as the operator reads it.
    const metrics = withMarkup(render(DETAIL), (container) =>
      [...container.querySelectorAll('[data-slot="metric"]')].map((metric) => [
        metric.querySelector('[data-slot="metric-key"]')?.textContent ?? "",
        metric.querySelector('[data-slot="metric-value"]')?.textContent ?? "",
      ]),
    );
    expect(metrics[0]).toEqual([t("en", "pullRequests.columnVerdict"), "needs fixes"]);
    expect(metrics[1]).toEqual([t("en", "pullRequests.reviews"), "2"]);
    expect(metrics[2]).toEqual([t("en", "pullRequests.failures"), "1"]);
    expect(metrics[3]?.[0]).toBe(t("en", "pullRequests.findings"));
    expect(metrics[3]?.[1]).toContain(t("en", "pullRequests.mustFixNote", { count: 1 }));
  });

  test("the band wears the danger face for a non-shipping verdict and any failure", () => {
    const tones = withMarkup(render(DETAIL), (container) =>
      [...container.querySelectorAll('[data-slot="metric-value"]')].map((value) => value.getAttribute("data-tone")),
    );
    // Verdict (needs fixes) and failures (1) are alerts; the two counts are not.
    expect(tones).toEqual(["danger", null, "danger", null]);
  });

  test("the band and the timeline paint a verdict with the same rule", () => {
    // One rule, two surfaces: `ship it` is success, any other non-empty
    // verdict is danger. The band's figure and the timeline's row must agree,
    // so a non-shipping verdict cannot read as an alarm in one and quiet in
    // the other.
    const tones = (detail: PullRequestDetail) =>
      withMarkup(render(detail), (container) =>
        [...container.querySelectorAll('[data-slot="activity-entry"]')].map((entry) =>
          entry.getAttribute("data-tone"),
        ),
      );
    const shipped: PullRequestDetail = {
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "ship it", reviewed_at: "2026-11-01 08:00:00" },
      },
      reviews: [
        {
          verdict: "ship it",
          summary_md: "Looks good overall.",
          model: "kimi-for-coding",
          provider: "openrouter",
          reviewed_at: "2026-11-01 08:00:00",
          head_sha: "aaa111bbb222",
        },
      ],
    };
    // The review is the newest event on both faces.
    expect(tones(DETAIL)[0]).toBe("danger");
    expect(tones(shipped)[0]).toBe("success");
  });

  test("a must-fix finding opens the findings family, grouped by severity", () => {
    const markup = render(DETAIL);
    const tabs = withMarkup(render(DETAIL), familyTabs);
    expect(tabs.map((tab) => tab.selected)).toEqual([true, false, false]);
    expect(tabs[0]?.text.startsWith(t("en", "pullRequests.findings"))).toBe(true);
    // Counts are text, so the trigger reads "Findings3".
    expect(tabs.map((tab) => tab.text)).toEqual([
      `${t("en", "pullRequests.findings")}3`,
      `${t("en", "pullRequests.reviews")}2`,
      `${t("en", "pullRequests.failures")}1`,
    ]);
    // Group headers in severity order, each carrying its own count.
    expect(
      withMarkup(render(DETAIL), (container) =>
        severityGroups(container).map(({ severity, header }) => ({ severity, header })),
      ),
    ).toEqual([
      { severity: "must-fix", header: `${t("en", "pullRequests.severityMustFix")}1` },
      { severity: "should-fix", header: `${t("en", "pullRequests.severityShouldFix")}1` },
      { severity: "nit", header: `${t("en", "pullRequests.severityNit")}1` },
    ]);
    expect(markup).toContain("Use a parameterized query");
    expect(markup).toContain("src/db.ts:42");
    // A repo-wide finding (empty file_path) renders no location at all.
    expect(markup).toContain("Rename tmp to pending");
    expect(markup).not.toContain(":null");
  });

  test("the danger dot marks an actionable family and a recorded failure, and nothing else", () => {
    const dots = (detail: PullRequestDetail) => withMarkup(render(detail), familyDots);
    const findingsLabel = t("en", "pullRequests.findings");
    const failuresLabel = t("en", "pullRequests.failures");
    const reviewsLabel = t("en", "pullRequests.reviews");

    // A must-fix and a should-fix both make the findings family actionable; a
    // recorded failure is an alarm of its own; history never earns a dot.
    expect(dots(DETAIL)).toEqual({ [findingsLabel]: true, [reviewsLabel]: false, [failuresLabel]: true });
    // A should-fix alone is a requested change, not a nit.
    expect(dots({ ...DETAIL, findings: DETAIL.findings.filter((f) => f.severity === "should-fix") })[findingsLabel]).toBe(true);
    // Nits only: nothing to act on, so the findings trigger goes quiet.
    expect(dots({ ...DETAIL, findings: DETAIL.findings.filter((f) => f.severity === "nit") })).toEqual({
      [findingsLabel]: false,
      [reviewsLabel]: false,
      [failuresLabel]: true,
    });
    // No failure: the failures trigger loses its dot too.
    expect(dots({ ...DETAIL, failures: [] })).toEqual({
      [findingsLabel]: true,
      [reviewsLabel]: false,
      [failuresLabel]: false,
    });
  });

  test("an out-of-set severity lands in the `other` bucket, last, with its count", () => {
    const detail: PullRequestDetail = {
      ...DETAIL,
      findings: [
        ...DETAIL.findings,
        {
          finding_id: "f-4",
          severity: "blocker",
          title: "Drop the unsafe default",
          file_path: "",
          line: null,
          body: "The payload's severity is a free string; this one is outside the set.",
        },
        {
          // An out-of-set severity with no identity text: its toggle must still
          // be named, by its position.
          finding_id: "f-5",
          severity: "blocker",
          title: "",
          file_path: "",
          line: null,
          body: "A second out-of-set finding, this one untitled.",
        },
      ],
    };
    const read = withMarkup(render(detail), (container) => {
      const groups = severityGroups(container);
      return {
        groups,
        other: groups.at(-1)?.text ?? "",
        // The bucket opens folded like every non-must-fix group, and its
        // untitled entry falls back to its position for the toggle's name.
        otherFolds: foldPairs(container).slice(3),
        otherLabels: [...container.querySelectorAll("button[aria-expanded][aria-label]")]
          .map((control) => control.getAttribute("aria-label") ?? "")
          .slice(3),
      };
    });
    expect(read.groups.map((group) => group.severity)).toEqual(["must-fix", "should-fix", "nit", "other"]);
    // The bucket carries its own count, and its findings render under it.
    expect(read.groups.at(-1)?.header).toBe(`${t("en", "pullRequests.severityOther")}2`);
    expect(read.other).toContain("Drop the unsafe default");
    expect(read.other).toContain("this one untitled");
    expect(read.otherFolds).toEqual([
      { expanded: false, hidden: true },
      { expanded: false, hidden: true },
    ]);
    expect(read.otherLabels).toEqual([
      `${t("en", "pullRequests.expand")} — Drop the unsafe default`,
      `${t("en", "pullRequests.expand")} — #5`,
    ]);
  });

  /**
   * Fold pairs read off the rendered container: each fold control's
   * `aria-expanded`, the body its `aria-controls` names, and whether that body
   * carries `hidden`. Bodies stay mounted, so the attribute — not presence — is
   * the fold.
   */
  const foldPairs = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>("button[aria-expanded][aria-controls]")].map((control) => {
      const id = control.getAttribute("aria-controls") ?? "";
      return {
        expanded: control.getAttribute("aria-expanded") === "true",
        hidden: container.querySelector<HTMLElement>(`#${id}`)?.hidden,
      };
    });

  test("only the must-fix body opens; every other group starts folded", () => {
    const markup = render(DETAIL);
    // Fold order follows the group order: must-fix, should-fix, nit.
    const { pairs, labels } = withMarkup(render(DETAIL), (container) => ({
      pairs: foldPairs(container),
      labels: [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    }));
    expect(pairs.map((pair) => pair.expanded)).toEqual([true, false, false]);
    // Every body is resolved by its control, and `hidden` is the fold — the
    // folded text stays in the DOM rather than dropping out of the markup.
    expect(pairs.map((pair) => pair.hidden)).toEqual([false, true, true]);
    expect(markup).toContain("String interpolation reaches the SQL engine.");
    expect(markup).toContain("The refresh cookie is set with secure only.");
    expect(markup).toContain("The variable holds the pending redirect target.");
    // One expanded control (the must-fix finding), two folded ones.
    expect(pairs.filter((pair) => pair.expanded)).toHaveLength(1);
    expect(pairs.filter((pair) => !pair.expanded)).toHaveLength(2);
    // Each toggle names the record it folds, so identical "Expand" labels do
    // not leave several controls indistinguishable.
    expect(labels).toEqual([
      `${t("en", "pullRequests.collapse")} — Use a parameterized query`,
      `${t("en", "pullRequests.expand")} — Session cookie lacks HttpOnly`,
      `${t("en", "pullRequests.expand")} — Rename tmp to pending`,
    ]);
  });

  test("a toggle whose record carries no identity text falls back to its position", () => {
    // A coerced-empty title leaves the finding with nothing to name itself by;
    // the position keeps the two toggles distinguishable.
    const untitled: PullRequestDetail = {
      ...DETAIL,
      findings: [
        { finding_id: "f-1", severity: "must-fix", title: "", file_path: "", line: null, body: "" },
        { finding_id: "f-2", severity: "should-fix", title: "", file_path: "", line: null, body: "" },
      ],
    };
    const findingLabels = withMarkup(render(untitled), (container) =>
      [...container.querySelectorAll('[data-slot="finding"] button[aria-label]')].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    );
    expect(findingLabels).toEqual([
      `${t("en", "pullRequests.collapse")} — #1`,
      `${t("en", "pullRequests.expand")} — #2`,
    ]);

    // The same case on the reviews family: no verdict and no head sha.
    const anonymous = (summary: string, reviewed_at: string): PullRequestDetail["reviews"][number] => ({
      verdict: "",
      summary_md: summary,
      model: "",
      provider: "",
      reviewed_at,
      head_sha: "",
    });
    const unattributed: PullRequestDetail = {
      ...DETAIL,
      findings: [],
      failures: [],
      reviews: [anonymous("", "2026-11-01 08:00:00"), anonymous("An older round.", "2026-10-30 08:00:00")],
    };
    expect(
      withMarkup(render(unattributed), (container) =>
        [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
          (control) => control.getAttribute("aria-label") ?? "",
        ),
      ),
    ).toEqual([
      `${t("en", "pullRequests.collapse")} — #1`,
      `${t("en", "pullRequests.expand")} — #2`,
    ]);
  });

  test("a should-fix finding alone opens the findings family", () => {
    // No must-fix anywhere: a requested change still outranks history, so the
    // face must open on the findings rather than the reviews.
    const shouldOnly: PullRequestDetail = {
      ...DETAIL,
      findings: [
        {
          finding_id: "f-2",
          severity: "should-fix",
          title: "Session cookie lacks HttpOnly",
          file_path: "src/auth/session.ts",
          line: 88,
          body: "The refresh cookie is set with secure only.",
        },
      ],
    };
    expect(withMarkup(render(shouldOnly), familyTabs).map((tab) => tab.selected)).toEqual([true, false, false]);
    expect(render(shouldOnly)).toContain("The refresh cookie is set with secure only.");
    // The findings figure counts the row but names no must-fix: the note is a
    // must-fix count, so a should-fix-only detail must not wear it.
    expect(
      withMarkup(
        render(shouldOnly),
        (container) =>
          [...container.querySelectorAll('[data-slot="metric"]')].at(-1)?.querySelector(
            '[data-slot="metric-value"]',
          )?.textContent ?? "",
      ),
    ).toBe("1");
  });

  test("an empty verdict reads as no verdict: announced dash, no pill, no dangling separator", () => {
    // The parser coerces a nullable verdict to "": that is a review whose
    // verdict was never recorded, not the verdict "".
    const empty: PullRequestDetail = {
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "", reviewed_at: "2026-11-01 08:00:00" },
      },
      reviews: [
        {
          verdict: "",
          summary_md: "The pipeline recorded no verdict.",
          // Provider-only attribution: the row must name the provider.
          model: "",
          provider: "openrouter",
          reviewed_at: "2026-11-01 08:00:00",
          head_sha: "aaa111b",
        },
      ],
      // No actionable finding and no failure: the face opens on the reviews,
      // which is where the coerced verdict renders.
      findings: [],
      failures: [],
    };
    const read = withMarkup(render(empty), (container) => {
      const verdict = container.querySelectorAll('[data-slot="metric-value"]')[0];
      // The timeline row still names the review, with no dangling separator
      // and the provider rather than an empty model.
      const entry = container.querySelector('[data-slot="activity-entry"]');
      // The row's dot is aria-hidden; the label and meta are the two spans
      // inside its text column.
      const [label, meta] = [...(entry?.querySelectorAll("span") ?? [])].filter(
        (span) => !span.hasAttribute("aria-hidden"),
      );
      return {
        verdictText: verdict?.textContent ?? "",
        verdictTone: verdict?.getAttribute("data-tone") ?? null,
        badges: container.querySelectorAll('[role="tabpanel"] [data-slot="status-badge"]').length,
        head: reviewHead(container, "The pipeline recorded no verdict."),
        label: label?.textContent ?? "",
        meta: meta?.textContent ?? "",
      };
    });
    // Band: the same dash + screen-reader text the no-review case paints.
    expect(read.verdictText).toContain("—");
    expect(read.verdictText).toContain(t("en", "pullRequests.noVerdict"));
    // No recorded verdict is no alarm: the figure wears no danger hook.
    expect(read.verdictTone).toBeNull();
    // The review row paints no pill, and none of its head spans is empty.
    expect(read.badges).toBe(0);
    expect(read.head).toContain("openrouter");
    expect(read.head).not.toContain(" · ");
    expect(read.label).toBe(t("en", "pullRequests.timelineReviewNoVerdict"));
    expect(read.label).not.toMatch(/·\s*$/);
    expect(read.meta).toContain("openrouter");
    expect(read.meta).not.toContain(" · ·");
  });

  test("a clean detail opens on the reviews family with the latest summary readable", () => {
    const reviews = [
      {
        verdict: "ship it",
        summary_md: "Everything the last round asked for is in.",
        model: "kimi-for-coding",
        provider: "openrouter",
        reviewed_at: "2026-11-01 09:00:00",
        head_sha: "aaa111b",
      },
      {
        verdict: "ship it",
        summary_md: "An older round, folded by default.",
        model: "kimi-for-coding",
        provider: "",
        reviewed_at: "2026-10-30 09:00:00",
        head_sha: "bbb222c",
      },
    ];
    const clean: PullRequestDetail = {
      pull_request: {
        ...ROW_OPEN,
        number: 7,
        title: "Add the export button",
        latest_review: { verdict: "ship it", reviewed_at: "2026-11-01 09:00:00" },
        failure_count: 0,
      },
      reviews,
      failures: [],
      findings: [],
    };
    const markup = render(clean);
    const read = withMarkup(render(clean), (container) => ({
      selected: familyTabs(container).map((tab) => tab.selected),
      // The latest summary opens; older history is mounted but folded.
      pairs: foldPairs(container),
      // No provider means no dangling separator: the attributed row reads
      // `model · provider`, the unattributed one stops at its model.
      latestHead: reviewHead(container, "Everything the last round asked for is in."),
      olderHead: reviewHead(container, "An older round, folded by default."),
      // Review toggles name their verdict and short sha, so two "Collapse"s on
      // this face are distinguishable.
      labels: [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    }));
    expect(read.selected).toEqual([false, true, false]);
    expect(markup).toContain("Everything the last round asked for is in.");
    expect(read.pairs).toEqual([
      { expanded: true, hidden: false },
      { expanded: false, hidden: true },
    ]);
    expect(read.latestHead).toContain(
      t("en", "pullRequests.reviewMeta", { model: "kimi-for-coding", provider: "openrouter" }),
    );
    expect(read.olderHead).toContain("kimi-for-coding");
    expect(read.olderHead).not.toContain(" · ");
    expect(read.labels).toEqual([
      `${t("en", "pullRequests.collapse")} — ship it · aaa111b`,
      `${t("en", "pullRequests.expand")} — ship it · bbb222c`,
    ]);
    expect(markup).not.toContain(t("en", "pullRequests.noReviews"));
  });

  test("an empty head sha renders neither chip nor aside row", () => {
    const emptySha: PullRequestDetail = {
      ...DETAIL,
      pull_request: { ...DETAIL.pull_request, head_sha: "", latest_review: null },
      // No review row either: the band's verdict then falls back to the PR
      // row's summary, which is absent too.
      reviews: [],
    };
    const markup = render(emptySha);
    // The PR-level chip disappears rather than rendering an empty one; its
    // tooltip and the aside's Head row go with it.
    expect(
      withMarkup(render(emptySha), (container) =>
        [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map((chip) => chip.textContent ?? ""),
      ),
    ).toEqual([]);
    expect(markup).not.toContain(t("en", "pullRequests.headSha"));
    expect(markup).not.toContain(t("en", "pullRequests.factHead"));
    // The verdict figure is announced rather than left blank.
    expect(markup).toContain(t("en", "pullRequests.noVerdict"));
  });

  test("the aside timeline is capped and still ends on the PR's first sighting", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      verdict: "needs fixes",
      summary_md: `Round ${index}`,
      // The timeline's meta line renders the review's model, so a per-review
      // model is the one stable, rendered marker of WHICH rows survived.
      model: `model-${String(index).padStart(2, "0")}`,
      provider: "",
      // Newest first, as the store orders them; one hour apart.
      reviewed_at: `2026-11-01 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
    }));
    const detail = {
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "needs fixes", reviewed_at: history[0]?.reviewed_at ?? "" },
      },
      reviews: history,
    };
    const markup = render(detail);
    // `· model-NN` is the timeline's meta separator: the header names the model
    // without it, so the marker identifies exactly the rows that rendered.
    const marker = (index: number) => ` · model-${String(index).padStart(2, "0")}`;
    // Newest seven (indices 0..6) survive, in newest-first order; the dropped
    // events are named ABOVE the anchor, because they are newer than the PR's
    // first sighting and the list reads newest-first. A cap that kept the OLDEST
    // seven, or a note placed under the anchor, fails below.
    const truncation = t("en", "pullRequests.timelineHidden", { count: 6 });
    const order = positions(markup, [
      ...[0, 1, 2, 3, 4, 5, 6].map(marker),
      truncation,
      t("en", "pullRequests.timelineFirstSeen"),
    ]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const index of [7, 8, 9, 10, 11]) {
      expect(markup, marker(index)).not.toContain(marker(index));
    }
    // Additional evidence: eight rows — seven activity entries plus the anchor.
    expect(markup.match(/data-slot="activity-entry"/g) ?? []).toHaveLength(8);
    // The dropped six are named, not silently swallowed: 12 reviews plus the
    // payload's one failure make 13 events, of which the cap shows seven. The
    // truncation row itself carries the count and closes the shown history.
    expect(
      withMarkup(render(detail), (container) => {
        const rows = [...container.querySelectorAll('[data-slot="activity-entry"], [data-slot="timeline-truncated"]')].map(
          (row) => row.getAttribute("data-slot"),
        );
        return {
          last: rows.at(-1),
          beforeAnchor: rows.at(-2),
          text: container.querySelector('[data-slot="timeline-truncated"]')?.textContent ?? "",
        };
      }),
    ).toEqual({ last: "activity-entry", beforeAnchor: "timeline-truncated", text: truncation });
  });

  test("a timeline that fits the cap renders no truncation row", () => {
    // Seven history entries is the cap: six shown plus the anchor, none dropped.
    const reviews = Array.from({ length: 6 }, (_, index) => ({
      verdict: "ship it",
      summary_md: `Round ${index}`,
      model: `model-${index}`,
      provider: "",
      reviewed_at: `2026-10-31 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
    }));
    const markup = render({ ...DETAIL, reviews, failures: [] });
    expect(markup.match(/data-slot="activity-entry"/g) ?? []).toHaveLength(7);
    // Nothing was dropped, so the truncation row is absent rather than empty.
    expect(
      withMarkup(render({ ...DETAIL, reviews, failures: [] }), (container) =>
        container.querySelector('[data-slot="timeline-truncated"]'),
      ),
    ).toBeNull();
  });

  test("a failure's first line renders as escaped text and its full output stays in details", () => {
    const markup = render(FAILING);
    expect(withMarkup(render(FAILING), familyTabs).map((tab) => tab.selected)).toEqual([false, false, true]);
    expect(markup).toContain("sandbox");
    expect(markup).toContain("exit 1: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    // The failure block carries its danger ruling as a semantic hook, so the
    // alarm is read from the DOM rather than from a generated class literal.
    expect(
      withMarkup(render(FAILING), (container) => {
        const block = container.querySelector('[role="tabpanel"] li[data-tone="danger"]');
        return block === null ? null : (block.textContent ?? "");
      }),
    ).toContain("sandbox");
    // A multi-line error folds its full output behind a native details block;
    // its behaviour is pinned in the mounted suite, where the disclosure can
    // actually be opened.
    const multiline = render({
      ...FAILING,
      failures: [{ stage: "sandbox", error: "first line\nsecond line", created_at: "2026-10-31 23:00:00" }],
    });
    expect(multiline).toContain(t("en", "pullRequests.failureFullOutput"));
    expect(multiline).toContain("second line");
    // A single-line error has nothing to fold.
    const single = withMarkup(render(FAILING), (container) =>
      container.querySelector('[role="tabpanel"] details'),
    );
    expect(single).toBeNull();
  });

  test("a failure with no recorded stage renders neither chip nor a dangling separator", () => {
    // The payload coerces a missing stage to "": an empty chip would read as a
    // fact, and `Review failed · ` would leave the separator hanging.
    const stageless: PullRequestDetail = {
      ...DETAIL,
      findings: [],
      failures: [{ stage: "", error: "boom", created_at: "2026-10-31 23:00:00" }],
    };
    const read = withMarkup(render(stageless), (container) => {
      // The failure row is the activity entry whose label names the failure;
      // the review row carries its own verdict label instead.
      const entry = [...container.querySelectorAll<HTMLElement>('[data-slot="activity-entry"]')].find((row) =>
        (row.textContent ?? "").startsWith(t("en", "pullRequests.timelineFailureNoStage")),
      );
      return {
        entryFound: entry !== undefined,
        stageChip: container.querySelector('[role="tabpanel"] [data-slot="failure-stage"]'),
        labels: [...(entry?.querySelectorAll("span") ?? [])].map((span) => span.textContent ?? ""),
      };
    });
    expect(read.entryFound).toBe(true);
    expect(read.stageChip).toBeNull();
    expect(read.labels).toContain(t("en", "pullRequests.timelineFailureNoStage"));
    // No span of the row paints a leading or trailing separator.
    expect(read.labels.filter((label) => /^\s*·|·\s*$/.test(label))).toEqual([]);
  });

  test("the aside carries the PR facts and one merged timeline, newest first", () => {
    const markup = render(DETAIL);
    for (const label of ["factRepo", "factNumber", "factState", "factHead"] as const) {
      expect(markup).toContain(t("en", `pullRequests.${label}`));
    }
    expect(markup).toContain(t("en", "pullRequests.asideActivity"));
    // Review (11-01 08:00) → failure (10-31 23:00) → the PR's first sighting.
    const order = positions(markup, [
      t("en", "pullRequests.timelineReview", { verdict: "needs fixes" }),
      t("en", "pullRequests.timelineFailure", { stage: "sandbox" }),
      t("en", "pullRequests.timelineFirstSeen"),
    ]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("pull requests detail read derivation (pure)", () => {
  test("a read stamped for another pr derives to not-yet-loaded, whatever its kind (N1)", () => {
    const okA: DetailRead = { pr: "acme/web/1", kind: "ok", data: DETAIL };
    const errorA: DetailRead = { pr: "acme/web/1", kind: "error" };
    const loadingA: DetailRead = { pr: "acme/web/1", kind: "loading" };
    // A's view AND A's error must not render for B — the B transition
    // frame derives to null, which renders the loading face.
    expect(currentDetailRead(okA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(errorA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(loadingA, "acme/web/2")).toBeNull();
    // The matching stamp passes through — including the error, for retry.
    expect(currentDetailRead(okA, "acme/web/1")).toEqual(okA);
    expect(currentDetailRead(errorA, "acme/web/1")).toEqual(errorA);
    expect(currentDetailRead(null, "acme/web/1")).toBeNull();
  });
});

describe("pull request detail (mounted)", () => {
  test("the family switch and a fold toggle act on the live tree", async () => {
    const { container, win, unmount } = await mountDetailView(DETAIL);
    try {
      const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
      const panels = () => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
      const selected = () => tabs().map((tab) => tab.getAttribute("aria-selected") === "true");
      const visible = () => panels().map((panel) => panel.hidden === false);
      // DETAIL carries a must-fix finding: findings first, its panel open.
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

      // The reviews family: the selection and the visible panel both move.
      await press(win, tabs()[1]);
      expect(selected()).toEqual([false, true, false]);
      expect(visible()).toEqual([false, true, false]);

      // And back — a one-way switch would pass the assertion above.
      await press(win, tabs()[0]);
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

      // A fold toggle flips its own `aria-expanded` and its body's `hidden`.
      // The second finding starts folded; the first starts open.
      const controls = () => [...container.querySelectorAll<HTMLElement>("button[aria-expanded][aria-controls]")];
      const bodyOf = (control: HTMLElement | undefined) =>
        control === undefined
          ? null
          : container.querySelector<HTMLElement>(`#${control.getAttribute("aria-controls") ?? ""}`);
      expect(controls()[1]?.getAttribute("aria-expanded")).toBe("false");
      expect(bodyOf(controls()[1])?.hidden).toBe(true);
      await press(win, controls()[1]);
      expect(controls()[1]?.getAttribute("aria-expanded")).toBe("true");
      expect(bodyOf(controls()[1])?.hidden).toBe(false);
    } finally {
      await unmount();
    }
  });

  test("two findings sharing a payload id fold independently", async () => {
    // The payload can repeat an id; the rendered rows must not share a fold.
    const duplicated: PullRequestDetail = {
      ...DETAIL,
      findings: [
        {
          finding_id: "f-1",
          severity: "must-fix",
          title: "First copy",
          file_path: "",
          line: null,
          body: "First body.",
        },
        {
          finding_id: "f-1",
          severity: "must-fix",
          title: "Second copy",
          file_path: "",
          line: null,
          body: "Second body.",
        },
      ],
    };
    const { container, win, unmount } = await mountDetailView(duplicated);
    try {
      const controls = () =>
        [...container.querySelectorAll<HTMLElement>('[data-slot="finding"] button[aria-controls]')];
      const bodyOf = (control: HTMLElement | undefined) =>
        control === undefined
          ? null
          : container.querySelector<HTMLElement>(`#${control.getAttribute("aria-controls") ?? ""}`);
      // Both must-fix bodies start open, and each control owns a distinct body.
      expect(controls().map((control) => control.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
      expect(new Set(controls().map((control) => control.getAttribute("aria-controls"))).size).toBe(2);
      // Folding the second leaves the first open: one id for two rows used to
      // fold them together.
      await press(win, controls()[1]);
      expect(controls().map((control) => control.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
      expect(bodyOf(controls()[0])?.hidden).toBe(false);
      expect(bodyOf(controls()[1])?.hidden).toBe(true);
    } finally {
      await unmount();
    }
  });

  test("the copy action reports its outcome on the button and reverts", async () => {
    // The clipboard is the one surface happy-dom does not script: the first
    // write resolves and the second rejects, so both branches are exercised.
    let writes = 0;
    jest.useFakeTimers();
    // No actionable finding: the face opens on the failures family, whose one
    // control is the copy action.
    const { container, win, unmount } = await mountDetailView({ ...DETAIL, findings: [] });
    try {
      Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => {
            writes += 1;
            return writes === 1 ? Promise.resolve() : Promise.reject(new Error("denied"));
          },
        },
      });
      const copyButton = () => container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      // The button's own label is the outcome's one channel: the name of the
      // focused control changes, and no live region repeats it.
      const liveRegions = () => container.querySelectorAll('[role="status"], [aria-live]');
      const renders = (label: string) => (container.textContent ?? "").split(label).length - 1;
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));

      // Resolved write: the label reports the outcome, once.
      await press(win, copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(renders(t("en", "pullRequests.copyCopied"))).toBe(1);
      expect(liveRegions()).toHaveLength(0);

      // ...and it reverts on its own, so a later paste is not misread.
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));
      expect(renders(t("en", "pullRequests.copyCopied"))).toBe(0);

      // Rejected write: silence would leave the previous clipboard content in
      // place, so the failure is reported the same way.
      await press(win, copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(renders(t("en", "pullRequests.copyFailed"))).toBe(1);
      expect(liveRegions()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
      await unmount();
    }
  });

  test("a clipboard write that throws synchronously reports the failure", async () => {
    // Some browsers throw from `writeText` rather than returning a rejected
    // promise. A throw must land on the same outcome, not escape the handler.
    const { container, win, unmount } = await mountDetailView({ ...DETAIL, findings: [] });
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          throw new Error("clipboard is blocked");
        },
      },
    });
    const problems: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      problems.push(args[0]);
    };
    try {
      const button = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      await press(win, button);
      // The press reports the failure on the button it kept focus on, and the
      // throw never reached React as an uncaught handler error.
      expect(button?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(problems).toEqual([]);
    } finally {
      console.error = realError;
      await unmount();
    }
  });

  test("a failure's full output is folded until the reader opens the disclosure", async () => {
    // The first line is the diagnosis; the rest is evidence behind a native
    // disclosure. Read the behaviour off the rendered tree: closed → only the
    // summary, opened → the full output, both driven by a press on the summary.
    const { container, win, unmount } = await mountDetailView({
      ...DETAIL,
      findings: [],
      failures: [{ stage: "sandbox", error: "first line\nsecond line", created_at: "2026-10-31 23:00:00" }],
    });
    try {
      const details = () => container.querySelector<HTMLDetailsElement>('[role="tabpanel"] details');
      const summary = () => details()?.querySelector("summary");
      const output = () => details()?.querySelector("pre")?.textContent ?? "";
      const block = () => container.querySelector('[role="tabpanel"] li[data-tone="danger"]');
      // Closed: the diagnosis stands in the block, the evidence sits behind
      // the disclosure's own summary.
      expect(details()?.open).toBe(false);
      expect(block()?.querySelector("p")?.textContent).toBe("first line");
      expect(summary()?.textContent).toBe(t("en", "pullRequests.failureFullOutput"));

      await press(win, summary());
      expect(details()?.open).toBe(true);
      expect(output()).toBe("first line\nsecond line");
    } finally {
      await unmount();
    }
  });

  test("under StrictMode's double mount a copy's outcome still renders", async () => {
    // StrictMode runs mount → cleanup → mount; the cleanup-only effect used to
    // leave the mounted flag false, so every outcome was dropped.
    jest.useFakeTimers();
    const { container, win, unmount } = await mountDetailView({ ...DETAIL, findings: [] }, (view) =>
      createElement(StrictMode, null, view),
    );
    try {
      Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
      const button = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      expect(button?.textContent).toBe(t("en", "pullRequests.copyError"));
      await press(win, button);
      expect(button?.textContent).toBe(t("en", "pullRequests.copyCopied"));
    } finally {
      jest.useRealTimers();
      await unmount();
    }
  });

  test("copying a second error block does not cancel the first block's revert", async () => {
    jest.useFakeTimers();
    const { container, win, unmount } = await mountDetailView({
      ...DETAIL,
      findings: [],
      failures: [
        { stage: "sandbox", error: "first block", created_at: "2026-10-31 23:00:00" },
        { stage: "review", error: "second block", created_at: "2026-10-30 23:00:00" },
      ],
    });
    try {
      Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
      const copyButtons = () => [...container.querySelectorAll<HTMLElement>('[data-slot="copy-error"]')];
      expect(copyButtons()).toHaveLength(2);

      // Copy A, then B one second later. B's press must not cancel A's revert.
      await press(win, copyButtons()[0]);
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await press(win, copyButtons()[1]);
      expect(copyButtons()[0]?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyCopied"));

      // A's own two seconds are up; B's label is untouched.
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(copyButtons()[0]?.textContent).toBe(t("en", "pullRequests.copyError"));
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyCopied"));

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyError"));
    } finally {
      jest.useRealTimers();
      await unmount();
    }
  });

  test("a clipboard write that settles after unmount updates nothing", async () => {
    // A write the test settles by hand, so it can outlive the face.
    const { promise: pendingWrite, resolve: settleWrite } = Promise.withResolvers<void>();
    jest.useFakeTimers();
    const { container, win, unmount } = await mountDetailView({ ...DETAIL, findings: [] });
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => pendingWrite },
    });
    const problems: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      problems.push(String(args[0]));
    };
    try {
      const button = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      await press(win, button);
      const labelAtUnmount = button?.textContent;
      // The face goes away while the write is still in flight.
      await unmount();
      await act(async () => {
        settleWrite();
      });
      // The late outcome cannot reach the gone face: the write's resolution
      // throws nothing, React never warns about an update after unmount, and
      // the button the reader saw keeps the label it had.
      expect(labelAtUnmount).toBe(t("en", "pullRequests.copyError"));
      expect(button?.textContent).toBe(labelAtUnmount);
      expect(problems.filter((message) => /unmounted|not wrapped in act/.test(message))).toEqual([]);
    } finally {
      jest.useRealTimers();
      console.error = realError;
      await unmount();
    }
  });

  test("without a Clipboard API the copy control stays and reports the failure", async () => {
    // An insecure context offers no Clipboard API at all: the property reads
    // as absent, not as a rejecting write. happy-dom's own Clipboard lives on
    // the prototype, so the absent state is shadowed on the instance.
    const { container, win, unmount } = await mountDetailView({ ...DETAIL, findings: [] });
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
    try {
      const copyButton = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      // The affordance is not hidden just because the API is missing.
      expect(copyButton).not.toBeNull();
      await press(win, copyButton);
      expect(copyButton?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(container.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
    } finally {
      await unmount();
    }
  });
});
