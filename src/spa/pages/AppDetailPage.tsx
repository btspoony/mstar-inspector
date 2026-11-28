import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import { MetricBand, type Metric } from "@/components/MetricBand";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  FlowSection,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@design-system";
import {
  AppInfoSection,
  AppInstallationsSection,
  AppInstallSection,
  OpsSection,
  SettingsView,
  pendingConfirmCopy,
  postPinnedOutcome,
} from "./SettingsPage";
import { AppDeliveryTab } from "./AppDeliveryTab";
import { fetchJson, patchJson } from "../api";
import type { SpaBoot } from "../boot";
import { spaClick } from "../spa-click";
import { loadUsableBots } from "./AppsPage";
import { apiBase } from "../workspace-base";
import { NoticeRegion, PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import {
  appDetailFace,
  appDetailSearchQuery,
  appDisplayName,
  appStatusPill,
  formatCredits,
  hasTargetFacts,
  parseAppDetailFrom,
  parseAppDetailSearch,
  parseModels,
  parseSettings,
  type AppDetailFrom,
  type AppDetailSearch,
  type AppChainEntry,
  type BlockedReason,
  type ModelOptionGroup,
  type SettingsPayload,
  type TargetSettingsPayload,
} from "./data";
import type { PendingAction } from "./SettingsPage";

/**
 * Page wayfinding link back to the Apps list. The href is the page's own API
 * base, derived here so the rendered link is the real target on both the
 * legacy and the workspace-scoped path.
 */
export function BackToApps({ locale }: { locale: SpaBoot["locale"] }) {
  const href = `${apiBase()}/apps`;
  return (
    <a
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
      href={href}
      onClick={(event) => spaClick(href, event)}
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
      {t(locale, "appDetail.backToApps")}
    </a>
  );
}

/**
 * The shell's own fragment: the page wayfinding link plus the face below it.
 * A separate component (rather than inline JSX in the stateful page) so the
 * rendered shell — link target included — is assertable without a DOM runner.
 */
export function AppDetailShell({
  locale,
  children,
}: {
  locale: SpaBoot["locale"];
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <BackToApps locale={locale} />
      {children}
    </div>
  );
}

/**
 * One App detail read: the settings payload under the page's own base. `base`
 * is a parameter, not `apiBase()` inside, so the caller decides which
 * workspace is being read — and a test can drive the same read under two
 * pathnames.
 */
export async function loadAppDetail(base: string, appId: string): Promise<SettingsPayload | null> {
  return parseSettings(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}`));
}

async function loadModelGroups(base: string, appId: string): Promise<ModelOptionGroup[]> {
  try {
    return (
      parseModels(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}/models`))?.groups ?? []
    );
  } catch {
    return [];
  }
}

/**
 * The App detail page: `/dashboard/apps/:appId` and its workspace twin, with
 * exactly two faces — 应用设置 (the App's own configuration, the default) and
 * 已安装. The data faces (洞察, Pull requests) and the target-owned review
 * policy belong to the repository surface's detail page, so this page neither
 * renders them nor reads their payload sections.
 *
 * A non-manager keeps the D4 identity card it has always been served.
 *
 * Page wayfinding (the back link to the Apps list) is the shell's —
 * rendered as the first element on the error and ok faces.
 *
 * Data plane: the shell owns the settings read (both faces — the
 * identity-only `can_manage: false` shape parses through the D4 identity set;
 * the manager face keeps the full contract) plus the chain editors' model
 * options, and the background-reload machinery (background reloads keep the
 * card tree mounted, failures ride the page notice). The active tab is
 * URL-derived per the spa-url-state-resync contract: one []-mounted popstate
 * listener re-derives through the shared pure helper
 * (`parseAppDetailSearch`), and every in-page edit commits with
 * `replaceState` (`appDetailSearchQuery`) — never popstate, so no loop.
 */
export function AppDetailPage({ boot, appId }: { boot: SpaBoot; appId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const loadSequence = useRef(0);
  // Every bot this workspace may mount. Read ONCE beside the page: the editor's
  // "add" list must exclude what the chain already carries, and the server's
  // ordering (D18) is the order an operator expects.
  const [mountable, setMountable] = useState<Array<{ id: string; name: string; description?: string | null }>>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);
  const [search, setSearch] = useState<AppDetailSearch>(() =>
    parseAppDetailSearch(window.location.search),
  );
  const [from, setFrom] = useState<AppDetailFrom | null>(() =>
    parseAppDetailFrom(window.location.search),
  );

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      const sequence = ++loadSequence.current;
      if (!background) setState("loading");
      try {
        const loaded = await loadAppDetail(base, appId);
        if (cancelledRef.current || sequence !== loadSequence.current) return false;
        if (!loaded) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        setPayload(loaded);
        setState("ok");
        if (loaded.can_manage && !loaded.blocked) {
          if (!background) {
            setGroups([]);
            setModelsLoading(true);
          }
          void loadModelGroups(base, appId).then((modelGroups) => {
            if (cancelledRef.current || sequence !== loadSequence.current) return;
            setGroups(modelGroups);
            setModelsLoading(false);
          });
        } else {
          setGroups([]);
          setModelsLoading(false);
        }
        setNotice(null);
        return true;
      } catch {
        if (!cancelledRef.current && sequence === loadSequence.current) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
        }
        return false;
      }
    },
    [base, appId, locale],
  );

  // F10/D45: an App whose cached GitHub metadata was never synced gets ONE
  // first-load refresh — a POST to `/api/apps/:appId/refresh-metadata`, the
  // only sanctioned refresh. The GET stays a pure read.
  const refreshedRef = useRef(false);

  useEffect(() => {
    let live = true;
    void loadUsableBots(base)
      .then((payload) => {
        // Names only: the editor adds a bot by id and labels it by name. An
        // ARCHIVED bot is never a NEW mount — the relay would not select it —
        // so it stays out of the chooser; a row already in the chain keeps
        // rendering from the chain read.
        if (live) {
          setMountable(
            payload.bots
              .filter((bot) => !bot.archived)
              .map((bot) => ({ id: bot.id, name: bot.name, description: bot.description })),
          );
        }
      })
      .catch(() => {
        // A failed read simply offers no "add" list; the chain stays editable.
        if (live) setMountable([]);
      });
    return () => {
      live = false;
    };
  }, [base]);

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    setSearch(parseAppDetailSearch(window.location.search));
    setFrom(parseAppDetailFrom(window.location.search));
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  useEffect(() => {
    if (refreshedRef.current) return;
    if (payload === null || payload.can_manage !== true || payload.blocked) return;
    // The installed face is a mount, not a creation: no metadata refresh there.
    if (appDetailFace(payload.viewer_relation, from) === "installed") return;
    const meta = payload.app as { github_metadata_synced_at?: string | null };
    if (meta.github_metadata_synced_at !== null && meta.github_metadata_synced_at !== undefined) return;
    if (payload.app.github_app_id === null) return;
    refreshedRef.current = true;
    void refreshAppMetadata(apiBase(), payload.app.github_app_id);
  }, [payload, from]);

  useEffect(() => {
    const onPop = () => {
      setSearch(parseAppDetailSearch(window.location.search));
      setFrom(parseAppDetailFrom(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function commitSearch(next: AppDetailSearch): void {
    const query = appDetailSearchQuery(next);
    // Keep `from`: the shared query builder owns the tab grammar only, and a
    // tab switch must not silently flip the face back to the served relation.
    const suffix = from === null ? query : `${query === "" ? "?" : `${query}&`}from=${from}`;
    window.history.replaceState(null, "", `${window.location.pathname}${suffix}`);
    setSearch(next);
  }

  if (state === "loading") {
    return (
      <AppDetailShell locale={locale}>
        <PageSkeleton locale={locale} kind="forms" />
      </AppDetailShell>
    );
  }

  return (
    <AppDetailShell locale={locale}>
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <AppDetailView
          locale={locale}
          appId={appId}
          payload={payload}
          groups={groups}
          modelsLoading={modelsLoading}
          notice={notice}
          search={search}
          from={from}
          mountable={mountable}
          onReload={load}
          onSearch={commitSearch}
        />
      ) : null}
    </AppDetailShell>
  );
}

/**
 * F10/D45: the single first-load metadata refresh. It is a POST so the GET
 * stays pure; a failure is silent here — the App metadata controls carry the
 * retry affordance.
 */
export async function refreshAppMetadata(base: string, githubAppId: number): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/apps/${githubAppId}/refresh-metadata`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** F11: the chain is the only App→bot relation; its row count is an App fact. */
function mountedBotCount(chain: readonly AppChainEntry[]): number {
  return chain.length;
}

/**
 * The chain editor's write path: order only, because order is all the relay
 * reads. Every move rewrites the WHOLE order in one `PATCH
 * /api/apps/:appId/chain`, whose store clears and re-inserts positions
 * contiguously in one batch. The response carries the re-read chain, so the
 * table the operator sees is the list the next delivery will walk.
 *
 * It is unreachable unless the store also admits this workspace as the
 * installer; `can_manage` gates the UI, the store gates the write.
 *
 * One hook, one control surface: the installed face's in-table row
 * controls + section-header add ({@link InstalledChainSection}).
 */
function useChainOrderEditor(
  locale: SpaBoot["locale"],
  appId: string,
  chain: readonly AppChainEntry[],
  onReordered: () => Promise<unknown>,
) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  /** One PATCH for all three verbs: add, remove and reorder all rewrite the order. */
  async function save(order: readonly string[]): Promise<void> {
    setBusy(true);
    try {
      const { status } = await patchJson(`${apiBase()}/api/apps/${encodeURIComponent(appId)}/chain`, {
        botIds: order,
      });
      if (status < 200 || status >= 300) {
        setNotice({ kind: "error", message: t(locale, "apps.chain.reorderFailed") });
      } else {
        setNotice(null);
        // Re-read the CHAIN, not the page: the editor must never render an order
        // the relay would not walk.
        await onReordered();
      }
    } catch {
      setNotice({ kind: "error", message: t(locale, "apps.chain.reorderFailed") });
    } finally {
      setBusy(false);
    }
  }

  function move(from: number, to: number): void {
    if (to < 0 || to >= chain.length) return;
    const order = chain.map((row) => row.bot_id);
    const [moved] = order.splice(from, 1);
    if (moved === undefined) return;
    order.splice(to, 0, moved);
    void save(order);
  }

  function remove(botId: string): void {
    void save(chain.map((row) => row.bot_id).filter((id) => id !== botId));
  }

  function add(botId: string): void {
    void save([...chain.map((row) => row.bot_id), botId]);
  }

  return { busy, notice, move, remove, add };
}

/**
 * The installed face's chain section — ONE control surface: the row ↑↓✕
 * controls live in the table's actions column and 添加机器人 sits in the
 * section header. A member (`can_edit_chain` false) gets the same rows with the
 * controls ABSENT, not disabled. The creator face carries no chain at all —
 * the chain is what the App mounts, a fact of the install state.
 */
export function InstalledChainSection({
  locale,
  appId,
  chain,
  canEditChain,
  mountableBots,
  rpPerCredit,
  onReordered,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  chain: readonly AppChainEntry[];
  /**
   * The server's own answer to "would the chain write land" — an install row
   * AND the owner/admin role, never `can_manage` alone: a target-only manager
   * has no install row, so the write would 404 `not_installer`.
   */
  canEditChain: boolean;
  /** Bots this workspace may mount, already minus the mounted ones. */
  mountableBots: readonly { id: string; name: string; description?: string | null }[];
  /** The payload's credit rate; absent ⇒ the documented 1,000 RP fallback. */
  rpPerCredit?: number;
  onReordered: () => Promise<unknown>;
}) {
  const { busy, notice, move, remove, add } = useChainOrderEditor(locale, appId, chain, onReordered);
  // One row states only the facts a reader picks a bot by; every other fact —
  // order, origin, description, default chain, runtime, multiplier, cap — lives
  // in that row's own disclosure, so a long chain stays scannable.
  const rowGrid = canEditChain
    ? "grid-cols-[minmax(0,1fr)_9rem_7rem_auto]"
    : "grid-cols-[minmax(0,1fr)_9rem_7rem]";
  return (
    <section
      data-slot="installed-chain"
      className="flex flex-col gap-3 border-b border-(--border-subtle) pt-4 pb-4 first:pt-1 last:border-b-0 last:pb-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3.5 gap-y-1">
        <h2 className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking) font-(weight:--typo-heading-16-weight) text-(--text-primary)">
          {t(locale, "appDetail.installed.chainTitle")}
        </h2>
        {canEditChain && mountableBots.length > 0 ? (
          <details data-slot="app-chain-add">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t(locale, "appDetail.installed.addBot")}
            </summary>
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              {mountableBots.map((bot) => (
                <Button
                  key={bot.id}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={t(locale, "apps.chain.addNamed", { bot: bot.name })}
                  onClick={() => add(bot.id)}
                >
                  + {bot.name}
                  {bot.description ? <span className="text-xs text-muted-foreground">{bot.description}</span> : null}
                  <span className="font-mono text-xs text-muted-foreground">{bot.id}</span>
                </Button>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t(locale, "apps.chain.copy")}</p>
      <NoticeRegion notice={notice} />
      {chain.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{t(locale, "apps.chain.empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-(--border-default)">
          <div
            data-slot="installed-chain-header"
            className={`grid ${rowGrid} items-center gap-3 border-b border-(--border-default) bg-(--surface-raised) px-3 py-2 text-xs text-(--text-muted)`}
          >
            <span>{t(locale, "apps.chain.columnBot")}</span>
            <span>{t(locale, "apps.chain.columnProvider")}</span>
            <span className="text-right">{t(locale, "credits.usedThisMonth")}</span>
            {canEditChain ? <span aria-hidden="true" /> : null}
          </div>
          <ul>
            {chain.map((row, index) => {
              const href = `${apiBase()}/bots/${encodeURIComponent(row.bot_id)}`;
              const multiplier = row.owned || !row.available ? 1 : row.multiplier;
              // The cap the relay enforces for THIS workspace: its override, else
              // the bot's default. It rides the disclosure, not the summary row.
              const ceiling =
                row.owned || !row.available
                  ? t(locale, "credits.unboundedOwn")
                  : row.effective_monthly_rp === null
                    ? t(locale, "credits.unbounded")
                    : formatCredits(row.effective_monthly_rp, rpPerCredit);
              return (
                <li key={`${row.position}:${row.bot_id}`} className="border-b border-(--border-subtle) last:border-b-0">
                  <details className="group">
                    <summary
                      className={`grid ${rowGrid} cursor-pointer list-none items-center gap-3 px-3 py-2 hover:bg-(--surface-overlay) [&::-webkit-details-marker]:hidden`}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                        />
                        <a
                          className="font-semibold text-foreground no-underline hover:underline"
                          href={href}
                          onClick={(event) => spaClick(href, event)}
                        >
                          {row.name}
                        </a>
                        {/* An archived bot stays mounted and listed; the relay never
                            selects it, so the row says so instead of offering a bot
                            that will not run. */}
                        {row.archived ? (
                          <span className="text-(--tone-warn-fg)">{t(locale, "appDetail.installed.archivedSkipped")}</span>
                        ) : row.available ? null : (
                          <span className="text-(--tone-warn-fg)">{t(locale, "apps.chain.rowUnavailable")}</span>
                        )}
                      </span>
                      <span className="truncate text-muted-foreground">{row.provider_workspace}</span>
                      <span className="text-right tabular-nums">{formatCredits(row.month_used_rp, rpPerCredit)}</span>
                      {canEditChain ? (
                        // A summary toggles on any click inside it: cancel the
                        // default here so an order control never expands the row.
                        <span className="flex items-center gap-1" onClick={(event) => event.preventDefault()}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || index === 0}
                            aria-label={t(locale, "apps.chain.moveUp", { bot: row.name })}
                            onClick={() => move(index, index - 1)}
                          >
                            ↑
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || index === chain.length - 1}
                            aria-label={t(locale, "apps.chain.moveDown", { bot: row.name })}
                            onClick={() => move(index, index + 1)}
                          >
                            ↓
                          </Button>
                          {/* D27: the LAST bot's row stays visible and cannot be
                              removed — the UI never offers an empty chain, though
                              the store would refuse one. */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || chain.length === 1}
                            aria-label={t(locale, "apps.chain.removeBot", { bot: row.name })}
                            onClick={() => remove(row.bot_id)}
                          >
                            ✕
                          </Button>
                        </span>
                      ) : null}
                    </summary>
                    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 pb-3 pl-9 text-sm">
                      <dt className="text-muted-foreground">{t(locale, "apps.chain.columnPosition")}</dt>
                      <dd className="tabular-nums">{row.position}</dd>
                      <dt className="text-muted-foreground">{t(locale, "apps.chain.detailBotId")}</dt>
                      <dd className="break-all font-mono text-muted-foreground">{row.bot_id}</dd>
                      {row.description === null || row.description === "" ? null : (
                        <>
                          <dt className="text-muted-foreground">{t(locale, "apps.chain.detailDescription")}</dt>
                          <dd>{row.description}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">{t(locale, "apps.chain.detailOrigin")}</dt>
                      <dd>{t(locale, row.owned ? "apps.chain.tagMine" : "apps.chain.tagShared")}</dd>
                      <dt className="text-muted-foreground">{t(locale, "settings.defaultChain")}</dt>
                      <dd className="font-mono text-muted-foreground">{row.default_chain ?? "—"}</dd>
                      <dt className="text-muted-foreground">{t(locale, "settings.runtimeHarness")}</dt>
                      <dd className="font-mono text-muted-foreground">{row.runtime ?? "—"}</dd>
                      <dt className="text-muted-foreground">{t(locale, "apps.chain.columnMultiplier")}</dt>
                      <dd className="tabular-nums">×{multiplier}</dd>
                      <dt className="text-muted-foreground">{t(locale, "apps.chain.detailCeiling")}</dt>
                      <dd className="tabular-nums">{ceiling}</dd>
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * The installed face: an App opened from 已安装的应用 is a mount, not a
 * creation. Read-only identity header (name, creator, GitHub App ID — each
 * once), the mount metric band, the install/bind block and the workspace's
 * chain with ONE control surface. No credentials, no share, no delete, no
 * metadata refresh, no delivery, no tab bar. A member gets the same rows with
 * every control absent.
 */
export function InstalledAppFace({
  locale,
  appId,
  payload,
  notice,
  mountable = [],
  onReload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  payload: SettingsPayload;
  notice: { kind: NoticeKind; message: string } | null;
  /** Bots this workspace may mount, unfiltered — the face subtracts the chain. */
  mountable?: Array<{ id: string; name: string; description?: string | null }>;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const pill = appStatusPill(locale, payload.app);
  const chain = payload.chain ?? [];
  // The band sums EVERY mounted row's recorded month spend: archiving stops
  // future selection, it does not erase Credits already used this month. The
  // archived row stays listed (marked unavailable) and still counts here.
  const monthSpendRp = chain.reduce((sum, row) => sum + row.month_used_rp, 0);
  // The band states the number only. Ceiling state and budget live on the
  // chain rows' own disclosures below; NO chain is nothing metered, not zero.
  const monthValue =
    chain.length === 0
      ? t(locale, "bots.monthNone")
      : formatCredits(monthSpendRp, payload.rp_per_credit);
  const metrics: Metric[] = [
    { key: t(locale, "appDetail.installed.metricMounted"), value: chain.length },
    { key: t(locale, "appDetail.installed.metricInstallations"), value: (payload.installations ?? []).length },
    {
      key: t(locale, "appDetail.installed.metricSpend"),
      value: monthValue,
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={appDisplayName(payload.app)}
        description={
          <>
            {t(locale, "apps.by", { login: payload.app.created_by ?? "—" })}
            {payload.app.github_app_id === null ? null : (
              <>
                {" · "}
                {t(locale, "appDetail.credentialsAppId")}{" "}
                <span className="font-mono tabular-nums">{payload.app.github_app_id}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>
            <StatusBadge tone="accent">{t(locale, "apps.origin.installed")}</StatusBadge>
          </>
        }
        metrics={<MetricBand metrics={metrics} />}
      />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {/* A Blocked App still reads as a mount: the operator must be told why this
          chain reviews nothing, and still sees the install state they hold —
          never the creator face's tabs or blocks (ADR § Two origins, two faces). */}
      {payload.blocked && payload.blocked_reason ? (
        <PageNotice kind="warn" message={t(locale, BLOCKED_REASON_KEYS[payload.blocked_reason])} />
      ) : null}
      {/* The install/bind block reuses the settings sections: a manager gets the
          bound row plus every pending installation with its bind action; the
          read-only payload serves no pending rows, so a member gets the roster.
          The header above already stated the App, so the block carries the bind
          state only (ADR § App identity is stated once). A blocked App has no
          bind action to offer, so the block is absent rather than empty. */}
      {payload.can_manage && !payload.blocked ? (
        <AppInstallSection
          locale={locale}
          appId={appId}
          app={payload.app}
          installation={payload.installation}
          pendingInstallations={payload.pending_installations ?? []}
          blocked={payload.blocked}
          showIdentity={false}
          onReload={onReload}
        />
      ) : null}
      <AppInstallationsSection locale={locale} installations={payload.installations ?? []} />
      {/* F4/D47: the copy follows the REAL bind state — an empty chain with
          pending installations means "the chain appears once bound". */}
      {chain.length === 0 && (payload.pending_installations ?? []).length > 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{t(locale, "apps.chain.pendingBind")}</p>
      ) : (
        <InstalledChainSection
          locale={locale}
          appId={appId}
          chain={chain}
          canEditChain={payload.can_edit_chain}
          mountableBots={mountable.filter((bot) => !chain.some((row) => row.bot_id === bot.id))}
          rpPerCredit={payload.rp_per_credit}
          onReordered={onReload}
        />
      )}
    </div>
  );
}

const BLOCKED_REASON_KEYS = {
  bot_not_shared: "appDetail.blockedBotNotShared",
} as const satisfies Record<BlockedReason, string>;

/**
 * The identity header both detail pages render: the GitHub display name (D6
 * fallback chain), the creator, the status pill and the four figures the
 * manager payload proves. The route `appId` stays the address, never the
 * visible identity.
 */
export function TargetHeader({
  locale,
  appId,
  payload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  payload: SettingsPayload;
}) {
  const pill = appStatusPill(locale, payload.app);
  const blockedMessage =
    payload.blocked && payload.blocked_reason
      ? t(locale, BLOCKED_REASON_KEYS[payload.blocked_reason])
      : null;

  // F11: App-scoped facts ONLY. `keys.length` and `model_chains.length` were
  // BOT configuration reached through an equal id — a different entity after
  // the split — so the band carries installations and Apps mounted through
  // the chain, nothing else. The 24h refusal count is the delivery tab's own
  // figure; it never rides this band.
  const chain = payload.chain ?? [];
  const metrics: Metric[] = payload.can_manage && !payload.blocked
    ? [
        { key: t(locale, "settings.installations"), value: payload.installations.length },
        { key: t(locale, "appDetail.metricMountedBots"), value: mountedBotCount(chain) },
      ]
    : [];

  return (
    <>
      <PageHeader
        title={appDisplayName(payload.app)}
        description={t(locale, "apps.by", { login: payload.app.created_by ?? "—" })}
        actions={<StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>}
        metrics={<MetricBand metrics={metrics} />}
      />
      {blockedMessage ? <PageNotice kind="warn" message={blockedMessage} /> : null}
    </>
  );
}

function TargetOpsZone({
  locale,
  payload,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: TargetSettingsPayload;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const appPath = `${apiBase()}/apps/${payload.app.github_app_id}`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      setNotice(
        action.kind === "delete"
          ? await postPinnedOutcome(`${appPath}/delete`, {}, locale, () => onReload({ background: true }), {
              successMessage: t(locale, "settings.deleteSuccess"),
              refetch: false,
            })
          : await postPinnedOutcome(`${appPath}/${action.kind}`, {}, locale, () =>
              onReload({ background: true }),
            ),
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, appDisplayName(payload.app), pending);

  return (
    <>
      <OpsSection
        locale={locale}
        payload={payload}
        onPending={setPending}
        notice={notice}
        botWritable={!payload.blocked && payload.can_configure_bot === true}
        targetOwned={false}
      />
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent>
          {pending && confirmCopy ? (
            <>
              <DialogHeader>
                <DialogTitle>{confirmCopy.title}</DialogTitle>
                <DialogDescription>{confirmCopy.body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={busy}>
                    {t(locale, "common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  variant={confirmCopy.destructive ? "destructive" : "default"}
                  disabled={busy}
                  onClick={() => void onConfirm()}
                >
                  {confirmCopy.action}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The App detail face — pure `t()` + data rendering, no window/router access,
 * so tests can static-render it. A valid `from` param wins over the served
 * `viewer_relation`; the installed face (a mount: read-only identity, metric
 * band, install/bind, one chain control surface, no tab bar) renders for every
 * role, with controls absent for members. Otherwise a non-manager gets the D4
 * identity card and a manager gets the creator face: 应用设置 (the merged
 * GitHub App + credentials section, the ops block, the share switch),
 * 投递状态 and 已安装 — no bots tab, no repository block, no 24h figure.
 */
export function AppDetailView({
  locale,
  appId,
  payload,
  groups,
  modelsLoading = false,
  notice,
  search,
  from = null,
  mountable = [],
  onReload,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  payload: SettingsPayload;
  groups: ModelOptionGroup[];
  modelsLoading?: boolean;
  notice: { kind: NoticeKind; message: string } | null;
  search: AppDetailSearch;
  /** The wayfinding param the page parsed off the URL; null when absent/invalid. */
  from?: AppDetailFrom | null;
  /** Bots this workspace may mount, unfiltered — the view subtracts the chain. */
  mountable?: Array<{ id: string; name: string; description?: string | null }>;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onSearch: (next: AppDetailSearch) => void;
}) {
  // The face follows the ORIGIN, blocked or not: a Blocked App is still a mount,
  // so it renders the installed face (read-only identity, the blocked warning,
  // the install state) with no creator tabs.
  if (appDetailFace(payload.viewer_relation, from) === "installed") {
    return (
      <InstalledAppFace
        locale={locale}
        appId={appId}
        payload={payload}
        notice={notice}
        mountable={mountable}
        onReload={onReload}
      />
    );
  }

  if (!payload.can_manage) {
    return (
      <div className="flex flex-col gap-6">
        <TargetHeader locale={locale} appId={appId} payload={payload} />
        {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
        <SettingsView locale={locale} payload={payload} />
      </div>
    );
  }

  // The ops block (enable/disable/delete) is an APP fact: every unblocked
  // manager face renders it, target or no target. A Blocked face still gates
  // on target facts — the several-repository Blocked shape names no App
  // operations target.
  const opsPayload = payload.blocked ? (hasTargetFacts(payload) ? payload : null) : payload;
  const bot = payload.blocked ? null : payload;

  function onTabChange(next: string): void {
    if (next !== "settings" && next !== "delivery" && next !== "installations") return;
    onSearch({ ...search, tab: next });
  }

  return (
    <div className="flex flex-col gap-6">
      <TargetHeader locale={locale} appId={appId} payload={payload} />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <Tabs value={search.tab} onValueChange={onTabChange}>
        <TabsList
          variant="line"
          className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger value="settings">{t(locale, "appDetail.tabSettings")}</TabsTrigger>
          <TabsTrigger value="delivery">{t(locale, "appDetail.tabDelivery")}</TabsTrigger>
          <TabsTrigger value="installations">{t(locale, "appDetail.tabInstallations")}</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" forceMount>
          <div className="flex flex-col">
            {/* The App's own identity AND credential state are ONE GitHub App
                section: the stored-credentials line folds into AppInfoSection
                as a sub-row, never a separate block. A Blocked App (its bot is
                no longer shared) renders neither: the payload carries no
                App-side facts for it. */}
            {payload.blocked ? null : (
              <AppInfoSection
                locale={locale}
                app={payload.app}
                workspaceId={payload.workspace_id}
                canManage={true}
                onReload={onReload}
                credentialsSlot={
                  <p className="text-xs text-muted-foreground">
                    {t(locale, "appDetail.credentialsStored")}: {t(locale, "appDetail.credentialsStoredValue")}
                  </p>
                }
              />
            )}
            {opsPayload === null ? null : (
              // OpsSection reads only App facts (status, github_app_id); the
              // target-owned review rows stay hidden (targetOwned=false), so
              // the target-less manager face renders the same ops block.
              <TargetOpsZone locale={locale} payload={opsPayload as TargetSettingsPayload} onReload={onReload} />
            )}
            {/* Sharing is an App property only the OFFICIAL workspace may flip;
                any other workspace gets the state as a read-only line. */}
            {bot === null || bot.can_manage !== true ? null : bot.official_workspace === true ? (
              <AppShareSection locale={locale} appId={appId} app={payload.app} onReload={onReload} />
            ) : (
              <p className="py-3 text-sm text-muted-foreground" data-slot="app-share-readonly">
                {t(locale, bot.app.scope === "shared" ? "apps.shareAppOn" : "apps.shareAppOff")}
              </p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="delivery">
          <div className="flex flex-col">
            {bot === null ? (
              <p className="py-3 text-sm text-muted-foreground">{t(locale, "appDetail.delivery.unavailable")}</p>
            ) : (
              <AppDeliveryTab
                locale={locale}
                appId={appId}
                summary={{
                  last_webhook_at: bot.app.last_webhook_at,
                }}
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="installations" forceMount>
          <div className="flex flex-col">
            <AppInstallSection
              locale={locale}
              appId={appId}
              app={payload.app}
              installation={payload.installation}
              pendingInstallations={payload.blocked ? [] : payload.pending_installations}
              blocked={payload.blocked}
              /* The page header already stated the App's identity — the block
                 carries the bind state only (ADR: identity once). */
              showIdentity={false}
              onReload={onReload}
            />
            {bot === null ? null : (
              <AppInstallationsSection locale={locale} installations={bot.installations} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * "Share this app" (Task 5's second block): the one App-owned mutating
 * control the detail keeps, PATCHing `/api/apps/:appId/scope` behind the
 * same confirm-then-write shape the bot's share switch uses. Sharing is an
 * App property — a shared App is installable by any workspace — never a bot
 * property, so the control lives here and nowhere on the bot page.
 */
export function AppShareSection({
  locale,
  appId,
  app,
  onReload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  app: { scope: "owned" | "shared" };
  onReload: (options?: { background?: boolean }) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function submitScope(scope: "owned" | "shared"): Promise<void> {
    setBusy(true);
    try {
      const { status } = await patchJson(
        `${apiBase()}/api/apps/${encodeURIComponent(appId)}/scope`,
        { scope, ...(scope === "owned" ? { confirm: true } : {}) },
      );
      if (status < 200 || status >= 300) {
        setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
      } else {
        await onReload({ background: true });
        setNotice({
          kind: "success",
          message: t(locale, scope === "shared" ? "apps.shareAppSaved" : "apps.unshareAppSaved"),
        });
      }
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
      setPending(false);
    }
  }

  const sharing = app.scope === "shared";
  return (
    <div className="flex flex-col gap-2 py-3" data-slot="app-share">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge tone={sharing ? "accent" : "neutral"}>
            {t(locale, sharing ? "apps.shareAppStateOn" : "apps.shareAppStateOff")}
          </StatusBadge>
          <span className="text-sm text-muted-foreground">
            {t(locale, sharing ? "apps.shareAppOnBody" : "apps.shareAppOffBody")}
          </span>
        </div>
        <Button
          type="button"
          variant={sharing ? "destructive-outline" : "secondary"}
          onClick={() => setPending(true)}
        >
          {t(locale, sharing ? "apps.shareAppStop" : "apps.shareAppSwitch")}
        </Button>
      </div>
      <NoticeRegion notice={notice} />
      {pending ? (
        <Dialog open onOpenChange={(open) => { if (!open) setPending(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(locale, sharing ? "apps.shareAppStop" : "apps.shareAppSwitch")}</DialogTitle>
              <DialogDescription>
                {t(locale, sharing ? "apps.shareAppConfirmOff" : "apps.shareAppConfirm")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t(locale, "common.cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant={sharing ? "destructive" : "default"}
                disabled={busy}
                onClick={() => void submitScope(sharing ? "owned" : "shared")}
              >
                {t(locale, sharing ? "apps.shareAppStop" : "apps.shareAppSwitch")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
