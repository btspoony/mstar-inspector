/**
 * The console's data-upgrade screen (spec operator-data-upgrade § Upgrade
 * registry and state machine, task 4).
 *
 * Two faces, one contract:
 * - Static SSR over a fixture list — a `pending` item with preflight counts, a
 *   `running` item and a `failed` item carrying `last_error` — pins the states
 *   an operator has to tell apart, the banner (window + current item +
 *   progress + last error) and the control each state offers.
 * - The mounted page runs the batch loop: `step` repeats until the answer says
 *   `done`, and the list is re-read afterwards so the preflight counts and the
 *   processed total on screen are the server's, not the loop's own guess.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { type Element as DomElement, type Window } from "happy-dom";
import { t } from "../../src/i18n";
import { DataUpgradePage, DataUpgradeView } from "../../src/spa/admin/DataUpgradePage";
import type { DataUpgradeRow, DataUpgradeState } from "../../src/spa/admin/api";
import { formatRelativeTime } from "../../src/spa/relative-time";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

type Sent = { url: string; method: string; body: unknown };
type Respond = (request: Sent) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const state = (over: Partial<DataUpgradeState> = {}): DataUpgradeState => ({
  status: "pending",
  processed: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  ...over,
});

/** Three items: the three states an operator reads differently. */
const UPGRADES: DataUpgradeRow[] = [
  {
    id: "repo-backfill",
    title: "Repository identity backfill",
    impact:
      "Merges duplicate review targets into one per repository and repoints their pull requests, reviews, findings and failures onto it. Never deletes reviews, findings or failures.",
    requiresDowntime: true,
    state: state(),
    preflight: { unidentified_targets: 4, ledger_pairs: 12 },
  },
  {
    id: "quota-reprice",
    title: "Quota reprice",
    impact: "Rewrites the recorded quota for every workspace. Never changes a workspace's plan.",
    requiresDowntime: false,
    state: state({ status: "running", processed: 40, startedAt: "2026-11-16T08:00:00.000Z" }),
    preflight: { rows: 120 },
  },
  {
    id: "finding-index",
    title: "Finding index rebuild",
    impact: "Rebuilds the finding index from stored findings. Never rewrites a stored finding.",
    requiresDowntime: false,
    state: state({
      status: "failed",
      processed: 7,
      startedAt: "2026-11-15T08:00:00.000Z",
      lastError: "verify failed: orphan_rows=2",
    }),
    preflight: { rows: 0 },
  },
];

const RUNTIME = {
  concurrency: 8,
  min: 1,
  max: 64,
  degraded: false,
  maintenance: {
    enabled: true,
    reason: "data upgrade: Repository identity backfill",
    since: "2026-11-16T07:59:00.000Z",
    unreadable: false,
  },
};

const view = (over: Partial<Parameters<typeof DataUpgradeView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(DataUpgradeView, {
      locale: "en",
      data: { upgrades: UPGRADES, maintenance: RUNTIME.maintenance },
      busyId: null,
      runningId: null,
      batches: 0,
      outcome: null,
      failure: null,
      onPreflight: () => {},
      onStep: () => {},
      onStop: () => {},
      onVerify: () => {},
      onReset: () => {},
      ...over,
    }),
  );

/** One item alone: a control the OTHER states offer must not appear here. */
const viewOf = (index: number, over: Partial<Parameters<typeof DataUpgradeView>[0]> = {}) =>
  view({ data: { upgrades: [UPGRADES[index]!], maintenance: RUNTIME.maintenance }, ...over });

describe("data upgrade screen — static faces", () => {
  test("the time column is Last run: the finish stamp, or the claim while it runs", () => {
    // A finished run states its OWN finish, never the claim that started it.
    const done = view({
      data: {
        upgrades: [
          {
            ...UPGRADES[1]!,
            state: state({
              status: "completed",
              processed: 40,
              startedAt: "2026-11-09T08:00:00.000Z",
              finishedAt: "2026-11-16T09:00:00.000Z",
            }),
          },
        ],
        maintenance: RUNTIME.maintenance,
      },
    });
    // Folded, the card's summary carries the same stamp its body column would.
    expect(done).toContain(formatRelativeTime("2026-11-16T09:00:00.000Z", "en"));
    expect(done).not.toContain(formatRelativeTime("2026-11-09T08:00:00.000Z", "en"));
    // The two single-stamp columns are gone: one run time, not a start and a finish.
    expect(done).not.toContain("Started");
    expect(done).not.toContain("Finished");

    // No finish yet: the in-flight claim is the closest thing to a run time.
    const running = viewOf(1);
    expect(running).toContain(t("en", "admin.dataUpgrades.lastRunLabel"));
    expect(running).toContain(formatRelativeTime("2026-11-16T08:00:00.000Z", "en"));
  });

  test("a pending item states its impact, its preflight counts and offers start", () => {
    const markup = viewOf(0);
    expect(markup).toContain(t("en", "admin.nav.dataUpgrades"));
    expect(markup).toContain("Repository identity backfill");
    expect(markup).toContain(t("en", "admin.dataUpgrades.statusPending"));
    // The item's own impact line: what it changes and what it never touches.
    expect(markup).toContain(UPGRADES[0]!.impact);
    // The counts are the item's own names, never renamed by the console.
    expect(markup).toContain("unidentified_targets");
    expect(markup).toContain("ledger_pairs");
    expect(markup).toContain(t("en", "admin.dataUpgrades.startAction"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.preflightAction"));
    // A pending item offers no verify: there is nothing to check yet.
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.verifyAction"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.downtimeBadge"));
  });

  test("a running item states its progress and offers continue, verify and abandon", () => {
    const markup = viewOf(1);
    expect(markup).toContain(t("en", "admin.dataUpgrades.statusRunning"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.progressProcessed", { count: 40 }));
    expect(markup).toContain(t("en", "admin.dataUpgrades.continueAction"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.verifyAction"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.resetAction"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.startAction"));
    // The stop control belongs to a run in flight, not to a stored state.
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.stopAction"));
  });

  test("a failed item shows the stored last_error and offers the named retry with its consequence", () => {
    const markup = viewOf(2);
    expect(markup).toContain(t("en", "admin.dataUpgrades.statusFailed"));
    expect(markup).toContain("verify failed: orphan_rows=2");
    // A failed item takes no new batch: only the retry returns it to pending.
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.continueAction"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.startAction"));
    // The ambiguous `Reset` is gone; the retry says what it does AND what it does not undo.
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.resetAction"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.restartAction"));
    expect(markup).toContain(t("en", "admin.dataUpgrades.restartConsequence"));
    // Both faces say it: the Chinese card states the same consequence.
    const zh = viewOf(2, { locale: "zh_CN" });
    expect(zh).toContain(t("zh_CN", "admin.dataUpgrades.restartAction"));
    expect(zh).toContain("已迁移的行不会回滚");
  });

  test("a completed item is folded to a summary and offers no batch or verify", () => {
    const done = UPGRADES.map((row) => ({
      ...row,
      state: state({ status: "completed" as const, processed: 12, finishedAt: "2026-11-16T09:00:00.000Z" }),
    }));
    const markup = view({ data: { upgrades: done, maintenance: RUNTIME.maintenance } });
    expect(markup).toContain(t("en", "admin.dataUpgrades.statusCompleted"));
    expect(markup).toContain(
      t("en", "admin.dataUpgrades.completedSummary", {
        count: 12,
        time: formatRelativeTime("2026-11-16T09:00:00.000Z", "en"),
      }),
    );
    expect(markup).toContain(t("en", "admin.dataUpgrades.showDetails"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.verifyAction"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.continueAction"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.startAction"));
    // Nothing to reset a finished run to, and no retry for a run that succeeded.
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.resetAction"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.restartAction"));
  });

  test("a completed card starts collapsed: the body is not rendered until asked", () => {
    const markup = view({
      data: {
        upgrades: [
          {
            ...UPGRADES[1]!,
            state: state({ status: "completed", processed: 40, finishedAt: "2026-11-16T09:00:00.000Z" }),
          },
        ],
        maintenance: RUNTIME.maintenance,
      },
    });
    // The header still states what the item did and when — the body does not.
    expect(markup).toContain(
      t("en", "admin.dataUpgrades.completedSummary", {
        count: 40,
        time: formatRelativeTime("2026-11-16T09:00:00.000Z", "en"),
      }),
    );
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.preflightLabel"));
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.processedLabel"));
  });

  test("completed items sort after the open ones, newest run first inside the group", () => {
    const at = (finishedAt: string) =>
      state({ status: "completed" as const, processed: 3, finishedAt });
    const markup = view({
      data: {
        upgrades: [
          { ...UPGRADES[2]!, id: "done-old", state: at("2026-11-10T09:00:00.000Z") },
          UPGRADES[0]!,
          { ...UPGRADES[1]!, id: "done-new", state: at("2026-11-17T09:00:00.000Z") },
          { ...UPGRADES[2]!, id: "done-mid", state: at("2026-11-14T09:00:00.000Z") },
        ],
        maintenance: RUNTIME.maintenance,
      },
    });
    const order = [...markup.matchAll(/data-upgrade="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["repo-backfill", "done-new", "done-mid", "done-old"]);
  });

  test("the downtime badge marks a runnable item, never a finished one", () => {
    // Downtime is a property of a run: an item with nothing left to run has no
    // window to warn the operator about.
    const badge = t("en", "admin.dataUpgrades.downtimeBadge");
    const pending = { ...UPGRADES[0]!, requiresDowntime: true };
    const view1 = (row: DataUpgradeRow) =>
      view({ data: { upgrades: [row], maintenance: RUNTIME.maintenance } });
    expect(view1(pending)).toContain(badge);

    const completed = {
      ...pending,
      state: state({ status: "completed" as const, processed: 5, finishedAt: "2026-11-16T09:00:00.000Z" }),
    };
    expect(view1(completed)).not.toContain(badge);
    // Same for a failed item: it takes no new batch until a restart.
    expect(
      view1({
        ...pending,
        state: state({ status: "failed" as const, processed: 5, lastError: "boom" }),
      }),
    ).not.toContain(badge);
    // And for an empty worklist: the run control is disabled, so no window is
    // needed either.
    expect(view1({ ...pending, preflight: { unidentified_targets: 0 } })).not.toContain(badge);
  });

  test("zero preflight disables the run control and states there is nothing to migrate", () => {
    // The staging face: `已完成` beside every counter at 0 and a live start button.
    const zero: DataUpgradeRow[] = [
      {
        id: "repo-backfill",
        title: "Repository identity backfill",
        impact: "Splits duplicate targets and repoints their ledger rows. Never deletes reviews, findings or failures.",
        requiresDowntime: false,
        state: state({ status: "completed", processed: 0, finishedAt: "2026-11-16T09:00:00.000Z" }),
        preflight: { unidentified_targets: 0, ledger_pairs: 0, conflicting_groups: 0 },
      },
      {
        ...UPGRADES[0]!,
        state: state({ status: "pending" }),
        preflight: { unidentified_targets: 0, ledger_pairs: 0 },
      },
    ];
    const markup = view({ data: { upgrades: zero, maintenance: RUNTIME.maintenance } });
    // An empty worklist states itself and folds: the operator reads the answer
    // without opening a card that has no action to offer. The counts and the
    // (disabled) start control are behind the disclosure.
    expect(markup).toContain(t("en", "admin.dataUpgrades.nothingToMigrate"));
    const showLabel = t("en", "admin.dataUpgrades.showDetails").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(markup).toMatch(new RegExp(`>${showLabel}</button>`));
    // Both dictionaries state it.
    const zh = view({ locale: "zh_CN", data: { upgrades: zero, maintenance: RUNTIME.maintenance } });
    expect(zh).toContain(t("zh_CN", "admin.dataUpgrades.nothingToMigrate"));
    // A counter above zero is work: no empty-worklist copy, and no fold.
    const live = viewOf(0);
    expect(live).not.toContain(t("en", "admin.dataUpgrades.nothingToMigrate"));
    expect(live).not.toContain(t("en", "admin.dataUpgrades.showDetails"));
  });

  test("the banner states the window, the current item, its progress and the last error", () => {
    const markup = view();
    expect(markup).toContain(t("en", "admin.dataUpgrades.maintenanceTitle"));
    expect(markup).toContain(t("en", "admin.runtime.maintenanceStateOn"));
    expect(markup).toContain("data upgrade: Repository identity backfill");
    // The running row is the banner's current item.
    expect(markup).toContain("Quota reprice");
    expect(markup).toContain(t("en", "admin.dataUpgrades.progressProcessed", { count: 40 }));
    expect(markup).toContain("verify failed: orphan_rows=2");
  });

  test("a run in flight renders the batch line and the stop control", () => {
    const markup = view({ runningId: "repo-backfill", busyId: "repo-backfill", batches: 3 });
    expect(markup).toContain(
      t("en", "admin.dataUpgrades.progressRunning", { batch: 3, count: 0 }),
    );
    expect(markup).toContain(t("en", "admin.dataUpgrades.stopAction"));
  });

  test("an older Worker's missing window renders no banner, and the list still renders", () => {
    const markup = view({ data: { upgrades: UPGRADES, maintenance: null } });
    expect(markup).not.toContain(t("en", "admin.dataUpgrades.maintenanceTitle"));
    expect(markup).toContain("Repository identity backfill");
  });
});

type Surface = {
  win: Window;
  container: DomElement;
  sent: Sent[];
  text: () => string;
  click: (node: DomElement | null) => Promise<void>;
  /** Drain the batch loop: each iteration settles one request and its continuation. */
  settle: (times?: number) => Promise<void>;
  close: () => Promise<void>;
};

/** The only button whose label is exactly `label`. */
const button = (container: DomElement, label: string): DomElement | null =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label) ?? null;

async function mount(respond: Respond): Promise<Surface> {
  const { win, cleanup } = installDom("http://localhost/_internal_admin");
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    return respond(request);
  }) as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(DataUpgradePage, { locale: "en" })));
  await act(async () => {});

  return {
    win,
    container,
    sent,
    text: () => container.textContent ?? "",
    async click(node) {
      await act(async () => {
        node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
    },
    async settle(times = 6) {
      for (let index = 0; index < times; index += 1) await act(async () => {});
    },
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

/** The list read and the runtime read share one stub; only POSTs diverge. */
const readStub =
  (upgrades: DataUpgradeRow[] = UPGRADES): Respond =>
  (request) => {
    if (request.method === "GET" && request.url.endsWith("/data-upgrades")) return json({ upgrades });
    if (request.method === "GET" && request.url.endsWith("/runtime")) return json(RUNTIME);
    return json({ error: "unexpected request" }, 404);
  };

/** One item's own card: a control belongs to a row, not to the page. */
const card = (container: DomElement, id: string): DomElement | null =>
  container.querySelector(`[data-upgrade="${id}"]`);

/** The control labelled `label` INSIDE one item's card. */
const control = (container: DomElement, id: string, label: string): DomElement | null =>
  button(card(container, id) ?? container, label);

describe("data upgrade screen — mounted", () => {
  test("an empty worklist keeps its start control disabled behind the disclosure", async () => {
    const zero: DataUpgradeRow[] = [
      {
        ...UPGRADES[0]!,
        state: state({ status: "pending" }),
        preflight: { unidentified_targets: 0, ledger_pairs: 0 },
      },
    ];
    const surface = await mount(readStub(zero));
    // Folded, the card offers no run control at all.
    expect(
      control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.startAction")),
    ).toBeNull();
    await surface.click(
      control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.showDetails")),
    );
    await surface.settle();
    // `disabled` is the only thing keeping a zero-worklist run from opening the
    // maintenance window a downtime item would own; pin it, not just the copy.
    const start = control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.startAction"));
    expect(start).not.toBeNull();
    expect(start!.hasAttribute("disabled")).toBe(true);
    await surface.close();
  });

  test("start runs one batch per request until done, then re-reads the list", async () => {
    let steps = 0;
    const surface = await mount((request) => {
      if (request.method === "POST" && request.url.endsWith("/repo-backfill/step")) {
        steps += 1;
        return json({
          state: state({
            status: "running",
            processed: steps * 20,
            startedAt: "2026-11-16T08:00:00.000Z",
          }),
          batch: { processed: 20, done: steps === 2 },
        });
      }
      return readStub()(request);
    });

    await surface.click(control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.startAction")));
    await surface.settle();

    // One request per batch: the loop stopped on the answer that said `done`.
    expect(steps).toBe(2);
    expect(
      card(surface.container, "repo-backfill")?.textContent,
    ).toContain(t("en", "admin.dataUpgrades.progressDone", { batch: 2, count: 40 }));
    // The list was re-read after the run, so the counts on screen are the server's.
    const listReads = surface.sent.filter(
      (request) => request.method === "GET" && request.url.endsWith("/data-upgrades"),
    );
    expect(listReads).toHaveLength(2);
    await surface.close();
  });

  test("a refused batch keeps the item's state and states the server's reason", async () => {
    const surface = await mount((request) => {
      if (request.method === "POST" && request.url.endsWith("/repo-backfill/step")) {
        return json({ error: "maintenance mode must be on to step this upgrade" }, 409);
      }
      return readStub()(request);
    });

    await surface.click(control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.startAction")));
    await surface.settle();

    const text = surface.text();
    expect(text).toContain(
      t("en", "admin.dataUpgrades.stepFailed", { title: "Repository identity backfill" }),
    );
    expect(text).toContain("maintenance mode must be on to step this upgrade");
    // One refusal ends the loop: the state row did not move, so no retry.
    expect(surface.sent.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(card(surface.container, "repo-backfill")?.textContent).toContain(
      t("en", "admin.dataUpgrades.statusPending"),
    );
    await surface.close();
  });

  test("stop ends the loop after the batch in flight", async () => {
    let steps = 0;
    // Every request is answered at once; only the second is held so the run is
    // parked mid-batch when the operator presses stop.
    let hold: ((response: Response) => void) | null = null;
    const surface = await mount((request) => {
      if (request.method === "POST" && request.url.endsWith("/repo-backfill/step")) {
        steps += 1;
        const answer = json({
          state: state({ status: "running", processed: steps * 20 }),
          // Nothing is ever done: only the stop can end this loop.
          batch: { processed: 20, done: false },
        });
        if (steps === 1) return answer;
        return new Promise<Response>((resolve) => {
          hold = resolve;
        });
      }
      return readStub()(request);
    });

    await surface.click(control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.startAction")));
    await surface.settle(2);
    // Parked on batch 2: the stop control is live while the loop waits.
    expect(steps).toBe(2);
    await surface.click(control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.stopAction")));
    hold!(json({ state: state({ status: "running", processed: 40 }), batch: { processed: 20, done: false } }));
    await surface.settle();

    // The stop landed after the batch in flight, and asked for no third one.
    await surface.settle(8);
    expect(steps).toBe(2);
    expect(card(surface.container, "repo-backfill")?.textContent).toContain(
      t("en", "admin.dataUpgrades.progressStopped", { batch: 2, count: 40 }),
    );
    // The stop control is gone with the loop.
    expect(control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.stopAction"))).toBeNull();
    await surface.close();
  });

  test("verify adopts the state the server stored, failed checks included", async () => {
    const surface = await mount((request) => {
      if (request.method === "POST" && request.url.endsWith("/finding-index/verify")) {
        return json({
          state: state({ status: "failed", processed: 7, lastError: "verify failed: orphan_rows=2" }),
          checks: { orphan_rows: 2 },
        });
      }
      return readStub()(request);
    });

    await surface.click(control(surface.container, "finding-index", t("en", "admin.dataUpgrades.verifyAction")));
    await surface.settle();

    // A non-zero check is the server's `failed` + `last_error`, stated as such.
    expect(card(surface.container, "finding-index")?.textContent).toContain("verify failed: orphan_rows=2");
    expect(
      surface.sent.filter((request) => request.method === "POST" && request.url.endsWith("/verify")),
    ).toHaveLength(1);
    await surface.close();
  });

  test("the failed item's retry returns it to pending and drops its error", async () => {
    const surface = await mount((request) => {
      if (request.method === "POST" && request.url.endsWith("/finding-index/reset")) {
        return json({ state: state() });
      }
      return readStub()(request);
    });

    // The retry is the ONLY control a failed item offers for starting again.
    expect(control(surface.container, "finding-index", t("en", "admin.dataUpgrades.resetAction"))).toBeNull();
    await surface.click(
      control(surface.container, "finding-index", t("en", "admin.dataUpgrades.restartAction")),
    );
    await surface.settle();

    const text = card(surface.container, "finding-index")?.textContent ?? "";
    expect(text).toContain(t("en", "admin.dataUpgrades.statusPending"));
    expect(text).not.toContain("verify failed: orphan_rows=2");
    // Pending again with an empty worklist folds; its counts and the start
    // control live behind the disclosure.
    await surface.click(
      control(surface.container, "finding-index", t("en", "admin.dataUpgrades.showDetails")),
    );
    await surface.settle();
    expect(control(surface.container, "finding-index", t("en", "admin.dataUpgrades.startAction"))).not.toBeNull();
    await surface.close();
  });

  test("preflight adopts the counts the server recomputed", async () => {
    const surface = await mount((request) => {
      if (request.method === "POST" && request.url.endsWith("/repo-backfill/preflight")) {
        return json({ id: "repo-backfill", preflight: { unidentified_targets: 9, ledger_pairs: 30 } });
      }
      return readStub()(request);
    });

    expect(card(surface.container, "repo-backfill")?.textContent).toContain("unidentified_targets 4");
    await surface.click(control(surface.container, "repo-backfill", t("en", "admin.dataUpgrades.preflightAction")));
    await surface.settle();

    const text = card(surface.container, "repo-backfill")?.textContent ?? "";
    expect(text).toContain("unidentified_targets 9");
    expect(text).toContain("ledger_pairs 30");
    await surface.close();
  });

  test("a completed card folds and unfolds its body on the same control", async () => {
    const done: DataUpgradeRow[] = [
      {
        ...UPGRADES[1]!,
        state: state({ status: "completed", processed: 40, finishedAt: "2026-11-16T09:00:00.000Z" }),
      },
    ];
    const surface = await mount(readStub(done));

    // Folded: the summary is there, the body's own columns are not.
    const folded = card(surface.container, "quota-reprice")?.textContent ?? "";
    expect(folded).toContain(
      t("en", "admin.dataUpgrades.completedSummary", {
        count: 40,
        time: formatRelativeTime("2026-11-16T09:00:00.000Z", "en"),
      }),
    );
    expect(folded).not.toContain(t("en", "admin.dataUpgrades.preflightLabel"));

    const toggle = () =>
      control(surface.container, "quota-reprice", t("en", "admin.dataUpgrades.showDetails")) ??
      control(surface.container, "quota-reprice", t("en", "admin.dataUpgrades.hideDetails"));

    expect(toggle()?.textContent).toBe(t("en", "admin.dataUpgrades.showDetails"));
    await surface.click(toggle());
    const opened = card(surface.container, "quota-reprice")?.textContent ?? "";
    expect(opened).toContain(t("en", "admin.dataUpgrades.preflightLabel"));
    expect(toggle()?.textContent).toBe(t("en", "admin.dataUpgrades.hideDetails"));

    await surface.click(toggle());
    expect(card(surface.container, "quota-reprice")?.textContent).not.toContain(
      t("en", "admin.dataUpgrades.preflightLabel"),
    );
    await surface.close();
  });
});
