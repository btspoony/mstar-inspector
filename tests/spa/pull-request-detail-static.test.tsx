/**
 * Pull request detail face (App detail IA): the static faces and pure helpers.
 *
 * Static-SSR pins over the pure face (the InsightsRecordsView idiom): the
 * header facts and metric band, the severity buckets, the folds, the failures
 * panel, and the aside timeline — plus the read/parse derivations that face
 * consumes. Mounted (happy-dom) behaviour lives in
 * `pull-request-detail-interaction.test.tsx`; payloads shared with the list
 * suite live in `pull-request-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  appPullRequestDetailUrl,
  githubPullRequestUrl,
  githubRepoUrl,
  parsePullRequestDetail,
  type PullRequestDetail,
} from "../../src/spa/pages/data";
import {
  PullRequestDetail as PullRequestDetailFace,
  PullRequestDetailView,
} from "../../src/spa/pages/PullRequestDetail";
import { recordId } from "../../src/spa/pages/pullRequestDetailModel";
import { withMarkup } from "./dom";
import { DETAIL, ROW_OPEN } from "./pull-request-fixtures";

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

  test("the GitHub builders encode each segment and cannot escape the path", () => {
    expect(githubRepoUrl("acme", "web")).toBe("https://github.com/acme/web");
    // A hostile segment stays inside the path: `/`, `?` and `#` are encoded,
    // so it cannot rewrite the host, the query or the fragment.
    expect(githubRepoUrl("a/b", "x?y#z")).toBe("https://github.com/a%2Fb/x%3Fy%23z");
    expect(githubPullRequestUrl("acme", "web", 42)).toBe("https://github.com/acme/web/pull/42");
    expect(githubPullRequestUrl("a/b", "x?y", 7)).toBe("https://github.com/a%2Fb/x%3Fy/pull/7");
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

  test("a review with provider null parses and renders without a null leak (QC)", async () => {
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
    await withMarkup(renderToStaticMarkup(createElement(PullRequestDetailView, { locale: "en", detail: parsed ?? DETAIL })), (container) => {
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
   * A failure-only detail: no finding at all, so nothing is actionable and the
   * face opens on the failures family with the diagnostic payload in the markup.
   */
  const FAILING: PullRequestDetail = { ...DETAIL, findings: [] };

  test("the PR number and its repository link to GitHub with a safe target", async () => {
    // Both links read their address from the row's own owner/repo/number; the
    // accessible name says where the control goes, and the glyph is decoration.
    const links = await withMarkup(render(DETAIL), (container) =>
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

  test("the header names the PR's own facts; the band aggregates them", async () => {
    // One render, read from the one tree: the header, its meta line and the
    // band all describe the same payload, so nothing here can pass against a
    // different render than the one it claims to read.
    const markup = render(DETAIL);
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
        (container) => container.querySelector('[data-slot="pr-meta"]') !== null,
      ),
    ).toBe(false);
    expect(read.metrics[0]).toEqual([t("en", "pullRequests.columnVerdict"), "needs fixes"]);
    expect(read.metrics[1]).toEqual([t("en", "pullRequests.reviews"), "2"]);
    expect(read.metrics[2]).toEqual([t("en", "pullRequests.failures"), "1"]);
    expect(read.metrics[3]?.[0]).toBe(t("en", "pullRequests.findings"));
    expect(read.metrics[3]?.[1]).toContain(t("en", "pullRequests.mustFixNote", { count: 1 }));
  });

  test("the band wears the danger face for a non-shipping verdict and any failure", async () => {
    const tones = await withMarkup(render(DETAIL), (container) =>
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
    const legacy = (verdict: string, summary: string): PullRequestDetail => ({
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict, reviewed_at: "2026-11-01 08:00:00" },
      },
      // No finding and no failure: the face opens on the reviews, where the
      // badge of the recorded verdict renders.
      findings: [],
      failures: [],
      reviews: [
        {
          verdict,
          summary_md: summary,
          model: "kimi-for-coding",
          provider: "openrouter",
          reviewed_at: "2026-11-01 08:00:00",
          head_sha: "aaa111bbb222",
        },
      ],
    });
    const read = async (detail: PullRequestDetail) =>
      withMarkup(render(detail), (container) => ({
        band: container.querySelectorAll('[data-slot="metric-value"]')[0]?.getAttribute("data-tone") ?? null,
        badge: container
          .querySelector('[role="tabpanel"] [data-slot="status-badge"]')
          ?.getAttribute("data-tone"),
        timeline: container.querySelector('[data-slot="activity-entry"]')?.getAttribute("data-tone"),
      }));
    // An approval is quiet on the band and success on the dot and the badge; a
    // change request is an alarm on all three — never one of each.
    expect(await read(legacy("approve", "Approved on an older round."))).toEqual({
      band: null,
      badge: "success",
      timeline: "success",
    });
    expect(await read(legacy("request_changes", "The race is still reachable."))).toEqual({
      band: "danger",
      badge: "danger",
      timeline: "danger",
    });
    // An unknown word is not an alarm either: neutral on every surface.
    expect(await read(legacy("looks fine", "An unknown verdict."))).toEqual({
      band: null,
      badge: "neutral",
      timeline: "neutral",
    });
  });

  test("a must-fix finding opens the findings family, grouped by severity", async () => {
    // One render, one parse: the triggers, their counts and the severity
    // groups all describe the same tree.
    const markup = render(DETAIL);
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
    // Group headers in severity order, each carrying its own count.
    expect(read.groups).toEqual([
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

  test("the danger dot marks an actionable family and a recorded failure, and nothing else", async () => {
    const dots = async (detail: PullRequestDetail) => withMarkup(render(detail), familyDots);
    const findingsLabel = t("en", "pullRequests.findings");
    const failuresLabel = t("en", "pullRequests.failures");
    const reviewsLabel = t("en", "pullRequests.reviews");

    // A must-fix and a should-fix both make the findings family actionable; a
    // recorded failure is an alarm of its own; history never earns a dot.
    expect(await dots(DETAIL)).toEqual({ [findingsLabel]: true, [reviewsLabel]: false, [failuresLabel]: true });
    // A should-fix alone is a requested change, not a nit.
    expect(
      (await dots({ ...DETAIL, findings: DETAIL.findings.filter((f) => f.severity === "should-fix") }))[findingsLabel],
    ).toBe(true);
    // Nits only: nothing to act on, so the findings trigger goes quiet.
    expect(await dots({ ...DETAIL, findings: DETAIL.findings.filter((f) => f.severity === "nit") })).toEqual({
      [findingsLabel]: false,
      [reviewsLabel]: false,
      [failuresLabel]: true,
    });
    // A severity this face does not name is still a requested change: the
    // `other` bucket stays visible, so its trigger must not read as quiet.
    expect(
      (await dots({ ...DETAIL, findings: DETAIL.findings.filter((f) => f.severity === "nit").map((f) => ({ ...f, severity: "blocker" })) }))[
        findingsLabel
      ],
    ).toBe(true);
    // No failure: the failures trigger loses its dot too.
    expect(await dots({ ...DETAIL, failures: [] })).toEqual({
      [findingsLabel]: true,
      [reviewsLabel]: false,
      [failuresLabel]: false,
    });
  });

  test("an out-of-set severity lands in the `other` bucket, last, with its count", async () => {
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
    const read = await withMarkup(render(detail), (container) => {
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
      `${t("en", "pullRequests.expand")} — Drop the unsafe default · #4`,
      `${t("en", "pullRequests.expand")} — #5`,
    ]);

    // One legacy severity, three surfaces, one rule: `blocker` is not a nit, so
    // the face opens on the findings, the trigger earns the danger dot (the
    // dot reads the bucket flags), and the finding still renders — in `other`,
    // the bucket it lands in rather than a reason to stay hidden.
    const legacyOnly: PullRequestDetail = { ...DETAIL, findings: detail.findings.slice(3) };
    const face = await withMarkup(render(legacyOnly), (container) => ({
      selected: familyTabs(container).map((tab) => tab.selected),
      dots: familyDots(container),
      buckets: severityGroups(container).map((group) => group.severity),
    }));
    expect(face.selected).toEqual([true, false, false]);
    expect(face.dots[t("en", "pullRequests.findings")]).toBe(true);
    expect(face.buckets).toEqual(["other"]);
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

  test("only the must-fix body opens; every other group starts folded", async () => {
    const markup = render(DETAIL);
    // Fold order follows the group order: must-fix, should-fix, nit.
    const { pairs, labels } = await withMarkup(markup, (container) => ({
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
    // Each toggle names the record it folds and its position, so identical
    // "Expand" labels do not leave several controls indistinguishable.
    expect(labels).toEqual([
      `${t("en", "pullRequests.collapse")} — Use a parameterized query · #1`,
      `${t("en", "pullRequests.expand")} — Session cookie lacks HttpOnly · #2`,
      `${t("en", "pullRequests.expand")} — Rename tmp to pending · #3`,
    ]);
  });

  test("two findings sharing a title still have distinct fold names", async () => {
    // Same title, same severity: only the position separates them, so the
    // label rule must carry it for every record rather than only for the
    // ones with no text at all.
    const twin: PullRequestDetail = {
      ...DETAIL,
      findings: [
        { finding_id: "f-1", severity: "must-fix", title: "Guard the write", file_path: "", line: null, body: "" },
        { finding_id: "f-2", severity: "must-fix", title: "Guard the write", file_path: "", line: null, body: "" },
      ],
    };
    const labels = await withMarkup(render(twin), (container) =>
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
    const untitled: PullRequestDetail = {
      ...DETAIL,
      findings: [
        { finding_id: "f-1", severity: "must-fix", title: "", file_path: "", line: null, body: "" },
        { finding_id: "f-2", severity: "should-fix", title: "", file_path: "", line: null, body: "" },
      ],
    };
    const findingLabels = await withMarkup(render(untitled), (container) =>
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
      await withMarkup(render(unattributed), (container) =>
        [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
          (control) => control.getAttribute("aria-label") ?? "",
        ),
      ),
    ).toEqual([
      `${t("en", "pullRequests.collapse")} — #1`,
      `${t("en", "pullRequests.expand")} — #2`,
    ]);
  });

  test("a should-fix finding alone opens the findings family", async () => {
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
    const markup = render(shouldOnly);
    expect((await withMarkup(markup, familyTabs)).map((tab) => tab.selected)).toEqual([
      true,
      false,
      false,
    ]);
    expect(markup).toContain("The refresh cookie is set with secure only.");
    // The findings figure counts the row but names no must-fix: the note is a
    // must-fix count, so a should-fix-only detail must not wear it.
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
    const read = await withMarkup(render(empty), (container) => {
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

  test("a clean detail opens on the reviews family with the latest summary readable", async () => {
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
    const read = await withMarkup(markup, (container) => ({
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
      `${t("en", "pullRequests.collapse")} — ship it · aaa111b · #1`,
      `${t("en", "pullRequests.expand")} — ship it · bbb222c · #2`,
    ]);
    expect(markup).not.toContain(t("en", "pullRequests.noReviews"));
  });

  test("an empty head sha renders neither chip nor aside row", async () => {
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
      await withMarkup(markup, (container) =>
        [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map((chip) => chip.textContent ?? ""),
      ),
    ).toEqual([]);
    expect(markup).not.toContain(t("en", "pullRequests.headSha"));
    expect(markup).not.toContain(t("en", "pullRequests.factHead"));
    // The verdict figure is announced rather than left blank.
    expect(markup).toContain(t("en", "pullRequests.noVerdict"));
  });

  test("the aside timeline is capped and still ends on the PR's first sighting", async () => {
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

  test("a timeline that fits the cap renders no truncation row", async () => {
    // Seven history entries is the cap: six shown plus the anchor, none dropped.
    const reviews = Array.from({ length: 6 }, (_, index) => ({
      verdict: "ship it",
      summary_md: `Round ${index}`,
      model: `model-${index}`,
      provider: "",
      reviewed_at: `2026-10-31 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
    }));
    const fitting = { ...DETAIL, reviews, failures: [] };
    // Nothing was dropped: every entry renders and the truncation row is absent
    // rather than empty.
    expect(
      await withMarkup(render(fitting), (container) => ({
        entries: container.querySelectorAll('[data-slot="activity-entry"]').length,
        // A boolean, not the node: the window is gone once the read returns.
        truncated: container.querySelector('[data-slot="timeline-truncated"]') !== null,
      })),
    ).toEqual({ entries: 7, truncated: false });
  });

  test("a failure's first line renders as escaped text and the remaining output stays in details", async () => {
    const markup = render(FAILING);
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
    const failureText = (error: string) => ({
      ...FAILING,
      failures: [{ stage: "sandbox", error, created_at: "2026-10-31 23:00:00" }],
    });
    const multiline = render(failureText("a\nb"));
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
    const trailing = await withMarkup(render(failureText("boom\n")), (container) => ({
      details: container.querySelector('[role="tabpanel"] details') !== null,
      text: container.querySelector('[role="tabpanel"] li[data-tone="danger"]')?.textContent ?? "",
    }));
    expect(trailing.details).toBe(false);
    expect(trailing.text).toContain("boom");
  });

  test("a failure with no recorded stage renders neither chip nor a dangling separator", async () => {
    // The payload coerces a missing stage to "": an empty chip would read as a
    // fact, and `Review failed · ` would leave the separator hanging.
    const stageless: PullRequestDetail = {
      ...DETAIL,
      findings: [],
      failures: [{ stage: "", error: "boom", created_at: "2026-10-31 23:00:00" }],
    };
    const read = await withMarkup(render(stageless), (container) => {
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
    });
    expect(read.entryFound).toBe(true);
    expect(read.stageChip).toBe(false);
    expect(read.labels).toContain(t("en", "pullRequests.timelineFailureNoStage"));
    // No span of the row paints a leading or trailing separator.
    expect(read.labels.filter((label) => /^\s*·|·\s*$/.test(label))).toEqual([]);
  });

  test("two records whose raw ids differ only by punctuation get distinct body ids", async () => {
    // The record keys differ only in punctuation (space vs `T` in the
    // timestamp), and the old fold-to-dash sanitisation mapped both onto one
    // id: a duplicate DOM id whose `aria-controls` pointed at one body.
    const punctuated = (reviewed_at: string, summary: string): PullRequestDetail["reviews"][number] => ({
      verdict: "ship it",
      summary_md: summary,
      model: "kimi-for-coding",
      provider: "",
      reviewed_at,
      head_sha: "aaa111b",
    });
    const detail: PullRequestDetail = {
      ...DETAIL,
      findings: [],
      failures: [],
      reviews: [punctuated("2026-11-01 08:00:00", "First record."), punctuated("2026-11-01T08:00:00", "Second record.")],
    };
    // The encoding is the contract: distinct keys, distinct ids — never one
    // sanitised text two records can share.
    expect(recordId("base", "2026-11-01 08:00:00")).not.toBe(recordId("base", "2026-11-01-08:00:00"));
    const read = await withMarkup(render(detail), (container) => {
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
