/**
 * Pull request detail face (App detail IA): the static faces and pure helpers.
 *
 * Static-SSR pins over the pure face (the InsightsRecordsView idiom): the
 * header facts and metric band, the severity buckets, the folds, the failures
 * panel, the pager and the aside timeline — plus the read/parse derivations
 * that face consumes. The view is pure: the head and the per-section pages are
 * supplied as props, so each render is one tree describing one payload.
 * Mounted (happy-dom) behaviour lives in
 * `pull-request-detail-interaction.test.tsx`; payloads shared with the list
 * suite live in `pull-request-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t, type DictionaryKey } from "../../src/i18n";
import { formatRelativeTime } from "../../src/spa/relative-time";
import {
  appPullRequestDetailUrl,
  appPullRequestRecordsUrl,
  CATCH_ALL_SEVERITY,
  githubCommitUrl,
  githubPullRequestUrl,
  githubRepoUrl,
  parsePullRequestDetail,
  parseRecordPage,
  type PullRequestDetail,
  type PullRequestLatestReview,
  type PullRequestHead,
  type PullRequestReview,
} from "../../src/spa/pages/data";
import {
  PullRequestDetail as PullRequestDetailFace,
  PullRequestDetailView,
} from "../../src/spa/pages/PullRequestDetail";
import { defaultFamily, formatReviewDuration, recordId } from "../../src/spa/pages/pullRequestDetailModel";
import { withMarkup } from "./dom";
import {
  DETAIL,
  FAILURES,
  FINDINGS,
  RECORDS,
  REVIEWS,
  ROW_HEAD,
  page,
  recordsOf,
  scene,
  type RecordPages,
} from "./pull-request-fixtures";

const render = (detail: PullRequestDetail, records = recordsOf()) =>
  renderToStaticMarkup(
    createElement(PullRequestDetailView, {
      locale: "en",
      detail,
      records,
      onEnsureSection: () => {},
      onLoadPage: () => {},
    }),
  );

/** A complete face for a page set (counts derived from the pages' totals). */
const face = (
  over: Partial<RecordPages> = {},
  row: Partial<PullRequestHead> = {},
  latest: Partial<PullRequestLatestReview> | null = DETAIL.latest_review,
  // The head's own must-fix tally — stated, never read off the page under
  // test; defaults to the fixture PR's.
  mustFix?: number,
) => {
  const built = scene(over, row, latest, mustFix);
  return render(built.detail, recordsOf(built.pages));
};

// The read callback is synchronous by type: `withMarkup` closes its window as
// soon as the read returns, so an async read would resolve against a closed
// document. A promise-returning read is a compile error, pinned here.
// @ts-expect-error — an async read is rejected by the helper's signature.
const asyncReadIsRejected = () => withMarkup("<p></p>", async () => "late");
void asyncReadIsRejected;

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

  test("the record URL carries the page window, and severity only for findings", () => {
    expect(
      appPullRequestRecordsUrl("/dashboard", "1", { owner: "acme", repo: "web", number: 42 }, "findings", {
        offset: 20,
        limit: 10,
        severity: "must-fix",
      }),
    ).toBe("/dashboard/api/apps/1/pull-requests/acme/web/42/findings?offset=20&limit=10&severity=must-fix");
    // The filter value is encoded, and an empty filter is simply absent.
    expect(
      appPullRequestRecordsUrl("/dashboard", "1", { owner: "acme", repo: "web", number: 42 }, "findings", {
        offset: 0,
        limit: 10,
        severity: "a&b",
      }),
    ).toBe("/dashboard/api/apps/1/pull-requests/acme/web/42/findings?offset=0&limit=10&severity=a%26b");
    expect(
      appPullRequestRecordsUrl("/dashboard", "1", { owner: "acme", repo: "web", number: 42 }, "reviews", {
        offset: 0,
        limit: 10,
        severity: "",
      }),
    ).toBe("/dashboard/api/apps/1/pull-requests/acme/web/42/reviews?offset=0&limit=10");
    // The catch-all choice is a filter MODE, not a severity spelling: it rides
    // the route's `unclassified` flag so `severity` keeps its closed vocabulary.
    expect(
      appPullRequestRecordsUrl("/dashboard", "1", { owner: "acme", repo: "web", number: 42 }, "findings", {
        offset: 0,
        limit: 10,
        severity: CATCH_ALL_SEVERITY,
      }),
    ).toBe("/dashboard/api/apps/1/pull-requests/acme/web/42/findings?offset=0&limit=10&unclassified=1");
  });

  test("the GitHub builders encode each segment and cannot escape the path", () => {
    expect(githubRepoUrl("acme", "web")).toBe("https://github.com/acme/web");
    // A hostile segment stays inside the path: `/`, `?` and `#` are encoded,
    // so it cannot rewrite the host, the query or the fragment.
    expect(githubRepoUrl("a/b", "x?y#z")).toBe("https://github.com/a%2Fb/x%3Fy%23z");
    expect(githubPullRequestUrl("acme", "web", 42)).toBe("https://github.com/acme/web/pull/42");
    expect(githubPullRequestUrl("a/b", "x?y", 7)).toBe("https://github.com/a%2Fb/x%3Fy/pull/7");
    expect(githubCommitUrl("acme", "web", "aaa111b")).toBe("https://github.com/acme/web/commit/aaa111b");
    expect(githubCommitUrl("a/b", "x?y", "sha/with?chars#")).toBe(
      "https://github.com/a%2Fb/x%3Fy/commit/sha%2Fwith%3Fchars%23",
    );
  });

  test("the detail parser keeps the envelope strict; a page drops drifted entries", () => {
    expect(parsePullRequestDetail(DETAIL)).toEqual(DETAIL);
    // The counts are required and finite: a silent zero would disable a tab.
    expect(parsePullRequestDetail({ ...DETAIL, counts: { ...DETAIL.counts, findings: null } })).toBeNull();
    expect(parsePullRequestDetail({ ...DETAIL, counts: { ...DETAIL.counts, reviews: Number.NaN } })).toBeNull();
    expect(parsePullRequestDetail({ ...DETAIL, counts: undefined })).toBeNull();
    // A pull_request without its address still fails the envelope.
    expect(
      parsePullRequestDetail({ ...DETAIL, pull_request: { ...DETAIL.pull_request, owner: null } }),
    ).toBeNull();
    expect(parsePullRequestDetail(null)).toBeNull();
    // The head's newest review is nullable, and a drifted one drops to null
    // rather than failing the envelope (no headline verdict, face still renders).
    expect(parsePullRequestDetail({ ...DETAIL, latest_review: null })?.latest_review).toBeNull();
    expect(parsePullRequestDetail({ ...DETAIL, latest_review: { verdict: "ship it" } })?.latest_review).toBeNull();

    // One drifted failure / finding drops that entry, not the whole page — and
    // the drop is reported, because the server's total still counts the row
    // this page can never render.
    expect(parseRecordPage("failures", { items: [{ stage: 1 }], total: 1 })).toEqual({
      items: [],
      total: 1,
      dropped: 1,
    });
    expect(
      parseRecordPage("findings", { items: [{ ...FINDINGS[0], line: "42" }], total: 1 })?.items,
    ).toEqual([]);
    // The applied limit rides the page when the server echoes it (the pager
    // strides on THAT, not on the size it asked for); absent, it is omitted so
    // the pager falls back to its own constant.
    expect(parseRecordPage("reviews", { items: [], total: 0, limit: 50 })?.limit).toBe(50);
    expect(parseRecordPage("reviews", { items: [], total: 0 })?.limit).toBeUndefined();
    // The page envelope itself stays strict.
    expect(parseRecordPage("reviews", { items: [], total: Number.NaN })).toBeNull();
    expect(parseRecordPage("reviews", { total: 1 })).toBeNull();
    expect(parseRecordPage("reviews", null)).toBeNull();
  });

  test("a round's wall clock reads in seconds under a minute and as m/s above it", () => {
    expect(formatReviewDuration("en", 12_400)).toBe(
      t("en", "pullRequests.reviewDurationSeconds", { seconds: 12 }),
    );
    expect(formatReviewDuration("en", 65_000)).toBe(
      t("en", "pullRequests.reviewDurationMinutes", { minutes: 1, seconds: 5 }),
    );
    // The zh-CN templates are the same shape with their own units.
    expect(formatReviewDuration("zh_CN", 65_000)).toBe(
      t("zh_CN", "pullRequests.reviewDurationMinutes", { minutes: 1, seconds: 5 }),
    );
  });

  test("an absent must_fix tally degrades to zero; a malformed one fails; the opening family is records-first", () => {
    // The tally is a head fact newer than the envelope: a payload that predates
    // it keeps rendering, with no danger dot — the same skew tolerance the
    // sibling `RecordPage.limit` gets.
    const { must_fix: _omitted, ...withoutTally } = DETAIL.counts;
    expect(parsePullRequestDetail({ ...DETAIL, counts: withoutTally })?.counts.must_fix).toBe(0);
    // Present-but-malformed still fails the envelope like any other count.
    expect(parsePullRequestDetail({ ...DETAIL, counts: { ...DETAIL.counts, must_fix: null } })).toBeNull();
    expect(parsePullRequestDetail({ ...DETAIL, counts: { ...DETAIL.counts, must_fix: Number.NaN } })).toBeNull();
    // Records first, history last: findings, else failures, else reviews — an
    // empty PR opens on the reviews, never on an empty failures tab.
    expect(defaultFamily({ findings: 3, reviews: 2, failures: 1, must_fix: 1 })).toBe("findings");
    expect(defaultFamily({ findings: 0, reviews: 2, failures: 1, must_fix: 0 })).toBe("failures");
    expect(defaultFamily({ findings: 0, reviews: 0, failures: 0, must_fix: 0 })).toBe("reviews");
    expect(defaultFamily({ findings: 0, reviews: 2, failures: 0, must_fix: 0 })).toBe("reviews");
  });

  test("a review with provider null parses without a null leak, and a row without a real tally is refused", async () => {
    const reviews = parseRecordPage("reviews", {
      // The wire sends the per-severity tally as JSON text, never an object.
      items: [
        {
          ...REVIEWS[0],
          verdict: null,
          model: null,
          provider: null,
          severity_counts: JSON.stringify(REVIEWS[0]!.severity_counts),
        },
      ],
      total: 1,
    });
    const findings = parseRecordPage("findings", {
      items: [{ ...FINDINGS[0], title: null, file_path: null, body: null }],
      total: 1,
    });
    // The nullable text fields coerce to "" at the parse boundary; the
    // address fields pass through untouched. The round facts ride through when
    // the payload carries them, and the JSON tally parses into a record.
    expect(reviews?.items[0]).toEqual({
      verdict: "",
      model: "",
      provider: "",
      reviewed_at: "2026-11-01 08:00:00",
      head_sha: "aaa111bbb222",
      round: 2,
      findings: 2,
      duration_ms: 65_000,
      severity_counts: { "must-fix": 1, nit: 1 },
    });
    expect(findings?.items[0]).toEqual({
      finding_id: "f-1",
      severity: "must-fix",
      title: "",
      file_path: "",
      line: 42,
      body: "",
      review_round: 1,
    });
    // The tally text is tolerant: absent, empty, or malformed all degrade to
    // `{}` — the row still renders, it just carries no class breakdown.
    for (const severity_counts of [undefined, "", "{not json}", "[1,2]", '{"a":"1"}']) {
      const degraded = parseRecordPage("reviews", { items: [{ ...REVIEWS[0], severity_counts }], total: 1 });
      expect(degraded?.items[0]?.severity_counts).toEqual({});
    }
    // A payload that predates the round fields still renders its row: the
    // ordinal and clock are "no value" (`null`), and the row keeps its real
    // tally.
    const legacyRound = parseRecordPage("reviews", {
      items: [{ ...REVIEWS[0], round: "2", duration_ms: -1 }],
      total: 1,
    })?.items[0];
    expect(legacyRound).toMatchObject({ round: null, findings: 2, duration_ms: null });
    // Round 0 is not a round either: the history numbers from 1.
    const zeroRound = parseRecordPage("reviews", {
      items: [{ ...REVIEWS[0], round: 0 }],
      total: 1,
    })?.items[0];
    expect(zeroRound?.round).toBeNull();
    // The tally is REQUIRED: the paged route counts it with `COUNT(*)`, so a
    // row without one is refused (and reported in `dropped`) rather than
    // printed as a fabricated "0 findings".
    const withoutTally = parseRecordPage("reviews", {
      items: [{ ...REVIEWS[0], findings: undefined }],
      total: 1,
    });
    expect(withoutTally?.items).toEqual([]);
    expect(withoutTally?.dropped).toBe(1);
    // Present-but-malformed is not a count either: a string, a fraction or a
    // negative number all refuse the row.
    for (const findings of ["2", 2.5, -3]) {
      const refused = parseRecordPage("reviews", { items: [{ ...REVIEWS[0], findings }], total: 1 });
      expect(refused?.items).toEqual([]);
      expect(refused?.dropped).toBe(1);
    }
    // A real zero is a count, and the label branches on exactly one: 0 and 3
    // print their own number, only 1 takes the singular form.
    const tallies = parseRecordPage("reviews", {
      items: [
        { ...REVIEWS[0], findings: 0, severity_counts: "" },
        { ...REVIEWS[0], findings: 1, severity_counts: '{"nit":1}' },
        { ...REVIEWS[0], findings: 3, severity_counts: '{"should-fix":2,"must-fix":1,"nit":0,"unknown":9}' },
      ],
      total: 3,
    });
    expect(tallies?.items.map((review) => review.findings)).toEqual([0, 1, 3]);
    // Rendered: a round without a tally renders its verdict alone; per-class
    // pairs print in SEVERITY_GROUPS order — zero classes are omitted, never
    // printed as 0, and an off-vocabulary spelling sums into the `other`
    // bucket (the same catch-all the findings list uses).
    const tallyMarkup = render(
      { ...DETAIL, counts: { ...DETAIL.counts, findings: 0, reviews: 3, failures: 0, must_fix: 0 } },
      recordsOf({ ...RECORDS, findings: page([]), failures: page([]), reviews: tallies ?? page([]) }),
    );
    const classLines = await withMarkup(tallyMarkup, (container) =>
      [...container.querySelectorAll('[data-slot="review-counts"]')].map((line) => line.textContent ?? ""),
    );
    // All three rows carry REVIEWS[0]'s "needs fixes" verdict: the empty tally
    // renders the verdict alone; the nit tally prints that pair; the third row
    // orders must-fix before should-fix (SEVERITY_GROUPS order), drops the
    // zero nit, and rolls the off-vocabulary "unknown" class into `other`.
    expect(classLines).toEqual([
      "needs fixes",
      `needs fixes · ${t("en", "pullRequests.severityNit")} 1`,
      `needs fixes · ${t("en", "pullRequests.severityMustFix")} 1 · ${t("en", "pullRequests.severityShouldFix")} 2 · ${t("en", "pullRequests.severityOther")} 9`,
    ]);
    const legacyFinding = parseRecordPage("findings", {
      items: [{ ...FINDINGS[0], review_round: 1.5 }],
      total: 1,
    })?.items[0];
    expect(legacyFinding?.review_round).toBeNull();
    const zeroFindingRound = parseRecordPage("findings", {
      items: [{ ...FINDINGS[0], review_round: 0 }],
      total: 1,
    })?.items[0];
    expect(zeroFindingRound?.review_round).toBeNull();
    // The head carries the same unattributed review the page holds, in the
    // shape the head read sends: no round ordinal, clock or tally.
    const [headReview] = reviews?.items ?? [];
    const detail: PullRequestDetail = {
      ...DETAIL,
      counts: { ...DETAIL.counts, reviews: 1, findings: 1 },
      latest_review:
        headReview === undefined
          ? null
          : {
              verdict: headReview.verdict,
              model: headReview.model,
              provider: headReview.provider,
              reviewed_at: headReview.reviewed_at,
              head_sha: headReview.head_sha,
            },
    };
    const markup = render(
      detail,
      recordsOf({ ...RECORDS, reviews: reviews ?? page([]), findings: findings ?? page([]) }),
    );
    // An unattributed review (both fields coerced empty) renders no "Latest
    // review" meta — an empty value would read as a missing fact — and the
    // empty finding path renders no location at all, no bare `:line` (N12).
    // Each negative is read off the node that owns the field, so unrelated
    // text cannot satisfy it.
    await withMarkup(markup, (container) => {
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
  /**
   * The family triggers in render order: selected state and the announced name
   * (what an assistive technology reads).
   */
  const familyTabs = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
      selected: tab.getAttribute("aria-selected") === "true",
      name: tab.getAttribute("aria-label") ?? tab.textContent ?? "",
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
        (tab.getAttribute("aria-label") ?? tab.textContent ?? "").replace(/\s*\(\d+\)$/, ""),
        tab.querySelector('[data-slot="family-dot"]') !== null,
      ]),
    );

  /**
   * The head line (verdict, attribution, round, findings, when, sha) of the
   * review row whose round chip reads `Round {round}` — the row's own text, so
   * a claim about it reads the rendered content rather than the serialized tag
   * around it. Reviews no longer carry a summary body, so the round ordinal is
   * the row's identifying text.
   */
  const reviewHead = (container: HTMLElement, round: number): string => {
    const label = t("en", "pullRequests.reviewRound", { round });
    const row = [...container.querySelectorAll<HTMLElement>("li")].find(
      (item) => item.querySelector('[data-slot="review-round"]')?.textContent === label,
    );
    expect(row, label).toBeDefined();
    return row?.querySelector<HTMLElement>('[data-slot="review-head"]')?.textContent ?? "";
  };

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

  /**
   * A failures-only face: no finding and no review, so the counts open the
   * failures family with the diagnostic payload in the markup.
   */
  const failing = (over: Partial<RecordPages> = {}) =>
    face({ findings: page([]), reviews: page([]), ...over });

  test("the PR number and its repository link to GitHub with a safe target", async () => {
    // Both links read their address from the row's own owner/repo/number; the
    // accessible name says where the control goes, and the glyph is decoration.
    const links = await withMarkup(face(), (container) =>
      [...container.querySelectorAll("a")].map((anchor) => ({
        href: anchor.getAttribute("href"),
        target: anchor.getAttribute("target"),
        rel: anchor.getAttribute("rel"),
        name: anchor.getAttribute("aria-label"),
        glyph: anchor.querySelector("svg") !== null,
        text: anchor.textContent ?? "",
      })),
    );
    expect(links).toEqual([
      {
        href: "https://github.com/acme/web/pull/133",
        target: "_blank",
        rel: "noopener noreferrer",
        name: t("en", "pullRequests.openOnGithub", { owner: "acme", repo: "web", number: 133 }),
        glyph: true,
        text: t("en", "pullRequests.prNumber", { owner: "acme", repo: "web", number: 133 }),
      },
      {
        href: "https://github.com/acme/web",
        target: "_blank",
        rel: "noopener noreferrer",
        name: t("en", "pullRequests.openRepoOnGithub", { owner: "acme", repo: "web" }),
        glyph: true,
        text: "acme/web",
      },
    ]);
  });

  test("the header names the PR's own facts; the band aggregates the head counts", async () => {
    // One render, read from the one tree: the header, its meta line and the
    // band all describe the same payload, so nothing here can pass against a
    // different render than the one it claims to read.
    const markup = face();
    const read = await withMarkup(markup, (container) => ({
      // Short-sha chip over the head sha, titled with the full-name tooltip.
      chips: [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map(
        (chip) => chip.textContent ?? "",
      ),
      meta: container.querySelector('[data-slot="pr-meta"]')?.textContent ?? "",
      // The four label/figure pairs, in order — the aggregate the header
      // claims, read as the operator reads it.
      metrics: [...container.querySelectorAll('[data-slot="metric"]')].map((metric) => [
        metric.querySelector('[data-slot="metric-key"]')?.textContent ?? "",
        metric.querySelector('[data-slot="metric-value"]')?.textContent ?? "",
      ]),
    }));
    expect(markup).toContain("Fix the login flow");
    expect(markup).toContain("acme/web #133");
    expect(markup).toContain(t("en", "pullRequests.state.merged"));
    expect(read.chips).toEqual(["aaa111b"]);
    expect(markup).toContain(t("en", "pullRequests.headSha"));
    // The meta line carries the latest review's attribution — the one fact the
    // aside does not repeat. First/last seen live in the aside facts only; the
    // header used to print them a second time on the same screen.
    expect(read.meta).toContain(t("en", "pullRequests.latestReview"));
    expect(read.meta).toContain(
      t("en", "pullRequests.reviewMeta", { model: "kimi-for-coding", provider: "openrouter" }),
    );
    for (const label of ["firstSeen", "lastSeen"] as const) {
      expect(read.meta).not.toContain(t("en", `pullRequests.${label}`));
      // ...and they still render — exactly once, in the aside's facts.
      const rendered = markup.split(t("en", `pullRequests.${label}`)).length - 1;
      expect(rendered, label).toBe(1);
    }
    // A review that records neither model nor provider has no attribution to
    // show: the line disappears rather than rendering an empty label.
    expect(
      await withMarkup(
        face(
          {
            reviews: page([
              {
                verdict: "needs fixes",
                model: "",
                provider: "",
                reviewed_at: "2026-11-01 08:00:00",
                head_sha: "aaa111b",
                round: 1,
                findings: 0,
                duration_ms: null,
                severity_counts: {},
              },
            ]),
          },
          {},
          { verdict: "needs fixes", reviewed_at: "2026-11-01 08:00:00", model: "", provider: "" },
        ),
        (container) => container.querySelector('[data-slot="pr-meta"]') !== null,
      ),
    ).toBe(false);
    expect(read.metrics[0]).toEqual([t("en", "pullRequests.columnVerdict"), "needs fixes"]);
    // The band reads the head counts, never the loaded page length.
    expect(read.metrics[1]).toEqual([t("en", "pullRequests.reviews"), "2"]);
    expect(read.metrics[2]).toEqual([t("en", "pullRequests.failures"), "1"]);
    // The findings figure carries its must-fix note: the head's own tally sits
    // beside the total, so the operator reads both from the PR, not a page.
    expect(read.metrics[3]).toEqual([
      t("en", "pullRequests.findings"),
      `3${t("en", "pullRequests.mustFixNote", { count: 1 })}`,
    ]);
  });

  test("the band wears the danger face for a non-shipping verdict and any failure", async () => {
    const tones = await withMarkup(face(), (container) =>
      [...container.querySelectorAll('[data-slot="metric-value"]')].map((value) => value.getAttribute("data-tone")),
    );
    // Verdict (needs fixes) and failures (1) are alerts; the two counts are not.
    expect(tones).toEqual(["danger", null, "danger", null]);
  });

  test("the band, the badge and the timeline paint a verdict with the same rule", async () => {
    // One table, three surfaces: the band's figure, the review badge and the
    // timeline's row must agree, so a verdict cannot read as an alarm on one
    // and quiet on another. All three tones are read off their own hooks — the
    // band's `data-tone` on the verdict figure, the badge's on the row's pill,
    // the timeline row's on itself. The fixtures are the pre-v1 words too:
    // reading them as alarms by default used to paint `approve` red.
    const legacy = (verdict: string) =>
      face(
        {
          // No finding and no failure: the face opens on the reviews, where the
          // badge of the recorded verdict renders.
          findings: page([]),
          failures: page([]),
          reviews: page([
            {
              verdict,
              model: "kimi-for-coding",
              provider: "openrouter",
              reviewed_at: "2026-11-01 08:00:00",
              head_sha: "aaa111bbb222",
              round: 1,
                findings: 0,
                duration_ms: null,
                severity_counts: {},
              },
          ]),
        },
        {},
        { verdict, reviewed_at: "2026-11-01 08:00:00" },
      );
    const read = async (markup: string) =>
      withMarkup(markup, (container) => ({
        band: container.querySelectorAll('[data-slot="metric-value"]')[0]?.getAttribute("data-tone") ?? null,
        badge: container
          .querySelector('[role="tabpanel"] [data-slot="status-badge"]')
          ?.getAttribute("data-tone"),
        timeline: container.querySelector('[data-slot="activity-entry"]')?.getAttribute("data-tone"),
      }));
    // An approval is quiet on the band and success on the dot and the badge; a
    // change request is an alarm on all three — never one of each.
    expect(await read(legacy("approve"))).toEqual({
      band: null,
      badge: "success",
      timeline: "success",
    });
    expect(await read(legacy("request_changes"))).toEqual({
      band: "danger",
      badge: "danger",
      timeline: "danger",
    });
    // An unknown word is not an alarm either: neutral on every surface.
    expect(await read(legacy("looks fine"))).toEqual({
      band: null,
      badge: "neutral",
      timeline: "neutral",
    });
  });

  test("a findings count opens the findings family, grouped by severity", async () => {
    // One render, one page: the triggers, their counts and the severity groups
    // all describe the same tree.
    const markup = face();
    const read = await withMarkup(markup, (container) => ({
      tabs: familyTabs(container),
      // Counts stay text inside the trigger, so size never depends on colour.
      counts: [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
        [...tab.querySelectorAll("span")].map((span) => span.textContent ?? "").join(""),
      ),
      groups: severityGroups(container).map(({ severity, header }) => ({ severity, header })),
    }));
    expect(read.tabs.map((tab) => tab.selected)).toEqual([true, false, false]);
    // The announced name is the label and the count with a separator between
    // them; the visible spans alone would read "Findings3".
    expect(read.tabs.map((tab) => tab.name)).toEqual([
      `${t("en", "pullRequests.findings")} (3)`,
      `${t("en", "pullRequests.reviews")} (2)`,
      `${t("en", "pullRequests.failures")} (1)`,
    ]);
    expect(read.counts).toEqual(["3", "2", "1"]);
    // Group headers in severity order, each carrying its own count. The count
    // is the LOADED PAGE's — the tab's count is the head's PR-wide total — so
    // the header says which one it counts.
    const pageCount = t("en", "pullRequests.groupPageCount", { count: 1 });
    expect(read.groups).toEqual([
      { severity: "must-fix", header: `${t("en", "pullRequests.severityMustFix")}${pageCount}` },
      { severity: "should-fix", header: `${t("en", "pullRequests.severityShouldFix")}${pageCount}` },
      { severity: "nit", header: `${t("en", "pullRequests.severityNit")}${pageCount}` },
    ]);
    expect(markup).toContain("Use a parameterized query");
    expect(markup).toContain("src/db.ts:42");
    // A repo-wide finding (empty file_path) renders no location at all.
    expect(markup).toContain("Rename tmp to pending");
    expect(markup).not.toContain(":null");
  });

  test("a may-fix finding renders under its own group, between should-fix and nit", async () => {
    // The class is part of the record route's vocabulary, so the face must
    // bucket it with a label rather than fold it into `other`.
    const markup = face({
      findings: page([
        {
          finding_id: "f-may",
          severity: "may-fix",
          title: "Consider a shared helper",
          file_path: "src/a.ts",
          line: 3,
          body: "Optional cleanup: the two branches repeat the same guard.",
          review_round: null,
        },
        {
          finding_id: "f-nit",
          severity: "nit",
          title: "Rename tmp to pending",
          file_path: "src/b.ts",
          line: 4,
          body: "Naming only.",
          review_round: null,
        },
      ]),
    });
    const groups = await withMarkup(markup, severityGroups);
    expect(groups.map((group) => group.severity)).toEqual(["may-fix", "nit"]);
    expect(groups[0]?.header).toBe(
      `${t("en", "pullRequests.severityMayFix")}${t("en", "pullRequests.groupPageCount", { count: 1 })}`,
    );
    expect(markup).toContain("Optional cleanup: the two branches repeat the same guard.");
  });

  test("the danger dot marks a PR with must-fix rows and a recorded failure, nothing else", async () => {
    // The dot reads the HEAD's tally, so each scene states its own: a PR whose
    // findings are all should-fix/nit has none, whatever page is loaded.
    const dots = async (over: Partial<RecordPages> = {}, mustFix?: number) =>
      withMarkup(face(over, {}, DETAIL.latest_review, mustFix), familyDots);
    const findingsLabel = t("en", "pullRequests.findings");
    const failuresLabel = t("en", "pullRequests.failures");
    const reviewsLabel = t("en", "pullRequests.reviews");

    // A must-fix row makes the findings family actionable; a recorded failure
    // is an alarm of its own; history never earns a dot.
    expect(await dots()).toEqual({ [findingsLabel]: true, [reviewsLabel]: false, [failuresLabel]: true });
    // A PR whose findings are all should-fix/nit has no must-fix row, so the
    // trigger stays quiet even though its findings count is not zero.
    expect(
      (await dots({ findings: page(FINDINGS.filter((finding) => finding.severity !== "must-fix")) }, 0))[
        findingsLabel
      ],
    ).toBe(false);
    // No finding at all: the findings trigger goes quiet.
    expect(await dots({ findings: page([]) }, 0)).toEqual({
      [findingsLabel]: false,
      [reviewsLabel]: false,
      [failuresLabel]: true,
    });
    // No failure: the failures trigger loses its dot too.
    expect(await dots({ failures: page([]) })).toEqual({
      [findingsLabel]: true,
      [reviewsLabel]: false,
      [failuresLabel]: false,
    });
  });

  test("a filtered or paged findings view keeps the dot: the head's tally drives it", async () => {
    // The head says this PR has must-fix rows while the loaded page holds only
    // nits (page 2, or a severity filter) — the family dot must survive.
    const built = scene();
    const filtered = recordsOf(
      { ...built.pages, findings: page(FINDINGS.filter((finding) => finding.severity === "nit")) },
      10,
      "nit",
    );
    const read = await withMarkup(render(built.detail, filtered), (container) => ({
      dots: familyDots(container),
      // The count beside the dot still describes the PR.
      triggerCount: container.querySelectorAll<HTMLElement>('[role="tab"]')[0]?.textContent ?? "",
    }));
    expect(read.dots[t("en", "pullRequests.findings")]).toBe(true);
    expect(read.triggerCount).toContain("3");
  });

  test("an out-of-set severity lands in the `other` bucket, last, with its count", async () => {
    const outOfSet = [
      {
        finding_id: "f-4",
        severity: "blocker",
        title: "Drop the unsafe default",
        file_path: "",
        line: null,
        body: "The payload's severity is a free string; this one is outside the set.",
        review_round: null,
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
        review_round: null,
      },
    ];
    const withOther = page([
      ...FINDINGS,
      ...outOfSet,
      {
        finding_id: "f-6",
        severity: "may-fix",
        title: "Fold the duplicate guard",
        file_path: "",
        line: null,
        body: "The class the engine added; it buckets ahead of nit, before `other`.",
        review_round: null,
      },
    ]);
    const read = await withMarkup(face({ findings: withOther }), (container) => {
      const groups = severityGroups(container);
      // The bucket is picked by its severity, not by its position, so the
      // claims below cannot silently read a known bucket.
      const other = container.querySelector<HTMLElement>('[data-slot="severity-group"][data-severity="other"]');
      return {
        groups,
        other: other?.textContent ?? "",
        // The bucket opens folded like every non-must-fix group, and its
        // untitled entry falls back to its position for the toggle's name.
        otherFolds: other === null ? [] : foldPairs(other),
        otherLabels:
          other === null
            ? []
            : [...other.querySelectorAll("button[aria-expanded][aria-label]")].map(
                (control) => control.getAttribute("aria-label") ?? "",
              ),
      };
    });
    expect(read.groups.map((group) => group.severity)).toEqual([
      "must-fix",
      "should-fix",
      "may-fix",
      "nit",
      "other",
    ]);
    // The bucket carries its own page-scoped count, and its findings render
    // under it.
    expect(read.groups.at(-1)?.header).toBe(
      `${t("en", "pullRequests.severityOther")}${t("en", "pullRequests.groupPageCount", { count: 2 })}`,
    );
    expect(read.other).toContain("Drop the unsafe default");
    expect(read.other).toContain("this one untitled");
    expect(read.otherFolds).toEqual([
      { expanded: false, hidden: true },
      { expanded: false, hidden: true },
    ]);
    // The position is the rendered one inside the `other` group, not the
    // payload array index.
    expect(read.otherLabels).toEqual([
      `${t("en", "pullRequests.expand")} — Drop the unsafe default · #1`,
      `${t("en", "pullRequests.expand")} — #2`,
    ]);

    // A legacy severity still renders, still opens the findings family (a
    // findings count outranks history) — it lands in `other`, and it is not a
    // must-fix row, so the PR's danger dot stays off.
    const legacyOnly = face({ findings: page(outOfSet) }, {}, DETAIL.latest_review, 0);
    const legacyRead = await withMarkup(legacyOnly, (container) => ({
      selected: familyTabs(container).map((tab) => tab.selected),
      dots: familyDots(container),
      buckets: severityGroups(container).map((group) => group.severity),
    }));
    expect(legacyRead.selected).toEqual([true, false, false]);
    expect(legacyRead.dots[t("en", "pullRequests.findings")]).toBe(false);
    expect(legacyRead.buckets).toEqual(["other"]);
  });

  test("only the must-fix body opens; every other group starts folded", async () => {
    const markup = face();
    // Fold order follows the group order: must-fix, should-fix, nit.
    const { pairs, labels } = await withMarkup(markup, (container) => ({
      pairs: foldPairs(container),
      labels: [...container.querySelectorAll('[role="tabpanel"] li button[aria-expanded][aria-label]')].map(
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
    // Each toggle names the record it folds and its position, so identical
    // "Expand" labels do not leave several controls indistinguishable. The
    // position is per group: each finding is the first row of its own bucket.
    expect(labels).toEqual([
      `${t("en", "pullRequests.collapse")} — Use a parameterized query · #1`,
      `${t("en", "pullRequests.expand")} — Session cookie lacks HttpOnly · #1`,
      `${t("en", "pullRequests.expand")} — Rename tmp to pending · #1`,
    ]);
  });

  test("two findings sharing a title still have distinct fold names", async () => {
    // Same title, same severity: only the position separates them, so the
    // label rule must carry it for every record rather than only for the
    // ones with no text at all.
    const twin = face({
      findings: page([
        {
          finding_id: "f-1",
          severity: "must-fix",
          title: "Guard the write",
          file_path: "",
          line: null,
          body: "",
          review_round: null,
        },
        {
          finding_id: "f-2",
          severity: "must-fix",
          title: "Guard the write",
          file_path: "",
          line: null,
          body: "",
          review_round: null,
        },
      ]),
    });
    const labels = await withMarkup(twin, (container) =>
      [...container.querySelectorAll<HTMLElement>('[data-slot="finding"] button[aria-label]')].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    );
    expect(labels).toEqual([
      `${t("en", "pullRequests.collapse")} — Guard the write · #1`,
      `${t("en", "pullRequests.collapse")} — Guard the write · #2`,
    ]);
    expect(new Set(labels).size).toBe(2);
  });

  test("a toggle whose record carries no identity text falls back to its position", async () => {
    // A coerced-empty title leaves the finding with nothing to name itself by;
    // the position keeps the two toggles distinguishable.
    const untitled = face({
      findings: page([
        { finding_id: "f-1", severity: "must-fix", title: "", file_path: "", line: null, body: "", review_round: null },
        { finding_id: "f-2", severity: "should-fix", title: "", file_path: "", line: null, body: "", review_round: null },
      ]),
    });
    const findingLabels = await withMarkup(untitled, (container) =>
      [...container.querySelectorAll('[data-slot="finding"] button[aria-label]')].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    );
    // The position is per group: each untitled finding is the first row of
    // its own bucket.
    expect(findingLabels).toEqual([
      `${t("en", "pullRequests.collapse")} — #1`,
      `${t("en", "pullRequests.expand")} — #1`,
    ]);
  });

  test("a should-fix finding alone opens the findings family", async () => {
    // No must-fix anywhere: a findings count still outranks history, so the
    // face must open on the findings rather than the reviews.
    // The head carries no must-fix row for this PR, so the scene states 0 —
    // the tally is the head's fact, not something read off the page.
    const markup = face(
      {
        findings: page([
          {
            finding_id: "f-2",
            severity: "should-fix",
            title: "Session cookie lacks HttpOnly",
            file_path: "src/auth/session.ts",
            line: 88,
            body: "The refresh cookie is set with secure only.",
            review_round: null,
          },
        ]),
      },
      {},
      DETAIL.latest_review,
      0,
    );
    expect((await withMarkup(markup, familyTabs)).map((tab) => tab.selected)).toEqual([true, false, false]);
    expect(markup).toContain("The refresh cookie is set with secure only.");
    // The findings figure is the head's count: one row, no must-fix note.
    expect(
      await withMarkup(
        markup,
        (container) =>
          [...container.querySelectorAll('[data-slot="metric"]')].at(-1)?.querySelector(
            '[data-slot="metric-value"]',
          )?.textContent ?? "",
      ),
    ).toBe("1");
  });

  test("an empty verdict reads as no verdict: announced dash, no pill, no dangling separator", async () => {
    // The parser coerces a nullable verdict to "": that is a review whose
    // verdict was never recorded, not the verdict "".
    const empty = face(
      {
        findings: page([]),
        failures: page([]),
        reviews: page([
          {
            verdict: "",
            // Provider-only attribution: the row must name the provider.
            model: "",
            provider: "openrouter",
            reviewed_at: "2026-11-01 08:00:00",
            head_sha: "aaa111b",
            round: 1,
            findings: 0,
            duration_ms: null,
            severity_counts: {},
          },
        ]),
      },
      {},
      { verdict: "", reviewed_at: "2026-11-01 08:00:00" },
    );
    const read = await withMarkup(empty, (container) => {
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
        head: reviewHead(container, 1),
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

  test("a clean detail opens on the reviews family: two-line rows, commit links and per-class counts", async () => {
    const reviews = page<PullRequestReview>([
      {
        verdict: "ship it",
        model: "kimi-for-coding",
        provider: "openrouter",
        reviewed_at: "2026-11-01 09:00:00",
        head_sha: "aaa111b",
        round: 2,
        findings: 3,
        duration_ms: 65_000,
        severity_counts: { "must-fix": 2, nit: 1 },
      },
      {
        verdict: "ship it",
        model: "kimi-for-coding",
        provider: "",
        reviewed_at: "2026-10-30 09:00:00",
        head_sha: "bbb222c",
        round: 1,
        findings: 1,
        duration_ms: null,
        severity_counts: { nit: 1 },
      },
      {
        // A round that carries no ordinal, no measured clock and no tally
        // still renders: no chip, no time, and the verdict alone on its
        // second line.
        verdict: "ship it",
        model: "kimi-for-coding",
        provider: "",
        reviewed_at: "2026-10-29 09:00:00",
        head_sha: "ccc333d",
        round: null,
        findings: 0,
        duration_ms: null,
        severity_counts: {},
      },
    ]);
    const markup = face(
      { findings: page([]), failures: page([]), reviews },
      {},
      { verdict: "ship it", reviewed_at: "2026-11-01 09:00:00" },
    );
    const read = await withMarkup(markup, (container) => ({
      selected: familyTabs(container).map((tab) => tab.selected),
      rows: [...container.querySelectorAll('[data-slot="review-head"]')].map((head) => {
        const row = head.closest("li")!;
        return {
          // Two lines: the head row and the counts row inside one flex-1 block.
          lines: row.querySelectorAll('[data-slot="review-head"], [data-slot="review-counts"]').length,
          head: head.textContent ?? "",
          counts: row.querySelector('[data-slot="review-counts"]')?.textContent ?? null,
          // The relative time left line 1: it now owns the fixed right block.
          timeInHead: head.textContent?.includes(formatRelativeTime("2026-11-01 09:00:00", "en")) ?? false,
          time: row.querySelector('[data-slot="review-time"]')?.textContent ?? null,
          timeBlock: row.querySelector('[data-slot="review-time"]') !== null,
          sha: (() => {
            const link = row.querySelector<HTMLElement>('[data-slot="head-sha"]');
            return link === null
              ? null
              : {
                  href: link.getAttribute("href"),
                  label: link.getAttribute("aria-label"),
                  text: link.textContent ?? "",
                };
          })(),
        };
      }),
      rounds: [...container.querySelectorAll('[data-slot="review-round"]')].map((chip) => chip.textContent ?? ""),
      // Only the measured round prints a time; the historical rows omit it.
      // The label must be real TEXT inside the span (its accessible name) —
      // a null here fails the assertion below, so removing it cannot pass.
      durations: [...container.querySelectorAll('[data-slot="review-duration"]')].map((duration) => ({
        label: duration.querySelector(".sr-only")?.textContent ?? null,
        value: duration.lastChild?.textContent ?? "",
      })),
      durationTitles: [...container.querySelectorAll('[data-slot="review-duration"]')].map((duration) =>
        duration.getAttribute("title"),
      ),
      // The summary body and its expand/collapse control are gone: a review
      // row is its two lines alone.
      foldControls: container.querySelectorAll('[role="tabpanel"] button[aria-expanded][aria-controls]').length,
      bodies: [...container.querySelectorAll('[role="tabpanel"] p')].map((body) => body.textContent ?? ""),
      // No provider means no dangling separator: the attributed row reads
      // `model · provider`, the unattributed one stops at its model.
      latestHead: reviewHead(container, 2),
      olderHead: reviewHead(container, 1),
    }));
    expect(read.selected).toEqual([false, true, false]);
    // Three rows render; only the two carrying an ordinal print a chip.
    expect(read.rows).toHaveLength(3);
    expect(read.rows.every((row) => row.lines === 2)).toBe(true);
    expect(read.rows.every((row) => row.timeBlock)).toBe(true);
    expect(read.rounds).toEqual([
      t("en", "pullRequests.reviewRound", { round: 2 }),
      t("en", "pullRequests.reviewRound", { round: 1 }),
    ]);
    // Line 2: the verdict, then one `label count` pair per non-zero class in
    // SEVERITY_GROUPS order; the tally-less round renders its verdict alone.
    expect(read.rows.map((row) => row.counts)).toEqual([
      `ship it · ${t("en", "pullRequests.severityMustFix")} 2 · ${t("en", "pullRequests.severityNit")} 1`,
      `ship it · ${t("en", "pullRequests.severityNit")} 1`,
      "ship it",
    ]);
    // The relative time lives in the right block, never in line 1.
    expect(read.rows.map((row) => row.time)).toEqual([
      formatRelativeTime("2026-11-01 09:00:00", "en"),
      formatRelativeTime("2026-10-30 09:00:00", "en"),
      formatRelativeTime("2026-10-29 09:00:00", "en"),
    ]);
    expect(read.rows.every((row) => !row.timeInHead)).toBe(true);
    // The short sha is an external link naming the commit.
    expect(read.rows.map((row) => row.sha)).toEqual([
      {
        href: "https://github.com/acme/web/commit/aaa111b",
        label: t("en", "pullRequests.openCommitOnGithub", { sha: "aaa111b" }),
        text: "aaa111b",
      },
      {
        href: "https://github.com/acme/web/commit/bbb222c",
        label: t("en", "pullRequests.openCommitOnGithub", { sha: "bbb222c" }),
        text: "bbb222c",
      },
      {
        href: "https://github.com/acme/web/commit/ccc333d",
        label: t("en", "pullRequests.openCommitOnGithub", { sha: "ccc333d" }),
        text: "ccc333d",
      },
    ]);
    const durationLabel = t("en", "pullRequests.reviewDurationLabel");
    expect(read.durations).toEqual([
      {
        label: durationLabel,
        value: t("en", "pullRequests.reviewDurationMinutes", { minutes: 1, seconds: 5 }),
      },
    ]);
    // The same words ride the tooltip, still the hover affordance.
    expect(read.durationTitles).toEqual([durationLabel]);
    expect(read.foldControls).toBe(0);
    expect(read.bodies).toEqual([]);
    expect(read.latestHead).toContain(
      t("en", "pullRequests.reviewMeta", { model: "kimi-for-coding", provider: "openrouter" }),
    );
    expect(read.olderHead).toContain("kimi-for-coding");
    expect(read.olderHead).not.toContain(" · ");
    expect(markup).not.toContain("Everything the last round asked for is in.");
    expect(markup).not.toContain(t("en", "pullRequests.noReviews"));
  });

  test("a legacy-era tally rolls its non-vocabulary keys into one Other count", async () => {
    // M1 reviews tallied critical | warning | suggestion | info; none of
    // those spellings is in the merge-class vocabulary. The row must still
    // carry a per-category breakdown: the unknown keys sum into the single
    // `other` bucket the findings list already uses, and no known class is
    // fabricated for them.
    const reviews = page<PullRequestReview>([
      {
        verdict: "comment",
        model: "claude",
        provider: "",
        reviewed_at: "2026-11-01 09:00:00",
        head_sha: "legacy1a",
        round: 3,
        findings: 3,
        duration_ms: null,
        severity_counts: { critical: 2, info: 1 },
      },
      {
        verdict: "ship it",
        model: "kimi-for-coding",
        provider: "",
        reviewed_at: "2026-10-30 09:00:00",
        head_sha: "mixed01a",
        round: 2,
        findings: 3,
        duration_ms: null,
        severity_counts: { "must-fix": 1, critical: 2 },
      },
      {
        // All-known tallies keep vocabulary order and stay per-class.
        verdict: "ship it",
        model: "kimi-for-coding",
        provider: "",
        reviewed_at: "2026-10-29 09:00:00",
        head_sha: "known001",
        round: 1,
        findings: 6,
        duration_ms: null,
        severity_counts: { nit: 1, "should-fix": 3, "must-fix": 2 },
      },
    ]);
    const read = await withMarkup(
      face({ findings: page([]), failures: page([]), reviews }),
      (container) =>
        [...container.querySelectorAll('[data-slot="review-counts"]')].map((line) => ({
          text: line.textContent ?? "",
          severities: [...line.querySelectorAll('[data-slot="review-class-count"]')].map(
            (slot) => slot.getAttribute("data-severity"),
          ),
        })),
    );
    const otherLabel = t("en", "pullRequests.severityOther");
    expect(read).toEqual([
      // One aggregate for the whole legacy tally — never a fabricated
      // `critical`/`info` pair.
      { text: `comment · ${otherLabel} 3`, severities: [CATCH_ALL_SEVERITY] },
      // The known class keeps its own slot, in front of the aggregate.
      {
        text: `ship it · ${t("en", "pullRequests.severityMustFix")} 1 · ${otherLabel} 2`,
        severities: ["must-fix", CATCH_ALL_SEVERITY],
      },
      // All-known rounds render in vocabulary order, unchanged.
      {
        text: `ship it · ${t("en", "pullRequests.severityMustFix")} 2 · ${t("en", "pullRequests.severityShouldFix")} 3 · ${t("en", "pullRequests.severityNit")} 1`,
        severities: ["must-fix", "should-fix", "nit"],
      },
    ]);
  });

  test("a finding row names the round that first reported it, from the card's bottom row", async () => {
    // The default face opens on findings, so its rows are the rendered list.
    // The round chip lives in the card's bottom row, opposite the fold
    // button — not beside the title.
    const rounds = await withMarkup(face(), (container) =>
      [...container.querySelectorAll('[data-slot="finding"]')].map((row) => {
        const chip = row.querySelector('[data-slot="finding-round"]');
        if (chip === null) return null;
        const actions = chip.closest('[data-slot="finding-actions"]');
        return {
          text: chip.textContent ?? "",
          inBottomRow: actions !== null,
          // The bottom row also holds the fold control.
          withFoldButton:
            actions?.querySelector('button[aria-expanded][aria-controls]') !== null &&
            actions?.querySelector('[data-slot="finding-round"]') === chip,
        };
      }),
    );
    expect(rounds).toEqual([
      { text: t("en", "pullRequests.reviewRound", { round: 1 }), inBottomRow: true, withFoldButton: true },
      { text: t("en", "pullRequests.reviewRound", { round: 2 }), inBottomRow: true, withFoldButton: true },
      // No stored review carries this finding's first-seen sha: no chip, not
      // an empty one.
      null,
    ]);
  });

  test("an empty head sha renders neither chip nor aside row", async () => {
    const emptySha = face(
      // No review row either: the band's verdict then falls back to the PR
      // row's summary, which is absent too.
      { reviews: page([]) },
      { head_sha: "" },
      null,
    );
    // The PR-level chip disappears rather than rendering an empty one; its
    // tooltip and the aside's Head row go with it.
    expect(
      await withMarkup(emptySha, (container) =>
        [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map((chip) => chip.textContent ?? ""),
      ),
    ).toEqual([]);
    expect(emptySha).not.toContain(t("en", "pullRequests.headSha"));
    expect(emptySha).not.toContain(t("en", "pullRequests.factHead"));
    // The verdict figure is announced rather than left blank.
    expect(emptySha).toContain(t("en", "pullRequests.noVerdict"));
  });

  test("the aside timeline is capped and still ends on the PR's first sighting", async () => {
    const history = page(
      Array.from({ length: 12 }, (_, index) => ({
        verdict: "needs fixes",
        // The timeline's meta line renders the review's model, so a per-review
        // model is the one stable, rendered marker of WHICH rows survived.
        model: `model-${String(index).padStart(2, "0")}`,
        provider: "",
        // Newest first, as the store orders them; one hour apart.
        reviewed_at: `2026-11-01 ${String(12 - index).padStart(2, "0")}:00:00`,
        head_sha: `sha${index}`,
        round: 12 - index,
        findings: 0,
        duration_ms: null,
        severity_counts: {},
      })),
    );
    const markup = face(
      { reviews: history },
      {},
      { verdict: "needs fixes", reviewed_at: history.items[0]?.reviewed_at ?? "" },
    );
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
    // The dropped six are named, not silently swallowed: 12 reviews plus the
    // payload's one failure make 13 events, of which the cap shows seven — so
    // the aside renders nine rows: seven capped entries, the truncation note,
    // and the PR's own anchor. The truncation row itself carries the count and
    // closes the shown history.
    expect(
      await withMarkup(markup, (container) => {
        const rows = [...container.querySelectorAll('[data-slot="activity-entry"], [data-slot="timeline-truncated"]')].map(
          (row) => row.getAttribute("data-slot"),
        );
        return {
          count: rows.length,
          last: rows.at(-1),
          beforeAnchor: rows.at(-2),
          text: container.querySelector('[data-slot="timeline-truncated"]')?.textContent ?? "",
        };
      }),
    ).toEqual({ count: 9, last: "activity-entry", beforeAnchor: "timeline-truncated", text: truncation });
  });

  test("the truncation count names the PR's whole history, not the loaded page", async () => {
    // The loaded window is one page per family; the PR's real history is the
    // sections' totals. A count derived from the page would report 0 here.
    const reviews = page(
      Array.from({ length: 3 }, (_, index) => ({
        verdict: "needs fixes",
        model: `model-${index}`,
        provider: "",
        reviewed_at: `2026-10-31 ${String(12 - index).padStart(2, "0")}:00:00`,
        head_sha: `sha${index}`,
        round: 3 - index,
        findings: 0,
        duration_ms: null,
        severity_counts: {},
      })),
      30,
    );
    const built = scene({ reviews, failures: page([], 5) });
    const read = await withMarkup(render(built.detail, recordsOf(built.pages)), (container) => ({
      entries: container.querySelectorAll('[data-slot="activity-entry"]').length,
      text: container.querySelector('[data-slot="timeline-truncated"]')?.textContent ?? "",
    }));
    // Three loaded reviews, each shown, plus the PR's own anchor row; the
    // history behind them is 30 reviews + 5 failures.
    expect(read.entries).toBe(4);
    expect(read.text).toBe(t("en", "pullRequests.timelineHidden", { count: 32 }));
  });

  test("a timeline that fits the cap renders no truncation row", async () => {
    // Six reviews plus the anchor is under the seven-event cap.
    const reviews = page(
      Array.from({ length: 6 }, (_, index) => ({
        verdict: "ship it",
        model: `model-${index}`,
        provider: "",
        reviewed_at: `2026-10-31 ${String(12 - index).padStart(2, "0")}:00:00`,
        head_sha: `sha${index}`,
        round: 6 - index,
        findings: 0,
        duration_ms: null,
        severity_counts: {},
      })),
    );
    // Nothing was dropped: every entry renders and the truncation row is absent
    // rather than empty.
    expect(
      await withMarkup(face({ reviews, failures: page([]) }), (container) => ({
        entries: container.querySelectorAll('[data-slot="activity-entry"]').length,
        // A boolean, not the node: the window is gone once the read returns.
        truncated: container.querySelector('[data-slot="timeline-truncated"]') !== null,
      })),
    ).toEqual({ entries: 7, truncated: false });
  });

  test("a failure's first line renders as escaped text and the remaining output stays in details", async () => {
    const markup = failing();
    expect((await withMarkup(markup, familyTabs)).map((tab) => tab.selected)).toEqual([
      false,
      false,
      true,
    ]);
    expect(markup).toContain("sandbox");
    expect(markup).toContain("exit 1: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    // The failure block carries its danger ruling as a semantic hook, so the
    // alarm is read from the DOM rather than from a generated class literal.
    expect(
      await withMarkup(markup, (container) => {
        const block = container.querySelector('[role="tabpanel"] li[data-tone="danger"]');
        return block === null ? null : (block.textContent ?? "");
      }),
    ).toContain("sandbox");
    // A multi-line error folds what the row has not already said: the
    // disclosure starts at the SECOND line, because the first one is the
    // diagnosis above it. The disclosure's behaviour (and the clipboard's full
    // text) is pinned in the mounted suite, where it can actually be opened.
    const failureText = (error: string) =>
      face({
        findings: page([]),
        reviews: page([]),
        failures: page([{ stage: "sandbox", error, created_at: "2026-10-31 23:00:00" }]),
      });
    const multiline = failureText("a\nb");
    expect(multiline).toContain(t("en", "pullRequests.failureRemainingOutput"));
    const folded = await withMarkup(multiline, (container) => ({
      diagnosis: container.querySelector('[role="tabpanel"] li[data-tone="danger"] p')?.textContent ?? "",
      evidence: container.querySelector('[role="tabpanel"] pre')?.textContent ?? "",
    }));
    expect(folded.diagnosis).toBe("a");
    expect(folded.evidence).toBe("b");
    expect(folded.evidence.startsWith(folded.diagnosis)).toBe(false);
    // A single-line error has nothing to fold.
    expect(
      await withMarkup(markup, (container) => container.querySelector('[role="tabpanel"] details') !== null),
    ).toBe(false);
    // A trailing newline is not a second line: `"boom\n"` is one line of
    // output, so it renders no disclosure either.
    const trailing = await withMarkup(failureText("boom\n"), (container) => ({
      details: container.querySelector('[role="tabpanel"] details') !== null,
      text: container.querySelector('[role="tabpanel"] li[data-tone="danger"]')?.textContent ?? "",
    }));
    expect(trailing.details).toBe(false);
    expect(trailing.text).toContain("boom");
  });

  test("a failure with no recorded stage renders neither chip nor a dangling separator", async () => {
    // The payload coerces a missing stage to "": an empty chip would read as a
    // fact, and `Review failed · ` would leave the separator hanging.
    const read = await withMarkup(
      face({
        findings: page([]),
        reviews: page([]),
        failures: page([{ stage: "", error: "boom", created_at: "2026-10-31 23:00:00" }]),
      }),
      (container) => {
        // The failure row is the activity entry whose label names the failure;
        // the review row carries its own verdict label instead.
        const entry = [...container.querySelectorAll<HTMLElement>('[data-slot="activity-entry"]')].find((row) =>
          (row.textContent ?? "").startsWith(t("en", "pullRequests.timelineFailureNoStage")),
        );
        return {
          entryFound: entry !== undefined,
          stageChip: container.querySelector('[role="tabpanel"] [data-slot="failure-stage"]') !== null,
          labels: [...(entry?.querySelectorAll("span") ?? [])].map((span) => span.textContent ?? ""),
        };
      },
    );
    expect(read.entryFound).toBe(true);
    expect(read.stageChip).toBe(false);
    expect(read.labels).toContain(t("en", "pullRequests.timelineFailureNoStage"));
    // No span of the row paints a leading or trailing separator.
    expect(read.labels.filter((label) => /^\s*·|·\s*$/.test(label))).toEqual([]);
  });

  test("a finding body id encodes punctuation, so distinct ids never collide", async () => {
    // Ids differing only by punctuation (space vs dash) and otherwise equal
    // would map onto one id under a fold-to-dash sanitiser: a duplicate DOM id
    // whose `aria-controls` pointed at the other record's body.
    const finding = (finding_id: string, body: string) => ({
      finding_id,
      severity: "nit",
      title: "",
      file_path: "",
      line: null,
      body,
      review_round: null,
    });
    const markup = face({
      findings: page([finding("f 1", "First record."), finding("f-1", "Second record.")]),
    });
    // The encoding is the contract: distinct keys, distinct ids.
    expect(recordId("base", "f 1")).not.toBe(recordId("base", "f-1"));
    const read = await withMarkup(markup, (container) => {
      const bodyOf = (id: string) =>
        [...container.querySelectorAll<HTMLElement>("p[id]")].find((body) => body.id === id) ?? null;
      return [...container.querySelectorAll<HTMLElement>('[role="tabpanel"] button[aria-controls]')].map((control) => {
        const id = control.getAttribute("aria-controls") ?? "";
        return { id, body: bodyOf(id)?.textContent ?? null };
      });
    });
    expect(read).toHaveLength(2);
    expect(new Set(read.map(({ id }) => id)).size).toBe(2);
    // Each control points at its own record's body, not the other one's.
    expect(read.map(({ body }) => body)).toEqual(["First record.", "Second record."]);
  });

  test("the pager reports the loaded range over the section total and respects the bounds", async () => {
    const pages = {
      ...RECORDS,
      // The head counts 25 findings; this page holds three of them.
      findings: page(FINDINGS, 25),
    };
    const range = (container: HTMLElement) =>
      container.querySelector('[data-slot="pager-range"]')?.textContent ?? "";
    const controls = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].map((button) => ({
        label: button.textContent ?? "",
        disabled: button.disabled,
      }));
    const built = scene(pages);
    const first = await withMarkup(render(built.detail, recordsOf(built.pages)), (container) => ({
      range: range(container),
      controls: controls(container),
    }));
    expect(first.range).toBe(t("en", "pullRequests.pageRange", { from: 1, to: 3, total: 25 }));
    expect(first.controls).toEqual([
      { label: t("en", "pullRequests.pagePrev"), disabled: true },
      { label: t("en", "pullRequests.pageNext"), disabled: false },
    ]);

    // A later page: the range moves and prev is live. The last page disables next.
    const last = await withMarkup(
      render(built.detail, recordsOf(built.pages, 22)),
      (container) => ({ range: range(container), controls: controls(container) }),
    );
    expect(last.range).toBe(t("en", "pullRequests.pageRange", { from: 23, to: 25, total: 25 }));
    expect(last.controls).toEqual([
      { label: t("en", "pullRequests.pagePrev"), disabled: false },
      { label: t("en", "pullRequests.pageNext"), disabled: true },
    ]);
  });

  test("a page that dropped rows says so beside the range; a clean page says nothing", async () => {
    // Two of the head's three findings could be rendered: the third still sits
    // inside `total`, so the range alone would promise a row no window can show.
    const built = scene({ ...RECORDS, findings: page(FINDINGS.slice(0, 2), 3) });
    const note = (pages: RecordPages) =>
      withMarkup(render(built.detail, recordsOf(pages)), (container) => ({
        note: container.querySelector('[data-slot="pager-dropped"]')?.textContent ?? null,
      }));
    expect(
      await note({ ...built.pages, findings: { ...built.pages.findings, dropped: 1 } }),
    ).toEqual({ note: t("en", "pullRequests.pageDropped", { count: 1 }) });
    // Nothing dropped, no note.
    expect(await note(built.pages)).toEqual({ note: null });
  });

  test("a page that shrank under a stale offset renders a clamped range, and the range is a live region", async () => {
    // The server's total fell to 20 between reads while the reader still holds
    // offset 20: the honest page is empty, and the label must never invert.
    const built = scene({ ...RECORDS, findings: page([], 20) });
    const read = (offset: number) =>
      withMarkup(render(built.detail, recordsOf(built.pages, offset)), (container) => {
        const label = container.querySelector('[data-slot="pager-range"]');
        return { range: label?.textContent ?? "", live: label?.getAttribute("aria-live") ?? null };
      });
    expect(await read(20)).toEqual({
      range: t("en", "pullRequests.pageRange", { from: 20, to: 20, total: 20 }),
      live: "polite",
    });
    // An offset past the new total also clamps rather than reading 31–30.
    expect((await read(30)).range).toBe(t("en", "pullRequests.pageRange", { from: 20, to: 20, total: 20 }));
  });

  test("the findings filter lives in the toolbar row, only while the PR has findings", async () => {
    const filter = async (markup: string) =>
      withMarkup(markup, (container) => {
        const trigger = container.querySelector('[role="combobox"]');
        const toolbar = container.querySelector('[data-slot="record-toolbar"]');
        const findingsPanel = container.querySelector('[role="tabpanel"][data-state="active"]');
        return {
          present: trigger !== null,
          name: trigger?.getAttribute("aria-label") ?? "",
          // The filter shares the record pill's toolbar row, at its right
          // edge — never inside the findings body.
          inToolbar: toolbar !== null && toolbar.querySelector('[role="combobox"]') !== null,
          inFindingsBody: findingsPanel?.querySelector('[role="combobox"]') !== null,
        };
      });
    expect(await filter(face())).toEqual({
      present: true,
      name: t("en", "pullRequests.filterSeverity"),
      inToolbar: true,
      inFindingsBody: false,
    });
    // No findings to filter: the control is noise, so it is absent.
    expect((await filter(face({ findings: page([]) }))).present).toBe(false);
  });

  test("a failed section read renders its retry and claims nothing about an empty list", async () => {
    // Each family owns its read; a failed one must show the failure face with
    // its retry, not the empty-list copy — an empty window and an unread window
    // mean different things to the operator. The head still counts the rows, so
    // the tab keeps its count while its panel carries the failure.
    const cases: Array<{
      section: "findings" | "reviews" | "failures";
      pages: Partial<RecordPages>;
      emptyCopy: DictionaryKey;
      rows: string;
    }> = [
      {
        section: "findings",
        pages: {},
        emptyCopy: "pullRequests.noFindings",
        rows: "Use a parameterized query",
      },
      {
        section: "reviews",
        pages: { findings: page([]), reviews: page(REVIEWS), failures: page([]) },
        emptyCopy: "pullRequests.noReviews",
        rows: "The refresh race is still reachable.",
      },
      {
        section: "failures",
        pages: { findings: page([]), reviews: page([]), failures: page(FAILURES) },
        emptyCopy: "pullRequests.noFailures",
        rows: "<script>alert(1)</script>",
      },
    ];

    for (const { section, pages, emptyCopy, rows } of cases) {
      const built = scene(pages);
      const markup = render(built.detail, {
        ...recordsOf(built.pages),
        [section]: { offset: 0, severity: "", status: "error" as const, page: null, newest: null },
      });
      const read = await withMarkup(markup, (container) => {
        const alert = container.querySelector('[data-slot="error-state"]');
        return {
          retry: [...(alert?.querySelectorAll("button") ?? [])].map((button) => button.textContent),
          text: container.textContent ?? "",
        };
      });
      // The retry control is the whole point: a failed read is recoverable.
      expect(read.retry).toEqual([t("en", "common.retry")]);
      // No empty-list claim about a window that was never read, and no rows
      // from a failed page either.
      expect(read.text).not.toContain(t("en", emptyCopy));
      expect(read.text).not.toContain(rows);
    }
  });

  test("a filtered findings window with no match names the filter, not the PR", async () => {
    // The head counts three findings while the nit filter matches none: the
    // empty copy must describe the FILTER, or it contradicts the tab count.
    const built = scene({ findings: page([], 3) });
    const copy = (severity: string) =>
      withMarkup(render(built.detail, recordsOf({ ...built.pages, findings: page([]) }, 0, severity)), (container) =>
        container.querySelector('[role="tabpanel"] p')?.textContent ?? "",
      );
    expect(await copy("nit")).toBe(
      t("en", "pullRequests.noFindingsForSeverity", { severity: t("en", "pullRequests.severityNit") }),
    );
    expect(await copy("must-fix")).toBe(
      t("en", "pullRequests.noFindingsForSeverity", { severity: t("en", "pullRequests.severityMustFix") }),
    );
    // An out-of-set severity names itself, as the buckets already do.
    expect(await copy("blocker")).toBe(
      t("en", "pullRequests.noFindingsForSeverity", { severity: "blocker" }),
    );
    // The unfiltered empty window keeps the PR-level copy.
    expect(await copy("")).toBe(t("en", "pullRequests.noFindings"));
  });

  test("the loading face keeps the back control outside the busy region", async () => {
    // The loading face before any read lands: `aria-busy` must scope the
    // content, leaving the only escape control reachable to assistive tech.
    const read = await withMarkup(
      renderToStaticMarkup(
        createElement(PullRequestDetailFace, {
          locale: "en",
          appId: "1",
          prKey: "acme/web/133",
          prRef: { owner: "acme", repo: "web", number: 133 },
          onBack: () => {},
        }),
      ),
      (container) => {
        const back = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === t("en", "pullRequests.backToList"),
        );
        const busy = container.querySelector('[aria-busy="true"]');
        return {
          backRendered: back !== undefined,
          backDisabled: back?.disabled ?? true,
          // `aria-busy` and `aria-hidden` inherit down the tree, so a busy or
          // hidden ancestor would take the control out of the accessibility
          // tree with the content it sits in.
          backBusy: back !== undefined && back.closest('[aria-busy="true"]') !== null,
          backHidden: back !== undefined && back.closest('[aria-hidden="true"]') !== null,
          contentBusy: busy !== null,
          status: busy?.querySelector('[role="status"]')?.textContent ?? null,
        };
      },
    );
    expect(read).toEqual({
      backRendered: true,
      backDisabled: false,
      backBusy: false,
      backHidden: false,
      contentBusy: true,
      status: t("en", "common.loading"),
    });
  });

  test("the aside carries the PR facts and one merged timeline, newest first", () => {
    const markup = face();
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

  test("the toolbar and record list share one main column beside the aside", async () => {
    // Structure, not class strings: at xl the shell is a flex row whose main
    // column stacks the toolbar over the record list, with the aside as the
    // main column's sibling, so a tall aside can never size the list's start.
    // Below xl the same DOM stacks toolbar → list → aside in one column.
    // Toolbar and list are located independently by their data-slot, so each
    // assertion can fail: the order pin fails if the list moves above the
    // toolbar, the parent pins fail if either leaves the main column.
    const layout = await withMarkup(face(), (container) => {
      const toolbar = container.querySelector('[data-slot="record-toolbar"]');
      const recordList = container.querySelector('[data-slot="record-list"]');
      const aside = container.querySelector("aside");
      const main = container.querySelector('[data-slot="record-main"]');
      const shell = container.querySelector('[data-slot="record-layout"]');
      const siblings = Array.from(main?.children ?? []);
      const toolbarPrecedesList =
        toolbar !== null &&
        recordList !== null &&
        siblings.indexOf(toolbar) !== -1 &&
        siblings.indexOf(recordList) > siblings.indexOf(toolbar);
      return {
        toolbarExists: toolbar !== null,
        recordListExists: recordList !== null,
        toolbarAndListShareMain: toolbar?.parentElement === main && recordList?.parentElement === main,
        toolbarPrecedesList: Boolean(toolbarPrecedesList),
        mainIsRecordMain: main?.getAttribute("data-slot") === "record-main",
        shellIsRecordLayout: shell?.getAttribute("data-slot") === "record-layout",
        asideIsShellChild: aside !== null && aside.parentElement === shell,
        asideOutsideMain: aside !== null && aside.parentElement !== main,
      };
    });
    expect(layout).toEqual({
      toolbarExists: true,
      recordListExists: true,
      toolbarAndListShareMain: true,
      toolbarPrecedesList: true,
      mainIsRecordMain: true,
      shellIsRecordLayout: true,
      asideIsShellChild: true,
      asideOutsideMain: true,
    });
  });
});

/**
 * The reviewing-now badge on the DETAIL header (compass D11/D16). The header
 * reads the projection the payload carries — it never derives it — so these
 * pin the three states the wire can hand it: a live lock with its anchor, an
 * idle PR with no badge at all, and a failed read that must not pass as idle.
 */
describe("reviewing-now badge on the detail header (D11)", () => {
  const IDLE_HEAD = ROW_HEAD.head_sha.slice(0, 7);

  test("a live lock carries the holding attempt's head sha", () => {
    const markup = face(
      {},
      { reviewing: { state: "live", head_sha: "abc1234def567", acquired_at: "2026-11-01T10:00:00.000Z" } },
    );
    expect(markup).toContain(t("en", "pullRequests.reviewingHead", { head: "abc1234" }));
  });

  test("a live lock with no head sha carries its acquisition time instead", () => {
    const acquiredAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const markup = face({}, { reviewing: { state: "live", head_sha: "", acquired_at: acquiredAt } });
    expect(markup).toContain(
      t("en", "pullRequests.reviewingSince", { time: formatRelativeTime(acquiredAt, "en") }),
    );
  });

  test("no live lock paints no badge — and no unknown note either", () => {
    const markup = face({}, { reviewing: { state: "none" } });
    // The header really rendered (its own state pill is there).
    expect(markup).toContain(t("en", "pullRequests.state.merged"));
    expect(markup).not.toContain(t("en", "pullRequests.reviewingUnknown"));
    expect(markup).not.toContain(t("en", "pullRequests.reviewingHead", { head: IDLE_HEAD }));
  });

  test("an unreadable inflight read paints unknown, never the reviewing badge", () => {
    const markup = face({}, { reviewing: { state: "unknown" } });
    expect(markup).toContain(t("en", "pullRequests.reviewingUnknown"));
    expect(markup).not.toContain(t("en", "pullRequests.reviewingHead", { head: IDLE_HEAD }));
  });
});
