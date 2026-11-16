/**
 * The repository surface (`/dashboard/<ref>/targets`): the workspace's
 * repositories, listed from `GET /:ref/api/targets`, with the fixed 所有仓库
 * entry first (product spec J1) and the add-repository dialog (J2).
 *
 * A row IS a target: one repository under one workspace. `repo_id: null` is the
 * 待安装 state a migrated row carries until a delivery claims it (D15) — the list
 * needs no installation call to say so, which is why the read carries the
 * discriminator instead of per-row installation facts.
 *
 * The detail address (`…/targets/<targetId>`) keeps rendering `TargetDetailPage`;
 * its three tabs are the sibling task's surface.
 */
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from "@design-system";
import { PageHeader } from "@/components/PageHeader";
import { ListRow, ListRowGroup } from "@/components/ListRow";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { fetchJson, postJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { spaClick } from "../spa-click";
import { apiBase } from "../workspace-base";
import { loadAppDetail, TargetHeader } from "./AppDetailPage";
import { PageNotice, type NoticeKind } from "./PageNotice";
import { SettingsView } from "./SettingsPage";
import {
  parseInstallationRepositories,
  parseTargetCreate,
  parseTargets,
  type InstallationRepositoryOption,
  type RepositoryAppOption,
  type SettingsPayload,
  type TargetListRow,
} from "./data";

/**
 * The page wayfinding link back to the list, derived from the page's own API
 * base so the rendered href is the real target under any workspace ref. A
 * separate component from the stateful page so the error and ok faces share
 * one exit.
 */
export function TargetDetailShell({
  locale,
  children,
}: {
  locale: SpaBoot["locale"];
  children: ReactNode;
}) {
  const href = `${apiBase()}/targets`;
  return (
    <div className="flex flex-col gap-6">
      <a
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
        href={href}
        onClick={(event) => spaClick(href, event)}
      >
        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
        {t(locale, "targets.backToList")}
      </a>
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
    options.push({ app_id: row.github_app_id, bot_id: row.bot_id, name });
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

/** A target's status pill: awaiting its first delivery, paused, or reviewing. */
export function targetStatusPill(
  locale: SpaBoot["locale"],
  target: TargetListRow,
): { tone: "warn" | "neutral" | "success"; label: string } {
  if (target.repo_id === null) return { tone: "warn", label: t(locale, "targets.status.uninstalled") };
  if (target.review_enabled === 0) return { tone: "neutral", label: t(locale, "targets.status.paused") };
  return { tone: "success", label: t(locale, "targets.status.reviewing") };
}

/** `owner/name`, or the 待安装 fallback for a row without repository identity. */
export function targetRepositoryName(target: TargetListRow): string {
  if (target.repo_owner === null || target.repo_name === null) return "";
  return `${target.repo_owner}/${target.repo_name}`;
}

/**
 * The loaded face of the list — exported so SSR pins the fixed first row, the
 * per-repository rows, the count pill and the empty state without a DOM runner.
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
  const rows = targets ?? [];
  const base = apiBase();
  const allHref = `${base}/targets/all`;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(locale, "targets.heading")} actions={addControl} />
      {state === "error" ? <ErrorState locale={locale} onRetry={onRetry} /> : null}
      {state === "ok" ? (
        <div className="flex flex-col gap-4">
          <ListRowGroup>
            <ListRow
              identity={
                <a
                  className="text-foreground no-underline hover:underline"
                  href={allHref}
                  onClick={(event) => spaClick(allHref, event)}
                >
                  {t(locale, "targets.allRepositories")}
                </a>
              }
              status={<StatusBadge tone="accent">{repositoryCountLabel(locale, rows.length)}</StatusBadge>}
              meta={t(locale, "targets.allRepositoriesMeta")}
            />
            {rows.map((target) => {
              const href = `${base}/targets/${target.target_id}`;
              const pill = targetStatusPill(locale, target);
              return (
                <ListRow
                  key={target.target_id}
                  identity={
                    <a
                      className="text-foreground no-underline hover:underline"
                      href={href}
                      onClick={(event) => spaClick(href, event)}
                    >
                      {target.repo_id === null ? "—" : targetRepositoryName(target)}
                    </a>
                  }
                  status={<StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>}
                  meta={
                    target.repo_id === null
                      ? t(locale, "targets.metaUninstalled")
                      : target.last_reviewed_at === null
                        ? t(locale, "targets.metaNever", { app: target.app_name })
                        : t(locale, "targets.meta", {
                            app: target.app_name,
                            time: formatRelativeTime(target.last_reviewed_at, locale),
                          })
                  }
                />
              );
            })}
          </ListRowGroup>
          {rows.length === 0 ? (
            <EmptyState title={t(locale, "targets.emptyTitle")} description={t(locale, "targets.emptyDescription")} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The dialog's repository read: idle (no App), loading, failed, or loaded. */
export type RepositoryOptionsState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; repositories: InstallationRepositoryOption[]; degraded: boolean };

/**
 * The add-repository dialog's BODY — every state as props, so SSR can pin the
 * zero-app, one-app, multi-app, empty-installation and duplicate faces without a
 * runner. The stateful {@link AddRepositoryDialog} owns the fetches.
 */
export function AddRepositoryDialogBody({
  locale,
  apps,
  appId,
  repositories,
  existingRepoIds,
  selectedRepoIds,
  notice,
  busy,
  onSelectApp,
  onToggleRepo,
  onRetryRepositories,
  onSubmit,
  onCancel,
}: {
  locale: SpaBoot["locale"];
  apps: readonly RepositoryAppOption[];
  appId: string;
  repositories: RepositoryOptionsState;
  existingRepoIds: ReadonlySet<number>;
  selectedRepoIds: ReadonlySet<number>;
  notice: { kind: NoticeKind; message: string } | null;
  busy: boolean;
  onSelectApp?: (next: string) => void;
  onToggleRepo?: (repoId: number) => void;
  onRetryRepositories?: () => void;
  onSubmit?: () => void;
  onCancel?: () => void;
}) {
  const base = apiBase();
  const appsHref = `${base}/apps`;
  const selectedApp = apps.find((app) => String(app.app_id) === appId) ?? null;
  const confirmDisabled =
    apps.length === 0 ||
    repositories.state !== "ok" ||
    selectedRepoIds.size === 0 ||
    busy;

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
          {apps.length === 1 ? (
            // One App leaves nothing to choose: the binding is stated, not selectable.
            <p className="text-sm text-muted-foreground">
              {t(locale, "targets.addDialog.binding", { app: apps[0]!.name })}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t(locale, "targets.addDialog.appLabel")}</span>
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
            </div>
          )}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t(locale, "targets.addDialog.repoLabel")}</span>
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
            {repositories.state === "ok" && repositories.repositories.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {repositories.repositories.map((repository) => {
                  const added = existingRepoIds.has(repository.repo_id);
                  const label = `${repository.owner}/${repository.name}`;
                  return (
                    <li key={repository.repo_id} className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={added || selectedRepoIds.has(repository.repo_id)}
                          disabled={added || busy}
                          onChange={() => onToggleRepo?.(repository.repo_id)}
                        />
                        <span>{label}</span>
                      </label>
                      {added ? (
                        <StatusBadge tone="neutral">{t(locale, "targets.addDialog.alreadyAdded")}</StatusBadge>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
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
  const [appId, setAppId] = useState<string>(apps.length > 0 ? String(apps[0]!.app_id) : "");
  const [repositories, setRepositories] = useState<RepositoryOptionsState>({ state: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelledRef = useRef(false);

  const loadRepositories = useCallback(
    async (targetAppId: string): Promise<void> => {
      if (targetAppId === "") {
        setRepositories({ state: "loading" });
        return;
      }
      setRepositories({ state: "loading" });
      try {
        const parsed = parseInstallationRepositories(
          await fetchJson(`${base}/api/apps/${targetAppId}/installation-repositories`),
        );
        if (cancelledRef.current) return;
        setRepositories(
          parsed === null
            ? { state: "error" }
            : { state: "ok", repositories: parsed.repositories, degraded: parsed.degraded },
        );
      } catch {
        if (!cancelledRef.current) setRepositories({ state: "error" });
      }
    },
    [base],
  );

  useEffect(() => {
    cancelledRef.current = false;
    if (!open) return () => {
      cancelledRef.current = true;
    };
    void loadRepositories(appId);
    return () => {
      cancelledRef.current = true;
    };
  }, [open, appId, loadRepositories]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const app = apps.find((candidate) => String(candidate.app_id) === appId);
    if (app === undefined || selected.size === 0) return;
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
      // The rows that landed are no longer offerable; the refused ones stay
      // selected so the user can see what already existed.
      setSelected(new Set(parsed.duplicates.map((repository) => repository.repo_id)));
      onAdded();
      if (parsed.duplicates.length > 0) {
        setNotice({
          kind: "warn",
          message: t(locale, "targets.addDialog.duplicates", {
            names: parsed.duplicates.map((repository) => `${repository.owner}/${repository.name}`).join(", "),
          }),
        });
        return;
      }
      onClose();
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(locale, "targets.addDialog.title")}</DialogTitle>
          <DialogDescription>{t(locale, "targets.addDialog.description")}</DialogDescription>
        </DialogHeader>
        <AddRepositoryDialogBody
          locale={locale}
          apps={apps}
          appId={appId}
          repositories={repositories}
          existingRepoIds={existingRepoIds}
          selectedRepoIds={selected}
          notice={notice}
          busy={busy}
          onSelectApp={(next) => {
            setAppId(next);
            setSelected(new Set());
            setNotice(null);
          }}
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
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

/** True when the caller may open the add dialog (owner/admin of the addressed workspace). */
function canManageHere(boot: SpaBoot): boolean {
  const ref = boot.workspaceRef;
  const membership = (boot.memberships ?? []).find((row) => row.id === ref || row.slug === ref);
  return membership === undefined ? true : membership.role === "owner" || membership.role === "admin";
}

export function TargetsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  // Read per render (the AppsPage precedent): the switcher navigates with
  // pushState + popstate, so the page base must track the URL it is on.
  const base = apiBase();
  const [targets, setTargets] = useState<TargetListRow[] | null>(null);
  const [apps, setApps] = useState<RepositoryAppOption[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const loaded = await loadTargets(base);
      if (loaded === null) {
        setState("error");
        return;
      }
      setTargets(loaded);
      setApps((await loadRepositoryApps(base)) ?? []);
      setState("ok");
    } catch {
      setState("error");
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
        canManageHere(boot) ? (
          <div className="flex flex-col items-end gap-2">
            <Button type="button" onClick={() => setDialogOpen(true)}>
              {t(locale, "targets.add")}
            </Button>
            <AddRepositoryDialog
              locale={locale}
              open={dialogOpen}
              onClose={() => setDialogOpen(false)}
              apps={apps}
              existingRepoIds={existingRepoIds}
              onAdded={() => void load()}
            />
          </div>
        ) : undefined
      }
    />
  );
}

export function TargetDetailPage({ boot, appId }: { boot: SpaBoot; appId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);

  // Background reloads (op-triggered refreshes) keep the loaded card tree
  // mounted — an unmount would destroy every typed input and open dialog.
  // A failed background refresh rides the page notice; the first load owns
  // the page-level error face.
  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      if (!background) setState("loading");
      try {
        const loaded = await loadAppDetail(base, appId);
        if (cancelledRef.current) return false;
        if (!loaded) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        setPayload(loaded);
        setState("ok");
        setNotice(null);
        return true;
      } catch {
        if (!cancelledRef.current) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
        }
        return false;
      }
    },
    [base, appId, locale],
  );

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  if (state === "loading") {
    return (
      <TargetDetailShell locale={locale}>
        <PageSkeleton locale={locale} kind="forms" />
      </TargetDetailShell>
    );
  }

  return (
    <TargetDetailShell locale={locale}>
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <div className="flex flex-col gap-6">
          <TargetHeader locale={locale} appId={appId} payload={payload} />
          {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
          <SettingsView locale={locale} payload={payload} onReload={load} />
        </div>
      ) : null}
    </TargetDetailShell>
  );
}
