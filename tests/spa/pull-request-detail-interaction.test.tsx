import { describe, expect, jest, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { t } from "../../src/i18n";
import { FAILURE_SUMMARIES } from "../../src/contracts/failure-codes";
import type { PullRequestFailure, PullRequestFinding } from "../../src/spa/pages/data";
import { currentDetailRead, type DetailRead } from "../../src/spa/pages/PullRequestDetail";
import {
  DETAIL,
  FAILURES,
  detailFetch,
  jsonResponse,
  mountDetailView,
  mountTabAcrossTargets,
  page,
  press,
  scene,
} from "./pull-request-fixtures";

/** A row recorded before 0106: no code, no track id, rendered exactly as before. */
const historical = (row: Pick<PullRequestFailure, "stage" | "error" | "created_at">): PullRequestFailure => ({
  ...row,
  message: null,
  error_code: null,
  track_id: null,
});

const failuresOnly = (failures: PullRequestFailure[] = FAILURES) =>
  scene({ findings: page([]), reviews: page([]), failures: page(failures) });

describe("pull requests detail read derivation (pure)", () => {
  test("a read stamped for another pr derives to not-yet-loaded, whatever its kind", () => {
    const okA: DetailRead = { pr: "acme/web/1", kind: "ok", data: DETAIL };
    const errorA: DetailRead = { pr: "acme/web/1", kind: "error" };
    const loadingA: DetailRead = { pr: "acme/web/1", kind: "loading" };
    expect(currentDetailRead(okA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(errorA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(loadingA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(okA, "acme/web/1")).toEqual(okA);
    expect(currentDetailRead(errorA, "acme/web/1")).toEqual(errorA);
    expect(currentDetailRead(null, "acme/web/1")).toBeNull();
  });
});

describe("detail fetch stub (pure)", () => {
  test("an unhandled read fails the caller and names the URL", async () => {
    const stub = detailFetch(() => scene());
    await expect(stub.fetch("/dashboard/api/targets/1/pull-requests")).rejects.toThrow(
      "detailFetch: unhandled URL /dashboard/api/targets/1/pull-requests",
    );
  });
});

describe("pull request detail (mounted)", () => {
  test("each family trigger answers to its announced name, separator included", async () => {
    const { container, win, unmount } = await mountDetailView(scene());
    try {
      const byRoleName = (name: string) =>
        [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
          (tab) => (tab.getAttribute("aria-label") ?? tab.textContent) === name,
        );
      expect(byRoleName(t("en", "pullRequests.findings"))).toBeUndefined();
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
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

      await press(win, tabs()[1]);
      expect(selected()).toEqual([false, true, false]);
      expect(visible()).toEqual([false, true, false]);

      await press(win, tabs()[0]);
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

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
      expect(text()).toContain("Use a parameterized query");
      const afterLanding = fetches.length;

      await press(win, tabs()[1]);
      expect(text()).toContain(t("en", "pullRequests.reviewRound", { round: 2 }));

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
      expect(text()).toContain("Finding 00");
      expect(text()).not.toContain("Finding 10");
      expect(container.querySelector('[data-slot="pager-range"]')?.textContent).toBe(
        t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 25 }),
      );
      expect(pagerButton(t("en", "pullRequests.pagePrev"))?.disabled).toBe(true);

      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
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

      expect(rangeText()).toBe(renderedRange());
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(false);

      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(pending.map((gate) => gate.offset)).toEqual(["offset=10"]);
      expect(rangeText()).toBe(renderedRange());
      expect(rangeText()).toBe(t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 25 }));
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(true);
      expect(pagerButton(t("en", "pullRequests.pagePrev"))?.disabled).toBe(true);
      expect(severityControl()?.disabled).toBe(true);

      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(findingsReads()).toHaveLength(2);

      await act(async () => settle("offset=10"));
      expect(rangeText()).toBe(renderedRange());
      expect(rangeText()).toBe(t("en", "pullRequests.pageRange", { from: 11, to: 20, total: 25 }));
      expect(severityControl()?.disabled).toBe(false);
      expect(pagerButton(t("en", "pullRequests.pagePrev"))?.disabled).toBe(false);

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
    const corpus = Array.from({ length: 12 }, (_, index) => ({
      verdict: index === 0 ? "ship it" : "blocked",
      model: `model-${String(index).padStart(2, "0")}`,
      provider: "openrouter",
      reviewed_at: `2026-11-01 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
      round: 12 - index,
      duration_ms: null,
      severity_counts: {},
    }));
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
      expect(read().verdict).toBe("ship it");
      expect(read().meta).toContain("model-00");

      await press(win, container.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
      const activity = () =>
        [...container.querySelectorAll('[data-slot="activity-entry"]')].map((row) => row.textContent ?? "");
      const aside = activity();
      expect(aside.length).toBeGreaterThan(0);
      const pagerButton = (label: string) =>
        [...container.querySelectorAll<HTMLButtonElement>('[data-slot="pager"] button')].find(
          (button) => button.textContent === label,
        );
      expect(pagerButton(t("en", "pullRequests.pageNext"))?.disabled).toBe(false);
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));

      expect(
        [...container.querySelectorAll('[data-slot="review-round"]')].map((chip) => chip.textContent),
      ).toEqual([
        t("en", "pullRequests.reviewRound", { round: 2 }),
        t("en", "pullRequests.reviewRound", { round: 1 }),
      ]);
      expect(read()).toEqual({ verdict: "ship it", meta: expect.stringContaining("model-00") });
      expect(read().meta).not.toContain("model-10");
      expect(activity()).toEqual(aside);
    } finally {
      await unmount();
    }
  });

  test("the aside names the newest reviews and failures while the PR opens on findings", async () => {
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
    const failure = historical({ stage: "sandbox", error: "exit 1", created_at: "2026-11-02 00:00:00" });
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
      expect(text()).toContain(t("en", "pullRequests.timelineReview", { verdict: "ship it" }));
      expect(text()).toContain(t("en", "pullRequests.timelineFailure", { stage: "sandbox" }));
      expect(text()).toContain(t("en", "pullRequests.timelineHidden", { count: 6 }));
      const aside = activity();

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
      expect(container.textContent ?? "").not.toContain("Nit 1");
      await press(win, pagerButton(t("en", "pullRequests.pageNext")));
      expect(fetches.at(-1)).toContain("offset=10");
      expect(container.textContent ?? "").toContain("Nit 1");

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
      expect(container.querySelector('[data-slot="pager-range"]')?.textContent).toBe(
        t("en", "pullRequests.pageRange", { from: 1, to: 10, total: 12 }),
      );

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
      expect(container.textContent ?? "").toContain("Blocker 1");
      expect(container.textContent ?? "").toContain("Critical 1");

      await press(win, container.querySelector('[role="combobox"]'));
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (row) => row.textContent === t("en", "pullRequests.severityOther"),
      );
      expect(option).toBeDefined();
      await press(win, option as unknown as Element);
      const last = fetches.at(-1) ?? "";
      expect(last).toContain("offset=0");
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
      expect(controls().map((control) => control.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
      expect(new Set(controls().map((control) => control.getAttribute("aria-controls"))).size).toBe(2);
      await press(win, controls()[1]);
      expect(controls().map((control) => control.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
      expect(bodyOf(controls()[0])?.hidden).toBe(false);
      expect(bodyOf(controls()[1])?.hidden).toBe(true);
    } finally {
      await unmount();
    }
  });

  test("the copy action reports its outcome on the button and reverts", async () => {
    let writes = 0;
    jest.useFakeTimers();
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
      const liveRegionsRepeating = (label: string) =>
        [...container.querySelectorAll('[role="status"], [aria-live]')].filter((node) =>
          (node.textContent ?? "").includes(label),
        );
      const renders = (label: string) => (container.textContent ?? "").split(label).length - 1;
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));

      await press(win, copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(renders(t("en", "pullRequests.copyCopied"))).toBe(1);
      expect(liveRegionsRepeating(t("en", "pullRequests.copyCopied"))).toHaveLength(0);

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));
      expect(renders(t("en", "pullRequests.copyCopied"))).toBe(0);

      await press(win, copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(renders(t("en", "pullRequests.copyFailed"))).toBe(1);
      expect(liveRegionsRepeating(t("en", "pullRequests.copyFailed"))).toHaveLength(0);
    } finally {
      jest.useRealTimers();
      await unmount();
    }
  });

  test("copying a classified failure writes code, full track id and the full error", async () => {
    const classified = {
      stage: "runner" as const,
      error: `mechanism detail`,
      message: FAILURE_SUMMARIES["review.budget.runner_spent"],
      error_code: "review.budget.runner_spent",
      track_id: "9f2c1d4e-aaaa-bbbb-cccc-000000000001",
      created_at: "2026-11-02 00:00:00",
    };
    const { container, win, unmount } = await mountDetailView(failuresOnly([classified]));
    try {
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
      expect(written).toEqual([
        `review.budget.runner_spent\n${classified.track_id}\n${classified.error}`,
      ]);
    } finally {
      await unmount();
    }
  });

  test("a clipboard write that throws synchronously reports the failure", async () => {
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
      expect(button?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(problems).toEqual([]);
    } finally {
      console.error = realError;
      await unmount();
    }
  });

  test("a failure's remaining output is folded until the reader opens the disclosure", async () => {
    const error = "first line\nsecond line\nthird line";
    const { container, win, unmount } = await mountDetailView(
      failuresOnly([historical({ stage: "sandbox", error, created_at: "2026-10-31 23:00:00" })]),
    );
    try {
      const details = () => container.querySelector<HTMLDetailsElement>('[role="tabpanel"] details');
      const summary = () => details()?.querySelector("summary");
      const output = () => details()?.querySelector("pre")?.textContent ?? "";
      const block = () => container.querySelector('[role="tabpanel"] li[data-tone="danger"]');
      expect(details()?.open).toBe(false);
      expect(block()?.querySelector("p")?.textContent).toBe("first line");
      expect(summary()?.textContent).toBe(t("en", "pullRequests.failureRemainingOutput"));

      await press(win, summary());
      expect(details()?.open).toBe(true);
      expect(output()).toBe("second line\nthird line");
      expect(output().startsWith("first line")).toBe(false);

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
        historical({ stage: "sandbox", error: "first block", created_at: "2026-10-31 23:00:00" }),
        historical({ stage: "review", error: "second block", created_at: "2026-10-30 23:00:00" }),
      ]),
    );
    try {
      Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
      const copyButtons = () => [...container.querySelectorAll<HTMLElement>('[data-slot="copy-error"]')];
      expect(copyButtons()).toHaveLength(2);

      await press(win, copyButtons()[0]);
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await press(win, copyButtons()[1]);
      expect(copyButtons()[0]?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyCopied"));

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
      expect(button?.textContent).toBe(t("en", "pullRequests.copyError"));
      await unmount();
      const timersAfterUnmount = jest.getTimerCount();
      await act(async () => {
        settleWrite();
      });
      await act(async () => {});
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

  test("a target switch in place discards the previous target's record pages", async () => {
    const finding = (id: string, title: string): PullRequestFinding => ({
      finding_id: id,
      severity: "must-fix",
      title,
      file_path: "",
      line: null,
      body: "",
      review_round: null,
    });
    const targetA = scene({ findings: page([finding("a-1", "App A finding")]) }, { title: "App A pull request" });
    const targetB = scene({ findings: page([finding("b-1", "App B finding")]) }, { title: "App B pull request" });
    const { text, fetches, switchTarget, unmount } = await mountTabAcrossTargets("acme/web/133", (targetId) =>
      targetId === "1" ? targetA : targetB,
    );
    try {
      expect(text()).toContain("App A pull request");
      expect(text()).toContain("App A finding");

      await switchTarget("2");

      expect(text()).toContain("App B pull request");
      expect(text()).toContain("App B finding");
      expect(text()).not.toContain("App A finding");
      expect(text()).not.toContain("App A pull request");
      const requested = (suffix: string) => fetches.some((url) => url.endsWith(suffix));
      expect(requested("/api/targets/2/pull-requests/acme/web/133")).toBe(true);
      expect(requested("/api/targets/2/pull-requests/acme/web/133/findings?offset=0&limit=10")).toBe(true);
    } finally {
      await unmount();
    }
  });

  test("without a Clipboard API the copy control stays and reports the failure", async () => {
    const { container, win, unmount } = await mountDetailView(failuresOnly());
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
    try {
      const copyButton = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      expect(copyButton).not.toBeNull();
      await press(win, copyButton);
      expect(copyButton?.textContent).toBe(t("en", "pullRequests.copyFailed"));
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
