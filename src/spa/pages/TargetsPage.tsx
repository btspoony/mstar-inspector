import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from "@design-system";
import { MetricBand, type Metric } from "@/components/MetricBand";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { EmptyState } from "../components/state/EmptyState";
import { AppInstallIdentity, appInstallHref } from "../components/AppInstallIdentity";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { fetchJson, ApiError, postJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { spaClick } from "../spa-click";
import { apiBase } from "../workspace-base";
import { AppInsightsTab } from "./AppInsightsTab";
import { AppPullRequestsTab } from "./AppPullRequestsTab";
import { PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
import {
  TargetSettingsTab,
  parseTargetPolicyPayload,
  type TargetPolicyPayload,
} from "./TargetSettingsTab";
import {
  parseAppInstallations,
  parseInstallationRepositories,
  parseTargetCreate,
  parseTargetDetailTab,
  parseTargets,
  targetDetailTabQuery,
  type AppDetailSearch,
  type InstallationRepository,
  type InstallationRepositoryOption,
  type PendingInstallation,
  type ReadScope,
  type RepositoryAppOption,
  type TargetDetailTab,
  type TargetListRow,
} from "./data";
import {
  parseWorkspaceDefaults,
  WorkspaceDefaultsTab,
  type WorkspaceDefaultsPayload,
} from "./WorkspaceDefaultsTab";

/**
 * The page wayfinding link back to the list, derived from the page's own API
 * base so the rendered href is the real target under any workspace ref. ONE
 * spelling for the detail's faces: the loaded face carries it in `PageHeader`'s
 * back-link slot, the loading and not-found faces in {@link TargetDetailShell}.
 */
export function TargetDetailBackLink({ locale }: { locale: SpaBoot["locale"] }) {
  const href = `${apiBase()}/repos`;
  return (
    <a
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
      href={href}
      onClick={(event) => spaClick(href, event)}
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
      {t(locale, "targets.backToList")}
    </a>
  );
}

/** The faces with no payload of their own: the skeleton and the not-found card. */
export function TargetDetailShell({
  locale,
  children,
}: {
  locale: SpaBoot["locale"];
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <TargetDetailBackLink locale={locale} />
      {children}
    </div>
  );
}

/** One repository target read under the given base (the caller owns the workspace). */
export async function loadTargets(base: string): Promise<TargetListRow[] | null> {
  return parseTargets(await fetchJson(`${base}/api/targets`));
}

/** The App list the dialog's select is built from — the same `GET /api/apps` face. */
export async function loadRepositoryApps(base: string): Promise<RepositoryAppOption[] | null> {
  const payload = await fetchJson(`${base}/api/apps`);
  if (typeof payload !== "object" || payload === null) return null;
  const apps = (payload as { apps?: unknown }).apps;
  if (!Array.isArray(apps)) return null;
  const options: RepositoryAppOption[] = [];
  for (const raw of apps) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as { github_app_id?: unknown; bot_id?: unknown; github_name?: unknown; github_slug?: unknown };
    if (typeof row.github_app_id !== "number" || typeof row.bot_id !== "string") continue;
    const name =
      typeof row.github_name === "string" && row.github_name !== ""
        ? row.github_name
        : typeof row.github_slug === "string" && row.github_slug !== ""
          ? row.github_slug
          : String(row.github_app_id);
    options.push({
      app_id: row.github_app_id,
      bot_id: row.bot_id,
      name,
      slug: typeof row.github_slug === "string" && row.github_slug !== "" ? row.github_slug : null,
    });
  }
  return options;
}

/** The fixed first row's count pill. */
export function repositoryCountLabel(locale: SpaBoot["locale"], count: number): string {
  return count === 1
    ? t(locale, "targets.repositoryCountOne")
    : count === 0
      ? t(locale, "targets.repositoryCount")
      : t(locale, "targets.repositoryCountMany", { count });
}

/** A target's status pill: awaiting its first delivery, paused, or reviewable. */
export function targetStatusPill(
  locale: SpaBoot["locale"],
  target: TargetListRow,
): { tone: "warn" | "neutral" | "success"; label: string } {
  if (target.repo_id === null) return { tone: "warn", label: t(locale, "targets.status.uninstalled") };
  if (target.review_enabled === 0) return { tone: "neutral", label: t(locale, "targets.status.paused") };
  return { tone: "success", label: t(locale, "targets.status.reviewable") };
}

type RepositoryIdentity = { repo_owner: string | null; repo_name: string | null };

/** `owner/name`, or "" when the row names no repository at all. */
export function targetRepositoryName(target: RepositoryIdentity): string {
  if (target.repo_owner === null || target.repo_name === null) return "";
  return `${target.repo_owner}/${target.repo_name}`;
}

type RepositoryTableRow =
  | { kind: "all" }
  | { kind: "target"; target: TargetListRow };

/**
 * The loaded face of the list — exported so SSR pins the fixed first row, the
 * per-repository rows, the count pill and the empty state without a DOM runner.
 *
 * The table speaks the Apps list's vocabulary (name composite cell, status
 * badge, right-aligned figures). Its ORDER is the server's: review-descending
 * with never-reviewed rows last, so the filter only ever hides rows and never
 * reorders the ones it keeps.
 */
export function TargetsView({
  locale,
  state,
  targets,
  onRetry,
  addControl,
}: {
  locale: SpaBoot["locale"];
  state: "ok" | "error";
  targets: TargetListRow[] | null;
  onRetry: () => void;
  addControl?: ReactNode;
}) {
  const all = targets ?? [];
  const base = apiBase();
  const allHref = `${base}/repos/all`;
  const [uninstalledOnly, setUninstalledOnly] = useState(false);
  const uninstalledCount = all.filter((target) => target.repo_id === null).length;
  const rows = uninstalledOnly
    ? all.filter((target) => target.repo_id === null)
    : all.filter((target) => target.repo_id !== null);
  const reviewsTotal = all.reduce((sum, target) => sum + target.reviews_total, 0);
  const reviews7d = all.reduce((sum, target) => sum + target.reviews_7d, 0);
  const latestReview = all.reduce<string | null>(
    (latest, target) =>
      target.last_reviewed_at !== null && (latest === null || target.last_reviewed_at > latest)
        ? target.last_reviewed_at
        : latest,
    null,
  );
  const metrics: Metric[] =
    state === "ok"
      ? [
          { key: t(locale, "targets.metricRepositories"), value: all.length },
          { key: t(locale, "targets.metricReviews"), value: reviewsTotal },
          { key: t(locale, "targets.metricReviews7d"), value: reviews7d },
        ]
      : [];

  const columns: DataTableColumn<RepositoryTableRow>[] = [
    {
      header: t(locale, "targets.columnRepository"),
      cell: (row) => {
        if (row.kind === "all") {
          return (
            <a
              className="text-sm font-semibold text-foreground no-underline hover:underline"
              href={allHref}
              onClick={(event) => spaClick(allHref, event)}
            >
              {t(locale, "targets.allRepositories")}
            </a>
          );
        }
        const href = `${base}/repos/${row.target.target_id}`;
        return (
          <a
            className="text-sm font-semibold text-foreground no-underline hover:underline"
            href={href}
            onClick={(event) => spaClick(href, event)}
          >
            {targetRepositoryName(row.target) || "—"}
          </a>
        );
      },
      meta: (row) =>
        row.kind === "all" ? t(locale, "targets.allRepositoriesMeta") : row.target.app_name,
    },
    {
      header: t(locale, "targets.columnState"),
      cell: (row) => {
        if (row.kind === "all") {
          return <StatusBadge tone="accent">{repositoryCountLabel(locale, all.length)}</StatusBadge>;
        }
        const pill = targetStatusPill(locale, row.target);
        return <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>;
      },
    },
    {
      header: t(locale, "targets.columnReviews"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{row.kind === "all" ? reviewsTotal : row.target.reviews_total}</span>
      ),
    },
    {
      header: t(locale, "targets.columnReviews7d"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{row.kind === "all" ? reviews7d : row.target.reviews_7d}</span>
      ),
    },
    {
      header: t(locale, "targets.columnLastReview"),
      cell: (row) => (
        <span className="text-muted-foreground tabular-nums">
          {formatRelativeTime(row.kind === "all" ? latestReview : row.target.last_reviewed_at, locale)}
        </span>
      ),
    },
  ];

  const tableRows: RepositoryTableRow[] = [
    { kind: "all" },
    ...rows.map((target): RepositoryTableRow => ({ kind: "target", target })),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "targets.heading")}
        description={t(locale, "targets.headingDescription")}
        actions={addControl}
        metrics={<MetricBand metrics={metrics} />}
      />
      {state === "error" ? <ErrorState locale={locale} onRetry={onRetry} /> : null}
      {state === "ok" ? (
        <div className="flex flex-col gap-4">
          {uninstalledCount > 0 ? (
            <div className="flex justify-end">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={uninstalledOnly ? "uninstalled" : "available"}
                onValueChange={(next) => {
                  if (next !== "") setUninstalledOnly(next === "uninstalled");
                }}
                aria-label={t(locale, "targets.filterLabel")}
              >
                <ToggleGroupItem value="available">{t(locale, "targets.filterAvailable")}</ToggleGroupItem>
                <ToggleGroupItem value="uninstalled">
                  {t(locale, "targets.filterUninstalled", { count: uninstalledCount })}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          ) : null}
          <DataTable
            columns={columns}
            rows={tableRows}
            rowKey={(row) => (row.kind === "all" ? "all" : row.target.target_id)}
            rowProps={(row) => {
              const href = row.kind === "all" ? allHref : `${base}/repos/${row.target.target_id}`;
              return {
                className: "cursor-pointer",
                onClick: (event) => spaClick(href, event),
              };
            }}
          />
          {all.length === 0 ? (
            <EmptyState title={t(locale, "targets.emptyTitle")} description={t(locale, "targets.emptyDescription")} />
          ) : null}
          {all.length > 0 && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(locale, "targets.filterEmpty")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * How many matching rows the dialog mounts. An App installed on "All
 * repositories" grants hundreds; the dialog has no virtualizer, so it caps the
 * rows it renders and states the match count above them.
 */
export const REPOSITORY_LIST_CAP = 40;

/** The dialog's repository read: idle (no App), loading, failed, or loaded. */
export type RepositoryOptionsState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; repositories: InstallationRepository[]; degraded: boolean };

/** The chosen App's live installations (`GET /api/apps/:appId/settings`). */
export type InstallationsState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; installations: PendingInstallation[] };

/**
 * The add-repository dialog's BODY — every state as props, so SSR can pin the
 * zero-app, one-app, multi-app, empty-installation and duplicate faces without a
 * runner. The stateful {@link AddRepositoryDialog} owns the fetches.
 */
export function AddRepositoryDialogBody({
  locale,
  apps,
  appId,
  installations,
  repositories,
  existingRepoIds,
  selectedRepoIds,
  notice,
  busy,
  onSelectApp,
  onToggleRepo,
  onRetryInstallations,
  onRetryRepositories,
  onSubmit,
  onCancel,
}: {
  locale: SpaBoot["locale"];
  apps: readonly RepositoryAppOption[];
  appId: string;
  installations: InstallationsState;
  repositories: RepositoryOptionsState;
  existingRepoIds: ReadonlySet<number>;
  selectedRepoIds: ReadonlySet<number>;
  notice: { kind: NoticeKind; message: string } | null;
  busy: boolean;
  onSelectApp?: (next: string) => void;
  onToggleRepo?: (repoId: number) => void;
  onRetryInstallations?: () => void;
  onRetryRepositories?: () => void;
  onSubmit?: () => void;
  onCancel?: () => void;
}) {
  const base = apiBase();
  const appsHref = `${base}/apps`;
  const selectedApp = apps.find((app) => String(app.app_id) === appId) ?? null;
  const installed = installations.state === "ok" && installations.installations.length > 0;
  const confirmDisabled =
    apps.length === 0 ||
    !installed ||
    repositories.state !== "ok" ||
    selectedRepoIds.size === 0 ||
    busy;
  const [query, setQuery] = useState("");
  const all = repositories.state === "ok" ? repositories.repositories : [];
  const needle = query.trim().toLowerCase();
  const matches =
    needle === "" ? [] : all.filter((repository) => `${repository.owner}/${repository.name}`.toLowerCase().includes(needle));
  const visible = matches.slice(0, REPOSITORY_LIST_CAP);
  const installHref = appInstallHref(selectedApp?.slug ?? null);

  return (
    <div className="flex flex-col gap-4" data-slot="add-repository-body">
      {apps.length === 0 ? (
        <>
          <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.noApps")}</p>
          <a
            className="text-sm text-primary underline-offset-4 hover:underline"
            href={appsHref}
            onClick={(event) => spaClick(appsHref, event)}
          >
            {t(locale, "targets.addDialog.goToApps")}
          </a>
        </>
      ) : (
        <>
          <section className="flex flex-col gap-1.5" data-slot="add-step-app">
            <span className="text-sm font-medium">{t(locale, "targets.addDialog.stepApp")}</span>
            <Select value={appId} onValueChange={(next) => onSelectApp?.(next)}>
              <SelectTrigger aria-label={t(locale, "targets.addDialog.appLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {apps.map((app) => (
                  <SelectItem key={app.app_id} value={String(app.app_id)}>
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.sharedScopeComing")}</p>
          </section>

          <section className="@container flex flex-col gap-1.5" data-slot="add-step-installations">
            <span className="text-sm font-medium">{t(locale, "targets.addDialog.stepInstall")}</span>
            <div className="flex flex-col gap-4 @md:flex-row @md:items-start @md:justify-between">
              <div className="min-w-0">
                {selectedApp === null ? null : (
                  <AppInstallIdentity
                    locale={locale}
                    name={selectedApp.name}
                    avatarSrc={null}
                    appId={selectedApp.app_id}
                    href={installHref}
                  />
                )}
              </div>
              <div className="flex flex-col gap-2">
                {installations.state === "loading" ? (
                  <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.loadingInstallations")}</p>
                ) : null}
                {installations.state === "error" ? (
                  <ErrorState
                    locale={locale}
                    message={t(locale, "targets.addDialog.loadInstallationsFailed")}
                    onRetry={onRetryInstallations}
                  />
                ) : null}
                {installations.state === "ok" && installations.installations.length === 0 ? (
                  <>
                    <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.noInstallations")}</p>
                    <Button type="button" variant="outline" onClick={() => onRetryInstallations?.()}>
                      {t(locale, "targets.addDialog.recheck")}
                    </Button>
                  </>
                ) : null}
                {installations.state === "ok" && installations.installations.length > 0 ? (
                  <>
                    <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                      {installations.installations.map((row) => (
                        <li key={row.installation_id}>
                          {t(locale, "targets.addDialog.installationRow", {
                            account: row.account_login ?? t(locale, "targets.addDialog.installationNoAccount"),
                            id: row.installation_id,
                            time: formatRelativeTime(row.seen_at, locale),
                          })}
                        </li>
                      ))}
                    </ul>
                    <Button type="button" variant="outline" onClick={() => onRetryInstallations?.()}>
                      {t(locale, "targets.addDialog.recheck")}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2" data-slot="add-step-repositories">
            <span className="text-sm font-medium">{t(locale, "targets.addDialog.stepRepos")}</span>
            {!installed ? (
              <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.searchHint")}</p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="add-repository-search">
                    {t(locale, "targets.addDialog.searchLabel")}
                  </label>
                  <Input
                    id="add-repository-search"
                    type="search"
                    autoComplete="off"
                    placeholder={t(locale, "targets.addDialog.searchHint")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {repositories.state === "loading" ? (
                  <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.loadingRepos")}</p>
                ) : null}
                {repositories.state === "error" ? (
                  <ErrorState
                    locale={locale}
                    message={t(locale, "targets.addDialog.loadReposFailed")}
                    onRetry={onRetryRepositories}
                  />
                ) : null}
                {repositories.state === "ok" && repositories.repositories.length === 0 ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t(locale, "targets.addDialog.noInstallationRepos")}
                    </p>
                    {selectedApp === null ? null : (
                      <a
                        className="text-sm text-primary underline-offset-4 hover:underline"
                        href={`${base}/apps/${selectedApp.app_id}?tab=installations`}
                        onClick={(event) => spaClick(`${base}/apps/${selectedApp.app_id}?tab=installations`, event)}
                      >
                        {t(locale, "targets.addDialog.goToInstalled")}
                      </a>
                    )}
                  </>
                ) : null}
                {repositories.state === "ok" && repositories.degraded ? (
                  <p className="text-sm text-(--tone-warn-fg)">{t(locale, "targets.addDialog.degraded")}</p>
                ) : null}
                {needle === "" ? null : matches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t(locale, "targets.addDialog.noMatch", { query })}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {matches.length > REPOSITORY_LIST_CAP
                        ? t(locale, "targets.addDialog.resultsTruncated", {
                            cap: REPOSITORY_LIST_CAP,
                            count: matches.length,
                          })
                        : t(locale, "targets.addDialog.resultsCount", { count: matches.length })}
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {visible.map((repository) => {
                        const added = existingRepoIds.has(repository.repo_id);
                        const taken = added || repository.claimed;
                        const label = `${repository.owner}/${repository.name}`;
                        return (
                          <li key={repository.repo_id} className="flex items-center gap-2">
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={added || selectedRepoIds.has(repository.repo_id)}
                                disabled={taken || busy}
                                onChange={() => onToggleRepo?.(repository.repo_id)}
                              />
                              <span>{label}</span>
                            </label>
                            {added ? (
                              <StatusBadge tone="neutral">{t(locale, "targets.addDialog.alreadyAdded")}</StatusBadge>
                            ) : repository.claimed ? (
                              <StatusBadge tone="warn">{t(locale, "targets.addDialog.claimedElsewhere")}</StatusBadge>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onCancel?.()}>
          {t(locale, "common.cancel")}
        </Button>
        <Button type="button" disabled={confirmDisabled} onClick={() => onSubmit?.()}>
          {t(locale, "targets.addDialog.confirm")}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * The stateful add-repository dialog: it owns the App choice, the repository
 * read (per App, refetched on switch), the selection and the POST.
 *
 * A duplicate refusal is the SERVER's partial outcome: rows created in the same
 * batch stay written, the dialog stays open and names what already existed —
 * never a rollback, never a closed dialog that hides what landed.
 */
export function AddRepositoryDialog({
  locale,
  open,
  onClose,
  apps,
  existingRepoIds,
  onAdded,
}: {
  locale: SpaBoot["locale"];
  open: boolean;
  onClose: () => void;
  apps: readonly RepositoryAppOption[];
  existingRepoIds: ReadonlySet<number>;
  onAdded: () => void;
}) {
  const base = apiBase();
  const [pickedAppId, setPickedAppId] = useState<number | null>(null);
  const selectedApp = apps.find((app) => app.app_id === pickedAppId) ?? apps[0] ?? null;
  const appId = selectedApp === null ? "" : String(selectedApp.app_id);
  const [installations, setInstallations] = useState<InstallationsState>({ state: "loading" });
  const [repositories, setRepositories] = useState<RepositoryOptionsState>({ state: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const resetDialog = useCallback((): void => {
    setSelected(new Set());
    setNotice(null);
  }, []);
  const requestRef = useRef(0);
  const installationsRef = useRef(0);

  const loadRepositories = useCallback(
    async (targetAppId: string): Promise<void> => {
      const request = ++requestRef.current;
      if (targetAppId === "") {
        setRepositories({ state: "loading" });
        return;
      }
      setRepositories({ state: "loading" });
      try {
        const parsed = parseInstallationRepositories(
          await fetchJson(`${base}/api/apps/${targetAppId}/installation-repositories`),
        );
        if (requestRef.current !== request) return;
        setRepositories(
          parsed === null
            ? { state: "error" }
            : { state: "ok", repositories: parsed.repositories, degraded: parsed.degraded },
        );
      } catch {
        if (requestRef.current === request) setRepositories({ state: "error" });
      }
    },
    [base],
  );

  const loadInstallations = useCallback(
    async (targetAppId: string): Promise<void> => {
      const request = ++installationsRef.current;
      if (targetAppId === "") {
        setInstallations({ state: "loading" });
        return;
      }
      setInstallations({ state: "loading" });
      try {
        const parsed = parseAppInstallations(
          await fetchJson(`${base}/api/apps/${targetAppId}/settings`),
        );
        if (installationsRef.current !== request) return;
        setInstallations(parsed === null ? { state: "error" } : { state: "ok", installations: parsed });
      } catch {
        if (installationsRef.current === request) setInstallations({ state: "error" });
      }
    },
    [base],
  );

  useEffect(() => {
    if (!open) return;
    void loadRepositories(appId);
    void loadInstallations(appId);
    return () => {
      requestRef.current += 1;
      installationsRef.current += 1;
    };
  }, [open, appId, loadRepositories, loadInstallations]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const app = selectedApp;
    if (app === null || selected.size === 0) return;
    const chosen =
      repositories.state === "ok"
        ? repositories.repositories.filter((repository) => selected.has(repository.repo_id))
        : [];
    if (chosen.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const { status, body } = await postJson(`${base}/api/targets`, {
        bot_id: app.bot_id,
        repositories: chosen.map((repository) => ({
          repo_id: repository.repo_id,
          owner: repository.owner,
          name: repository.name,
        })),
      });
      const parsed = parseTargetCreate(body);
      if (status >= 400 || parsed === null) {
        setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
        return;
      }
      setSelected(new Set(parsed.duplicates.map((repository) => repository.repo_id)));
      if (parsed.duplicates.length > 0) {
        setNotice({
          kind: "warn",
          message: t(locale, "targets.addDialog.duplicates", {
            names: parsed.duplicates.map((repository) => `${repository.owner}/${repository.name}`).join(", "),
          }),
        });
        onAdded();
        return;
      }
      resetDialog();
      onAdded();
      onClose();
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        resetDialog();
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(locale, "targets.addDialog.title")}</DialogTitle>
          <DialogDescription>{t(locale, "targets.addDialog.description")}</DialogDescription>
        </DialogHeader>
        <AddRepositoryDialogBody
          locale={locale}
          apps={apps}
          appId={appId}
          installations={installations}
          repositories={repositories}
          existingRepoIds={existingRepoIds}
          selectedRepoIds={selected}
          notice={notice}
          busy={busy}
          onSelectApp={(next) => {
            setPickedAppId(Number(next));
            setSelected(new Set());
            setNotice(null);
          }}
          onRetryInstallations={() => void loadInstallations(appId)}
          onToggleRepo={(repoId) => {
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(repoId)) next.delete(repoId);
              else next.add(repoId);
              return next;
            });
          }}
          onRetryRepositories={() => void loadRepositories(appId)}
          onSubmit={() => void submit()}
          onCancel={() => {
            resetDialog();
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function canManageHere(boot: SpaBoot): boolean {
  const ref = boot.workspaceRef;
  const membership = (boot.memberships ?? []).find((row) => row.id === ref || row.slug === ref);
  return membership === undefined ? true : membership.role === "owner" || membership.role === "admin";
}

export function TargetsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const base = apiBase();
  const [targets, setTargets] = useState<TargetListRow[] | null>(null);
  const [apps, setApps] = useState<RepositoryAppOption[]>([]);
  const [appsFailed, setAppsFailed] = useState(false);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);

  const requestRef = useRef(0);

  const load = useCallback(async ({ background = false }: { background?: boolean } = {}): Promise<void> => {
    const stamp = ++requestRef.current;
    if (!background) setState("loading");
    let loaded: TargetListRow[] | null;
    try {
      loaded = await loadTargets(base);
    } catch {
      if (stamp !== requestRef.current) return;
      if (!background) setState("error");
      return;
    }
    if (stamp !== requestRef.current) return;
    if (loaded === null) {
      if (!background) setState("error");
      return;
    }
    setTargets(loaded);
    setState("ok");
    try {
      const apps = await loadRepositoryApps(base);
      if (stamp !== requestRef.current) return;
      setApps(apps ?? []);
      setAppsFailed(apps === null);
    } catch {
      if (stamp !== requestRef.current) return;
      setApps([]);
      setAppsFailed(true);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const existingRepoIds = useMemo(
    () => new Set((targets ?? []).map((target) => target.repo_id).filter((id): id is number => id !== null)),
    [targets],
  );

  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }
  return (
    <TargetsView
      locale={locale}
      state={state}
      targets={targets}
      onRetry={() => void load()}
      addControl={
        state === "ok" && canManageHere(boot) ? (
          <div className="flex flex-col items-end gap-2">
            <Button type="button" onClick={() => setDialogOpen(true)}>
              {t(locale, "targets.add")}
            </Button>
            {appsFailed ? (
              <div className="flex items-center gap-2">
                <p className="text-sm text-(--tone-warn-fg)">{t(locale, "targets.appsReadFailed")}</p>
                <Button type="button" variant="outline" onClick={() => void load({ background: true })}>
                  {t(locale, "common.retry")}
                </Button>
              </div>
            ) : null}
            <AddRepositoryDialog
              locale={locale}
              open={dialogOpen}
              onClose={() => setDialogOpen(false)}
              apps={apps}
              existingRepoIds={existingRepoIds}
              onAdded={() => void load({ background: true })}
            />
          </div>
        ) : undefined
      }
    />
  );
}

/** One repository target's policy read: what it runs with plus the workspace defaults. */
export async function loadTargetDetail(base: string, targetId: string): Promise<TargetPolicyPayload | null> {
  return parseTargetPolicyPayload(await fetchJson(`${base}/api/targets/${encodeURIComponent(targetId)}`));
}

/** The 所有仓库 entry's read: the workspace defaults themselves plus the live count. */
export async function loadWorkspaceDefaults(base: string): Promise<WorkspaceDefaultsPayload | null> {
  return parseWorkspaceDefaults(await fetchJson(`${base}/api/targets/all`));
}

type TargetDetailData =
  | { kind: "target"; payload: TargetPolicyPayload }
  | { kind: "all"; payload: WorkspaceDefaultsPayload };

const ALL_TARGETS = "all";

/**
 * The repository detail page, one component for BOTH variants:
 * - `/dashboard/<ref>/repos/<uuid>` — one target's policy (its own plus the
 *   inheritance toggle), read from `GET /api/targets/<uuid>`;
 * - `/dashboard/<ref>/repos/all` — the fixed 所有仓库 row: the workspace
 *   defaults (which every inheriting target runs with) and the live count,
 *   read from `GET /api/targets/all`, with no inheritance switch or pause.
 *
 * The tabs are the same three on both, and the active one lives in the address
 * bar (`?tab=insights|pull-requests`; the bare path is 评审配置), so a reload
 * keeps the operator where they were.
 *
 * Data plane: the page owns the read and the background reload. A background
 * failure rides the page notice so the loaded tab tree never unmounts under a
 * save, which would destroy the gate's typed draft.
 */
export function TargetDetailPage({ boot, targetId }: { boot: SpaBoot; targetId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const all = targetId === ALL_TARGETS;
  const [data, setData] = useState<TargetDetailData | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [tab, setTab] = useState<TargetDetailTab>(() =>
    parseTargetDetailTab(window.location.search),
  );
  const [search, setSearch] = useState<AppDetailSearch>({
    tab: "settings",
    window: "30",
    repo: "",
    pr: "",
  });
  const requestRef = useRef(0);

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      const stamp = ++requestRef.current;
      if (!background) setState("loading");
      try {
        const loaded: TargetDetailData | null = all
          ? await loadWorkspaceDefaults(base).then((payload) =>
              payload === null ? null : { kind: "all" as const, payload },
            )
          : await loadTargetDetail(base, targetId).then((payload) =>
              payload === null ? null : { kind: "target" as const, payload },
            );
        if (stamp !== requestRef.current) return false;
        if (loaded === null) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        setData(loaded);
        setState("ok");
        setNotice(null);
        return true;
      } catch (error) {
        if (stamp !== requestRef.current) return false;
        if (!background && !all && error instanceof ApiError && error.status === 404) setState("missing");
        else if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
        return false;
      }
    },
    [base, targetId, all, locale],
  );

  useEffect(() => {
    void load();
    setTab(parseTargetDetailTab(window.location.search));
  }, [load]);

  useEffect(() => {
    const onPop = () => setTab(parseTargetDetailTab(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function commitTab(next: string): void {
    const resolved = parseTargetDetailTab(`?tab=${next}`);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${targetDetailTabQuery(resolved)}`,
    );
    setTab(resolved);
  }

  if (state === "missing") {
    return (
      <TargetDetailShell locale={locale}>
        <EmptyState title={t(locale, "common.error.notFoundTitle")} />
      </TargetDetailShell>
    );
  }

  if (state === "error") {
    return (
      <TargetDetailShell locale={locale}>
        <ErrorState locale={locale} onRetry={() => void load()} />
      </TargetDetailShell>
    );
  }

  if (state === "loading" || data === null) {
    return (
      <TargetDetailShell locale={locale}>
        <PageSkeleton locale={locale} kind="forms" />
      </TargetDetailShell>
    );
  }

  let title: string;
  let description: string | undefined;
  if (data.kind === "all") {
    title = t(locale, "targets.allRepositories");
    description = repositoryCountLabel(locale, data.payload.target_count);
  } else {
    const { target } = data.payload;
    const name = targetRepositoryName(target);
    title = name === "" ? t(locale, "targets.status.uninstalled") : name;
    description = target.app_name ?? undefined;
  }
  const scope: ReadScope =
    data.kind === "all" ? { kind: "workspace" } : { kind: "target", targetId: data.payload.target.target_id };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description={description}
        backLink={<TargetDetailBackLink locale={locale} />}
      />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <Tabs value={tab} onValueChange={commitTab}>
        <TabsList
          variant="line"
          className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger value="settings">{t(locale, "targets.settings.heading")}</TabsTrigger>
          <TabsTrigger value="insights">{t(locale, "targets.tabInsights")}</TabsTrigger>
          <TabsTrigger value="pull-requests">{t(locale, "targets.tabPullRequests")}</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" forceMount>
          {data.kind === "all" ? (
            <WorkspaceDefaultsTab
              locale={locale}
              payload={data.payload}
              canManage={canManageHere(boot)}
              onReload={load}
              onNotice={setNotice}
            />
          ) : (
            <TargetSettingsTab locale={locale} payload={data.payload} onReload={load} onNotice={setNotice} />
          )}
        </TabsContent>
        <TabsContent value="insights" forceMount>
          <AppInsightsTab locale={locale} scope={scope} search={search} onSearch={setSearch} />
        </TabsContent>
        <TabsContent value="pull-requests" forceMount>
          <AppPullRequestsTab locale={locale} scope={scope} search={search} onSearch={setSearch} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
