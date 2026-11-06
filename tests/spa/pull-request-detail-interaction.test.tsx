/**
 * Pull request detail face (App detail IA): the mounted faces.
 *
 * happy-dom pins over what only real effects and events prove: the family
 * switch and its section read, paging and the severity filter, fold toggles,
 * the copy action's per-block outcome and its late-write and unmount paths,
 * and the read stamp that keeps another PR's face off the current one. The
 * static faces and pure helpers live in `pull-request-detail-static.test.tsx`;
 * payloads shared with the list suite live in `pull-request-fixtures.ts`.
 */
import { describe, expect, jest, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { t } from "../../src/i18n";
import type { PullRequestFailure, PullRequestFinding } from "../../src/spa/pages/data";
import { currentDetailRead, type DetailRead } from "../../src/spa/pages/PullRequestDetail";
import {
  DETAIL,
  FAILURES,
  jsonResponse,
  mountDetailView,
  mountTabAcrossApps,
  page,
  press,
  scene,
} from "./pull-request-fixtures";

/** A face whose only records are failures: it opens on the failures family. */
const failuresOnly = (failures: PullRequestFailure[] = FAILURES) =>
  scene({ findings: page([]), reviews: page([]), failures: page(failures) });

describe("pull requests detail read derivation (pure)", () => {
  test("a read stamped for another pr derives to not-yet-loaded, whatever its kind", () => {
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
  test("each family trigger answers to its announced name, separator included", async () => {
    const { container, win, unmount } = await mountDetailView(scene());
    try {
      // A role/name query, the way an assistive technology finds the control:
      // the name a reader hears is label + count with a separator, never the
      // run-together "Findings3" the visible spans alone would produce. The
      // exact names are the static suite's claim; here the name must address a
      // real control.
      const byRoleName = (name: string) =>
        [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
          (tab) => (tab.getAttribute("aria-label") ?? tab.textContent) === name,
        );
      // The bare label is not the control's name...
      expect(byRoleName(t("en", "pullRequests.findings"))).toBeUndefined();
      // ...and the announced name selects its own panel.
      const reviews = byRoleName(`${t("en", "pullRequests.reviews")} (2)`);
      expect(reviews).toBeDefined();
      await press(win, reviews);
      expect(reviews?.getAttribute("aria-selected")).toBe("true");
    } finally {
      await unmount();
    }
  });

  test("the family switch and a fold toggle act on the live tree", async () => {
    const { container, win, unmount } = await mountDetailView(scene());
    try {
      const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
      const panels = () => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
      const selected = () => tabs().map((tab) => tab.getAttribute("aria-selected") === "true");
      const visible = () => panels().map((panel) => panel.hidden === false);
      // The counts carry a must-fix finding: findings first, its panel open.
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

      // The reviews family: the selection and the visible panel both move. Its
      // page is read on first selection and lands before the assertion.
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

  test("selecting a family renders its page; returning to it re-renders without a refetch storm", async () => {
    const { container, win, fetches, unmount } = await mountDetailView(scene());
    try {
      const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
      const text = () => container.textContent ?? "";
      // Landing: the opening family's rows are on screen (findings, by counts).
      expect(text()).toContain("Use a parameterized query");
      const afterLanding = fetches.length;

      // Selecting the reviews family renders its rows.
      await press(win, tabs()[1]);
      expect(text()).toContain(t("en", "pullRequests.reviewRound", { round: 2 }));

      // Returning to the visited family renders its rows again, and the second
      // visit does not issue a burst of reads: one bounded total, at most the
      // two the two selections need.
      await press(win, tabs()[0]);
      expect(text()).toContain("Use a parameterized query");
      await press(win, tabs()[1]);
      expect(text()).toContain(t("en", "pullRequests.reviewRound", { round: 2 }));
      expect(fetches.length - afterLanding).toBeLessThanOrEqual(2);
    } finally {
      await unmount();
    }
  });

  test("next and prev move the section offset and swap the page", async () => {
    const corpus: PullRequestFinding[] = Array.from({ length: 25 }, (_, index) => ({
      finding_id: `f-${index}`,
      severity: "must-fix",
      title: `Finding ${String(index).padStart(2, "0")}`,
      file_path: "",
      line: null,
      body: "",
      review_round: null,
    }));
    const { container, win, fetches, unmount } = await mountDetailView(scene({ findings: page(corpus) }));
    try {
      const text = () => container.textContent ?? "";
      const pagerButton = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
          (button) => button.textContent === label,
        );
      // First page: rows 0–9, the range names them, prev is at the bound.
      expect(text()).toContain("Finding 00");
      expect(text()).not.toContain("Finding 10");
      expect(container.querySelector('[data-slot="pager-range"]')?.textContent).toBe(
        t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 25 }),
      );
      expect(pagerButton(t("en", "pullRequests.pagePrev"))?.disabled).toBe(true);

      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      // At most the one page read the press needs — a bound, not a call count:
      // a dedupe or a retry is not a defect, a refetch storm is.
      const findingsReads = fetches.filter((url) => url.includes("/findings?"));
      expect(findingsReads.length).toBeLessThanOrEqual(2);
      expect(findingsReads.at(-1)).toContain("offset=10");
      expect(text()).toContain("Finding 10");
      expect(text()).not.toContain("Finding 00");
      expect(container.querySelector('[data-slot="pager-range"]')?.textContent).toBe(
        t("en", "pullRequests.pageRange", { from: 11, to: 20, total: 25 }),
      );

      await press(win, pagerButton(t("en", "pullRequests.pagePrev")));
      expect(text()).toContain("Finding 00");
      expect(container.querySelector('[data-slot="pager-range"]')?.textContent).toBe(
        t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 25 }),
      );
    } finally {
      await unmount();
    }
  });

  test("the pager strides on the limit the server applied, not on the size it asked for", async () => {
    const corpus: PullRequestFinding[] = Array.from({ length: 7 }, (_, index) => ({
      finding_id: `f-${index}`,
      severity: "must-fix",
      title: `Finding ${String(index).padStart(2, "0")}`,
      file_path: "",
      line: null,
      body: "",
      review_round: null,
    }));
    // The scene's page states a limit of 3: the route clamps to it and echoes
    // it back, so page 2 starts at 3. A stride re-derived from the client's own
    // constant (10) would ask for a window past the end and skip rows 4–7.
    const { container, win, fetches, unmount } = await mountDetailView(
      scene({ findings: { ...page(corpus), limit: 3 } }),
    );
    try {
      expect(container.textContent ?? "").toContain("Finding 00");
      expect(container.textContent ?? "").not.toContain("Finding 03");

      const next = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
        (button) => button.textContent === t("en", "pullRequests.pageNext"),
      );
      await press(win, next);
      expect(fetches.at(-1)).toContain("offset=3");
      expect(container.textContent ?? "").toContain("Finding 03");
    } finally {
      await unmount();
    }
  });

  test("a pager press commits only with its page: no skipped page, no range that outruns the rows", async () => {
    // >1 page of findings with the reads HELD open, so the frame a press leaves
    // on screen is observable: the range and both controls must describe the
    // rows still rendered, and a second press must land on page 2, never jump
    // to page 3 and drop the page-2 response on the floor.
    const corpus: PullRequestFinding[] = Array.from({ length: 25 }, (_, index) => ({
      finding_id: `f-${index}`,
      severity: "must-fix",
      title: `Finding ${String(index).padStart(2, "0")}`,
      file_path: "",
      line: null,
      body: "",
      review_round: null,
    }));
    const holds = ["offset=10", "offset=20"];
    // One gate per held REQUEST: the same window asked twice is two promises.
    const pending: Array<{ offset: string; resolve: (response: Response) => void }> = [];
    const settle = (offset: string) => {
      const gate = pending.find((candidate) => candidate.offset === offset);
      if (gate === undefined) throw new Error(`no held read for ${offset}`);
      pending.splice(pending.indexOf(gate), 1);
      const from = Number(offset.replace("offset=", ""));
      gate.resolve(jsonResponse({ items: corpus.slice(from, from + 10), total: corpus.length }));
    };
    const heldFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const offset = `offset=${url.searchParams.get("offset") ?? "0"}`;
      if (url.pathname.endsWith("/findings") && holds.includes(offset)) {
        return await new Promise<Response>((resolve) => pending.push({ offset, resolve }));
      }
      if (url.pathname.endsWith("/findings")) {
        const from = Number(offset.replace("offset=", ""));
        return jsonResponse({ items: corpus.slice(from, from + 10), total: corpus.length });
      }
      return jsonResponse(scene({ findings: page(corpus) }).detail);
    }) as unknown as typeof fetch;

    const { container, win, fetches, unmount } = await mountDetailView(
      scene({ findings: page(corpus) }),
      undefined,
      { fetch: heldFetch },
    );
    try {
      const pagerButton = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
          (button) => button.textContent === label,
        );
      const rangeText = () => container.querySelector('[data-slot="pager-range"]')?.textContent ?? "";
      const severityControl = () => container.querySelector<HTMLButtonElement>('[role="combobox"]');
      const findingsReads = () => fetches.filter((url) => url.includes("/findings?"));
      // The range the reader sees, derived from the rows actually rendered:
      // every row is must-fix, so one group holds them in corpus order.
      const renderedRange = () => {
        const numbers = [...container.querySelectorAll<HTMLElement>('[data-slot="finding"]')].map((row) =>
          Number(/Finding (\d\d)/.exec(row.textContent ?? "")?.[1] ?? Number.NaN),
        );
        return t("en", "pullRequests.pageRange", {
          from: (numbers[0] ?? 0) + 1,
          to: (numbers.at(-1) ?? 0) + 1,
          total: corpus.length,
        });
      };

      // Page 1 is settled: the label names its rows and Next is the live control.
      expect(rangeText()).toBe(renderedRange());
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(false);

      // First press: page 2 is in flight. The label still names the rows on
      // screen, and neither control can move a window that has not landed.
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(pending.map((gate) => gate.offset)).toEqual(["offset=10"]);
      expect(rangeText()).toBe(renderedRange());
      expect(rangeText()).toBe(t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 25 }));
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(true);
      expect(pagerButton(t("en", "pullRequests.pagePrev"))?.disabled).toBe(true);
      expect(severityControl()?.disabled).toBe(true);

      // A second press before the response lands cannot reach past page 2: the
      // control is inert, so no offset-20 read is ever issued.
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(findingsReads()).toHaveLength(2);

      // The page lands: page 2's rows and the range that names them, together.
      await act(async () => settle("offset=10"));
      expect(rangeText()).toBe(renderedRange());
      expect(rangeText()).toBe(t("en", "pullRequests.pageRange", { from: 11, to: 20, total: 25 }));
      expect(severityControl()?.disabled).toBe(false);
      expect(pagerButton(t("en", "pullRequests.pagePrev"))?.disabled).toBe(false);

      // The next window is a step from the page on screen, so page 3 follows.
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(pending.map((gate) => gate.offset)).toEqual(["offset=20"]);
      expect(rangeText()).toBe(renderedRange());
      expect(rangeText()).toBe(t("en", "pullRequests.pageRange", { from: 11, to: 20, total: 25 }));
      await act(async () => settle("offset=20"));
      expect(rangeText()).toBe(renderedRange());
      expect(rangeText()).toBe(t("en", "pullRequests.pageRange", { from: 21, to: 25, total: 25 }));
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(true);
    } finally {
      await unmount();
    }
  });

  test("paging the reviews list never rewrites the headline verdict or its attribution", async () => {
    // >1 page of reviews: page 2's first row is an OLDER review, so a header
    // that reads the loaded page flips the verdict and the attribution as soon
    // as the operator presses Next. The head's `latest_review` is the one
    // authoritative source.
    const corpus = Array.from({ length: 12 }, (_, index) => ({
      verdict: index === 0 ? "ship it" : "blocked",
      model: `model-${String(index).padStart(2, "0")}`,
      provider: "openrouter",
      reviewed_at: `2026-11-01 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
      // Newest first, so index 0 is the PR's last round (12).
      round: 12 - index,
      duration_ms: null,
      severity_counts: {},
    }));
    // The head read's newest review carries the attribution alone.
    const { verdict, model, provider, reviewed_at, head_sha } = corpus[0]!;
    const newest = { verdict, model, provider, reviewed_at, head_sha };
    const { container, win, unmount } = await mountDetailView(
      scene({ reviews: page(corpus) }, {}, newest),
    );
    try {
      const read = () => ({
        verdict: container.querySelectorAll('[data-slot="metric-value"]')[0]?.textContent ?? "",
        meta: container.querySelector('[data-slot="pr-meta"]')?.textContent ?? "",
      });
      // The head's verdict and attribution, on the opening family.
      expect(read().verdict).toBe("ship it");
      expect(read().meta).toContain("model-00");

      await press(win, container.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
      const activity = () =>
        [...container.querySelectorAll('[data-slot="activity-entry"]')].map((row) => row.textContent ?? "");
      // The aside's newest window, once the reviews first page landed.
      const aside = activity();
      expect(aside.length).toBeGreaterThan(0);
      const pagerButton = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
          (button) => button.textContent === label,
        );
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(false);
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));

      // Page 2 is on screen: its rows are the PR's two oldest rounds.
      expect(
        [...container.querySelectorAll('[data-slot="review-round"]')].map((chip) => chip.textContent),
      ).toEqual([
        t("en", "pullRequests.reviewRound", { round: 2 }),
        t("en", "pullRequests.reviewRound", { round: 1 }),
      ]);
      // …and the headline still reports the newest review, not the page's first.
      expect(read()).toEqual({ verdict: "ship it", meta: expect.stringContaining("model-00") });
      expect(read().meta).not.toContain("model-10");
      // …and the aside still describes the newest window: page 2 must not turn
      // the activity list into the PR's oldest events.
      expect(activity()).toEqual(aside);
    } finally {
      await unmount();
    }
  });

  test("the aside names the newest reviews and failures while the PR opens on findings", async () => {
    // The counts open this PR on findings, so neither history family was
    // selected: the aside must still describe the PR's newest reviews and
    // failures, and its hidden count must not move when the operator pages.
    const corpus = Array.from({ length: 12 }, (_, index) => ({
      verdict: "ship it",
      model: `model-${String(index).padStart(2, "0")}`,
      provider: "",
      reviewed_at: `2026-11-01 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
      round: 12 - index,
      duration_ms: null,
      severity_counts: {},
    }));
    // Newest of all, so the failure is one of the seven rows the cap shows.
    const failure = { stage: "sandbox", error: "exit 1", created_at: "2026-11-02 00:00:00" };
    const { container, win, unmount } = await mountDetailView(
      scene({ reviews: page(corpus), failures: page([failure]) }),
    );
    try {
      const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
      const text = () => container.textContent ?? "";
      const activity = () =>
        [...container.querySelectorAll('[data-slot="activity-entry"], [data-slot="timeline-truncated"]')].map(
          (row) => row.textContent ?? "",
        );
      // Both history families reached the aside without a tab visit.
      expect(text()).toContain(t("en", "pullRequests.timelineReview", { verdict: "ship it" }));
      expect(text()).toContain(t("en", "pullRequests.timelineFailure", { stage: "sandbox" }));
      // 12 reviews plus the failure, of which the cap shows seven: the six
      // dropped events are named, from the PR's totals.
      expect(text()).toContain(t("en", "pullRequests.timelineHidden", { count: 6 }));
      const aside = activity();

      // Paging the reviews list reads an older window; the aside keeps
      // describing the newest one, count included.
      await press(win, tabs()[1]);
      const pagerButton = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
          (button) => button.textContent === label,
        );
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(text()).toContain("model-10");
      expect(activity()).toEqual(aside);
    } finally {
      await unmount();
    }
  });

  test("the severity filter reloads findings from the first page", async () => {
    const corpus: PullRequestFinding[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        finding_id: `m-${index}`,
        severity: "must-fix",
        title: `Must ${index}`,
        file_path: "",
        line: null,
        body: "",
        review_round: null,
      })),
      { finding_id: "n-1", severity: "nit", title: "Nit 1", file_path: "", line: null, body: "", review_round: null },
    ];
    const { container, win, fetches, unmount } = await mountDetailView(scene({ findings: page(corpus) }));
    try {
      const pagerButton = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
          (button) => button.textContent === label,
        );
      // Step off the first page, so the filter's reset is observable.
      expect(container.textContent ?? "").not.toContain("Nit 1");
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(fetches.at(-1)).toContain("offset=10");
      // The second page reaches the last row of the corpus.
      expect(container.textContent ?? "").toContain("Nit 1");

      // Pick the must-fix bucket: the read goes back to offset 0 with the
      // severity on the query, and only its rows render.
      await press(win, container.querySelector('[role="combobox"]'));
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (row) => row.textContent === t("en", "pullRequests.severityMustFix"),
      );
      expect(option).toBeDefined();
      await press(win, option as unknown as Element);
      const last = fetches.at(-1) ?? "";
      expect(last).toContain("offset=0");
      expect(last).toContain("severity=must-fix");
      expect(container.textContent ?? "").not.toContain("Nit 1");
      expect(container.textContent ?? "").toContain("Must 0");
      // The pager totals the filter over the WHOLE family, like the route: 12
      // matched rows sit outside the served window too, so the range names
      // 1–10 of 12 — a corpus-derived total the stub can only answer because
      // this scene's page IS its declared corpus.
      expect(container.querySelector('[data-slot="pager-range"]')?.textContent).toBe(
        t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 12 }),
      );

      // Reset to All: the sentinel maps back to NO `severity` param (the route
      // 400s any spelling outside its vocabulary, `all` included), and the
      // filter's reset must restore the unfiltered page from its first row.
      await press(win, container.querySelector('[role="combobox"]'));
      const allOption = [...win.document.querySelectorAll('[role="option"]')].find(
        (row) => row.textContent === t("en", "pullRequests.filterAll"),
      );
      expect(allOption).toBeDefined();
      await press(win, allOption as unknown as Element);
      const reset = fetches.at(-1) ?? "";
      expect(reset).toContain("offset=0");
      expect(reset).not.toContain("severity=");
      expect(container.textContent ?? "").toContain("Must 0");
      // The pager counts the UNFILTERED total again (13 rows, not the 12 the
      // must-fix bucket reported), so the filter really left the read.
      expect(container.textContent ?? "").toContain(
        t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 13 }),
      );
    } finally {
      await unmount();
    }
  });

  test("the catch-all bucket is selectable and reads the route's unclassified filter", async () => {
    const corpus: PullRequestFinding[] = [
      { finding_id: "m-1", severity: "must-fix", title: "Must 1", file_path: "", line: null, body: "", review_round: null },
      { finding_id: "x-1", severity: "blocker", title: "Blocker 1", file_path: "", line: null, body: "", review_round: null },
      { finding_id: "x-2", severity: "critical", title: "Critical 1", file_path: "", line: null, body: "", review_round: null },
    ];
    const { container, win, fetches, unmount } = await mountDetailView(scene({ findings: page(corpus) }));
    try {
      // Both out-of-vocabulary rows render under the catch-all bucket.
      expect(container.textContent ?? "").toContain("Blocker 1");
      expect(container.textContent ?? "").toContain("Critical 1");

      // The filter offers that bucket, and choosing it narrows to those rows.
      await press(win, container.querySelector('[role="combobox"]'));
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (row) => row.textContent === t("en", "pullRequests.severityOther"),
      );
      expect(option).toBeDefined();
      await press(win, option as unknown as Element);
      const last = fetches.at(-1) ?? "";
      expect(last).toContain("offset=0");
      // The bucket is a filter MODE: it must not be sent as a severity
      // spelling, which the route refuses.
      expect(last).toContain("unclassified=1");
      expect(last).not.toContain("severity=");
      expect(container.textContent ?? "").toContain("Blocker 1");
      expect(container.textContent ?? "").toContain("Critical 1");
      expect(container.textContent ?? "").not.toContain("Must 1");
    } finally {
      await unmount();
    }
  });

  test("two findings sharing a payload id fold independently", async () => {
    // The payload can repeat an id; the rendered rows must not share a fold.
    const duplicated: PullRequestFinding[] = [
      {
        finding_id: "f-1",
        severity: "must-fix",
        title: "First copy",
        file_path: "",
        line: null,
        body: "First body.",
        review_round: null,
      },
      {
        finding_id: "f-1",
        severity: "must-fix",
        title: "Second copy",
        file_path: "",
        line: null,
        body: "Second body.",
        review_round: null,
      },
    ];
    const { container, win, unmount } = await mountDetailView(scene({ findings: page(duplicated) }));
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
    // No finding and no review: the face opens on the failures family, whose
    // one control is the copy action.
    const { container, win, unmount } = await mountDetailView(failuresOnly());
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
      // focused control changes, and no live region repeats that text. (The
      // pager's range region is the page transition's channel, not the copy's.)
      const liveRegionsRepeating = (label: string) =>
        [...container.querySelectorAll('[role="status"], [aria-live]')].filter((node) =>
          (node.textContent ?? "").includes(label),
        );
      const renders = (label: string) => (container.textContent ?? "").split(label).length - 1;
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));

      // Resolved write: the label reports the outcome, once.
      await press(win, copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(renders(t("en", "pullRequests.copyCopied"))).toBe(1);
      expect(liveRegionsRepeating(t("en", "pullRequests.copyCopied"))).toHaveLength(0);

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
      expect(liveRegionsRepeating(t("en", "pullRequests.copyFailed"))).toHaveLength(0);
    } finally {
      jest.useRealTimers();
      await unmount();
    }
  });

  test("a clipboard write that throws synchronously reports the failure", async () => {
    // Some browsers throw from `writeText` rather than returning a rejected
    // promise. A throw must land on the same outcome, not escape the handler.
    const { container, win, unmount } = await mountDetailView(failuresOnly());
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

  test("a failure's remaining output is folded until the reader opens the disclosure", async () => {
    // The first line is the diagnosis the block already prints; the rest is
    // evidence behind a native disclosure. Read the behaviour off the rendered
    // tree: closed → only the summary, opened → the remaining lines, both
    // driven by a press on the summary. The copy action still takes the whole
    // error, diagnosis included.
    const error = "first line\nsecond line\nthird line";
    const { container, win, unmount } = await mountDetailView(
      failuresOnly([{ stage: "sandbox", error, created_at: "2026-10-31 23:00:00" }]),
    );
    try {
      const details = () => container.querySelector<HTMLDetailsElement>('[role="tabpanel"] details');
      const summary = () => details()?.querySelector("summary");
      const output = () => details()?.querySelector("pre")?.textContent ?? "";
      const block = () => container.querySelector('[role="tabpanel"] li[data-tone="danger"]');
      // Closed: the diagnosis stands in the block, the evidence sits behind
      // the disclosure's own summary.
      expect(details()?.open).toBe(false);
      expect(block()?.querySelector("p")?.textContent).toBe("first line");
      expect(summary()?.textContent).toBe(t("en", "pullRequests.failureRemainingOutput"));

      await press(win, summary());
      expect(details()?.open).toBe(true);
      // The disclosure starts where the diagnosis stopped: no duplicated line.
      expect(output()).toBe("second line\nthird line");
      expect(output().startsWith("first line")).toBe(false);

      // The clipboard still receives the WHOLE error, not the visible half.
      const written: string[] = [];
      Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        },
      });
      await press(win, container.querySelector('[data-slot="copy-error"]'));
      expect(written).toEqual([error]);
    } finally {
      await unmount();
    }
  });

  test("under StrictMode's double mount a copy's outcome still renders", async () => {
    // StrictMode runs mount → cleanup → mount; the cleanup-only effect used to
    // leave the mounted flag false, so every outcome was dropped.
    jest.useFakeTimers();
    const { container, win, unmount } = await mountDetailView(failuresOnly(), (view) =>
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
    const { container, win, unmount } = await mountDetailView(
      failuresOnly([
        { stage: "sandbox", error: "first block", created_at: "2026-10-31 23:00:00" },
        { stage: "review", error: "second block", created_at: "2026-10-30 23:00:00" },
      ]),
    );
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
    const { container, win, unmount } = await mountDetailView(failuresOnly());
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => pendingWrite },
    });
    const problems: string[] = [];
    const realConsole = { error: console.error, warn: console.warn, log: console.log };
    const record = (name: string) => (...args: unknown[]) => {
      problems.push(`${name}: ${args.map(String).join(" ")}`);
    };
    console.error = record("error");
    console.warn = record("warn");
    console.log = record("log");
    try {
      const button = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      await press(win, button);
      // The write is still in flight: the idle label is what the reader saw.
      expect(button?.textContent).toBe(t("en", "pullRequests.copyError"));
      // The face goes away while the write is still in flight. The harness
      // already holds one timer of its own, so the count is a baseline, not 0.
      await unmount();
      const timersAfterUnmount = jest.getTimerCount();
      await act(async () => {
        settleWrite();
      });
      await act(async () => {});
      // A late outcome would arm the REST timer against the gone face (one more
      // timer than the baseline). Nothing at all is logged — a filtered claim
      // would let an unrelated warning through.
      expect(jest.getTimerCount()).toBe(timersAfterUnmount);
      expect(problems).toEqual([]);
    } finally {
      jest.useRealTimers();
      console.error = realConsole.error;
      console.warn = realConsole.warn;
      console.log = realConsole.log;
      await unmount();
    }
  });

  test("an App switch in place discards the previous App's record pages", async () => {
    // The shell keeps the open PR address while the route's App changes
    // (`mountTabWithGatedFetch` § switchApp). Both Apps hold the same
    // `owner/repo/number`; only App B's rows belong under App B's head.
    const finding = (id: string, title: string): PullRequestFinding => ({
      finding_id: id,
      severity: "must-fix",
      title,
      file_path: "",
      line: null,
      body: "",
      review_round: null,
    });
    const appA = scene({ findings: page([finding("a-1", "App A finding")]) }, { title: "App A pull request" });
    const appB = scene({ findings: page([finding("b-1", "App B finding")]) }, { title: "App B pull request" });
    const { text, fetches, switchApp, unmount } = await mountTabAcrossApps("acme/web/133", (appId) =>
      appId === "1" ? appA : appB,
    );
    try {
      expect(text()).toContain("App A pull request");
      expect(text()).toContain("App A finding");

      await switchApp("2");

      // App B's head and its own rows replace App A's...
      expect(text()).toContain("App B pull request");
      expect(text()).toContain("App B finding");
      // ...because the switch drops App A's retained page and reads App B's
      // own findings under App B's head; nothing of App A survives it.
      expect(text()).not.toContain("App A finding");
      expect(text()).not.toContain("App A pull request");
      const requested = (suffix: string) => fetches.some((url) => url.endsWith(suffix));
      expect(requested("/api/apps/2/pull-requests/acme/web/133")).toBe(true);
      expect(requested("/api/apps/2/pull-requests/acme/web/133/findings?offset=0&limit=10")).toBe(true);
    } finally {
      await unmount();
    }
  });

  test("without a Clipboard API the copy control stays and reports the failure", async () => {
    // An insecure context offers no Clipboard API at all: the property reads
    // as absent, not as a rejecting write. happy-dom's own Clipboard lives on
    // the prototype, so the absent state is shadowed on the instance.
    const { container, win, unmount } = await mountDetailView(failuresOnly());
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
    try {
      const copyButton = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      // The affordance is not hidden just because the API is missing.
      expect(copyButton).not.toBeNull();
      await press(win, copyButton);
      expect(copyButton?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      // Nothing announces the copy outcome: the button's label is its one channel.
      expect(
        [...container.querySelectorAll('[role="status"], [aria-live]')].filter((node) =>
          (node.textContent ?? "").includes(t("en", "pullRequests.copyFailed")),
        ),
      ).toHaveLength(0);
    } finally {
      await unmount();
    }
  });
});
