import { useRef, useState } from "react";
import { Button, CardContent, CardHeader, StatusBadge, type StatusTone } from "@design-system";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import { formatRelativeTime } from "../relative-time";
import {
  AdminWriteError,
  preflightDataUpgrade,
  readDataUpgrades,
  readRuntime,
  resetDataUpgrade,
  stepDataUpgrade,
  useLoaded,
  verifyDataUpgrade,
  type DataUpgradeRow,
  type DataUpgradeState,
  type DataUpgradeStatus,
  type MaintenanceConfig,
} from "./api";
import { ConsolePath, Screen } from "./screen";

const TONES: Record<DataUpgradeStatus, StatusTone> = {
  pending: "neutral",
  running: "accent",
  verifying: "accent",
  completed: "success",
  failed: "danger",
};

const STATUS_LABELS: Record<DataUpgradeStatus, DictionaryKey> = {
  pending: "admin.dataUpgrades.statusPending",
  running: "admin.dataUpgrades.statusRunning",
  verifying: "admin.dataUpgrades.statusVerifying",
  completed: "admin.dataUpgrades.statusCompleted",
  failed: "admin.dataUpgrades.statusFailed",
};

/** The list plus the window the banner states. */
export type DataUpgradePageData = {
  upgrades: DataUpgradeRow[];
  maintenance: MaintenanceConfig | null;
};

/**
 * How the last run of one item ended. The counts ride in the outcome: the
 * reload after a run replaces the row, so a line reading the row's own total
 * would state whatever the refresh answered instead of what this run did.
 */
export type RunOutcome = { id: string; kind: "done" | "stopped"; batch: number; count: number };

export type DataUpgradeViewProps = {
  locale: Locale;
  data: DataUpgradePageData;
  busyId: string | null;
  runningId: string | null;
  batches: number;
  outcome: RunOutcome | null;
  failure: string | null;
  onPreflight: (row: DataUpgradeRow) => void;
  onStep: (row: DataUpgradeRow) => void;
  onStop: () => void;
  onVerify: (row: DataUpgradeRow) => void;
  onReset: (row: DataUpgradeRow) => void;
};

function zeroPreflight(counts: Record<string, number>): boolean {
  const entries = Object.values(counts);
  return entries.length > 0 && entries.every((count) => count === 0);
}

function lastRunAt(row: DataUpgradeRow): number {
  const stamp = row.state.finishedAt ?? row.state.startedAt;
  const parsed = stamp === null ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {entries.map(([name, count]) => (
        <span key={name} className="text-sm">
          <code className="text-xs text-muted-foreground">{name}</code> {count}
        </span>
      ))}
    </div>
  );
}

export function DataUpgradeView({
  locale,
  data,
  busyId,
  runningId,
  batches,
  outcome,
  failure,
  onPreflight,
  onStep,
  onStop,
  onVerify,
  onReset,
}: DataUpgradeViewProps) {
  const { upgrades, maintenance } = data;
  const [openCompleted, setOpenCompleted] = useState<Record<string, boolean>>({});
  const ordered = [
    ...upgrades.filter((row) => row.state.status !== "completed"),
    ...upgrades
      .filter((row) => row.state.status === "completed")
      .sort((a, b) => lastRunAt(b) - lastRunAt(a)),
  ];
  const current =
    upgrades.find((row) => row.id === runningId) ??
    upgrades.find((row) => row.state.status === "running" || row.state.status === "verifying") ??
    null;
  const lastError =
    current?.state.lastError ??
    upgrades.find((row) => row.state.lastError !== null)?.state.lastError ??
    null;

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.dataUpgrades")}
        description={t(locale, "admin.dataUpgrades.description")}
        actions={<ConsolePath page="data-upgrades" />}
      />
      {failure ? <PageNotice kind="error" message={failure} /> : null}
      {maintenance === null ? null : (
        <SectionCard tier="primary">
          <CardHeader>
            <SectionCardTitle>
              {t(locale, "admin.dataUpgrades.maintenanceTitle")}
            </SectionCardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">{t(locale, "admin.flags.stateColumn")}</dt>
                <dd className="font-medium" data-maintenance="state">
                  {t(
                    locale,
                    maintenance.unreadable
                      ? "admin.runtime.maintenanceStateUnreadable"
                      : maintenance.enabled
                        ? "admin.runtime.maintenanceStateOn"
                        : "admin.runtime.maintenanceStateOff",
                  )}
                </dd>
              </div>
              {maintenance.enabled && maintenance.since !== null ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">
                    {t(locale, "admin.runtime.maintenanceSinceLabel")}
                  </dt>
                  <dd className="font-medium" data-maintenance="since">
                    {formatRelativeTime(maintenance.since, locale)}
                  </dd>
                </div>
              ) : null}
              {maintenance.enabled && maintenance.reason !== null ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">
                    {t(locale, "admin.runtime.maintenanceReasonLabel")}
                  </dt>
                  <dd className="font-medium" data-maintenance="reason">
                    {maintenance.reason}
                  </dd>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">{t(locale, "admin.dataUpgrades.currentLabel")}</dt>
                <dd className="font-medium" data-maintenance="current">
                  {current === null
                    ? t(locale, "admin.dataUpgrades.currentNone")
                    : current.title}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">
                  {t(locale, "admin.dataUpgrades.progressLabel")}
                </dt>
                <dd className="font-medium" data-maintenance="progress">
                  {current === null
                    ? t(locale, "admin.dataUpgrades.currentNone")
                    : t(locale, "admin.dataUpgrades.progressProcessed", {
                        count: current.state.processed,
                      })}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">{t(locale, "admin.dataUpgrades.errorLabel")}</dt>
                <dd className="font-medium" data-maintenance="error">
                  {lastError ?? t(locale, "admin.dataUpgrades.currentNone")}
                </dd>
              </div>
            </dl>
          </CardContent>
        </SectionCard>
      )}
      {upgrades.length === 0 ? (
        <EmptyState
          title={t(locale, "admin.dataUpgrades.emptyTitle")}
          description={t(locale, "admin.dataUpgrades.emptyDescription")}
        />
      ) : (
        ordered.map((row) => {
          const busy = busyId === row.id;
          const mine = runningId === row.id;
          const state: DataUpgradeState = row.state;
          const nothingToMigrate = zeroPreflight(row.preflight);
          const canRun =
            (state.status === "pending" || state.status === "running") && !nothingToMigrate;
          const done = state.status === "completed";
          const foldable = done || (nothingToMigrate && state.status === "pending");
          const open = openCompleted[row.id] === true;
          const verifiable =
            state.status === "running" || state.status === "verifying" || state.status === "failed";
          return (
            <SectionCard key={row.id} tier="secondary" data-upgrade={row.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <SectionCardTitle>{row.title}</SectionCardTitle>
                  <StatusBadge tone={TONES[state.status]}>
                    {t(locale, STATUS_LABELS[state.status])}
                  </StatusBadge>
                  {canRun && row.requiresDowntime ? (
                    <StatusBadge tone="warn">{t(locale, "admin.dataUpgrades.downtimeBadge")}</StatusBadge>
                  ) : null}
                  <code className="text-xs text-muted-foreground">{row.id}</code>
                  {foldable ? (
                    <>
                      <span className="text-sm text-muted-foreground">
                        {done
                          ? t(locale, "admin.dataUpgrades.completedSummary", {
                              count: state.processed,
                              time: formatRelativeTime(state.finishedAt ?? state.startedAt, locale),
                            })
                          : t(locale, "admin.dataUpgrades.nothingToMigrate")}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        aria-expanded={open}
                        onClick={() =>
                          setOpenCompleted((previous) => ({ ...previous, [row.id]: !open }))
                        }
                      >
                        {t(
                          locale,
                          open
                            ? "admin.dataUpgrades.hideDetails"
                            : "admin.dataUpgrades.showDetails",
                        )}
                      </Button>
                    </>
                  ) : null}
                </div>
              </CardHeader>
              {foldable && !open ? null : (
              <CardContent className="flex flex-col gap-4">
                <p className="text-sm">{row.impact}</p>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {t(locale, "admin.dataUpgrades.processedLabel")}
                    </dt>
                    <dd className="font-medium">{state.processed}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">{t(locale, "admin.dataUpgrades.lastRunLabel")}</dt>
                    <dd className="font-medium">
                      {formatRelativeTime(state.finishedAt ?? state.startedAt, locale)}
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">
                    {t(locale, "admin.dataUpgrades.preflightLabel")}
                  </span>
                  <Counts counts={row.preflight} />
                </div>
                {nothingToMigrate ? (
                  <p className="text-sm">{t(locale, "admin.dataUpgrades.nothingToMigrate")}</p>
                ) : null}
                {state.lastError === null ? null : (
                  <PageNotice kind="error" message={state.lastError} />
                )}
                <p className="text-sm">
                  {mine
                    ? t(locale, "admin.dataUpgrades.progressRunning", {
                        batch: batches,
                        count: state.processed,
                      })
                    : outcome !== null && outcome.id === row.id
                      ? t(
                          locale,
                          outcome.kind === "done"
                            ? "admin.dataUpgrades.progressDone"
                            : "admin.dataUpgrades.progressStopped",
                          { batch: outcome.batch, count: outcome.count },
                        )
                      : t(locale, "admin.dataUpgrades.progressProcessed", { count: state.processed })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onPreflight(row)}
                  >
                    {t(locale, "admin.dataUpgrades.preflightAction")}
                  </Button>
                  {state.status === "pending" ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || nothingToMigrate}
                      onClick={() => onStep(row)}
                    >
                      {t(locale, "admin.dataUpgrades.startAction")}
                    </Button>
                  ) : null}
                  {state.status === "running" ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || nothingToMigrate}
                      onClick={() => onStep(row)}
                    >
                      {t(locale, "admin.dataUpgrades.continueAction")}
                    </Button>
                  ) : null}
                  {verifiable ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => onVerify(row)}
                    >
                      {t(locale, "admin.dataUpgrades.verifyAction")}
                    </Button>
                  ) : null}
                  {mine ? (
                    <Button type="button" variant="destructive-outline" size="sm" onClick={onStop}>
                      {t(locale, "admin.dataUpgrades.stopAction")}
                    </Button>
                  ) : null}
                  {state.status === "failed" ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => onReset(row)}
                      >
                        {t(locale, "admin.dataUpgrades.restartAction")}
                      </Button>
                      <span className="self-center text-xs text-muted-foreground">
                        {t(locale, "admin.dataUpgrades.restartConsequence")}
                      </span>
                    </>
                  ) : null}
                  {state.status === "running" || state.status === "verifying" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => onReset(row)}
                    >
                      {t(locale, "admin.dataUpgrades.resetAction")}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
              )}
            </SectionCard>
          );
        })
      )}
    </section>
  );
}

async function readPage(): Promise<DataUpgradePageData> {
  const [upgrades, runtime] = await Promise.all([readDataUpgrades(), readRuntime()]);
  return { upgrades, maintenance: runtime.maintenance };
}

export function DataUpgradePage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readPage);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [batches, setBatches] = useState(0);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const stop = useRef(false);

  const setItem = (id: string, next: DataUpgradeState) =>
    update((page) => ({
      ...page,
      upgrades: page.upgrades.map((row) => (row.id === id ? { ...row, state: next } : row)),
    }));

  function refused(key: DictionaryKey, title: string, error: unknown): string {
    const generic = t(locale, key, { title });
    return error instanceof AdminWriteError
      ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
      : generic;
  }

  async function preflight(row: DataUpgradeRow) {
    setBusyId(row.id);
    setFailure(null);
    try {
      const counts = await preflightDataUpgrade(row.id);
      update((page) => ({
        ...page,
        upgrades: page.upgrades.map((item) =>
          item.id === row.id ? { ...item, preflight: counts } : item,
        ),
      }));
    } catch (error) {
      setFailure(refused("admin.dataUpgrades.preflightFailed", row.title, error));
    } finally {
      setBusyId(null);
    }
  }

  async function step(row: DataUpgradeRow) {
    stop.current = false;
    setBusyId(row.id);
    setRunningId(row.id);
    setBatches(0);
    setOutcome(null);
    setFailure(null);
    try {
      for (let count = 1; ; count += 1) {
        const answer = await stepDataUpgrade(row.id);
        setItem(row.id, answer.state);
        setBatches(count);
        if (answer.batch.done) {
          setOutcome({ id: row.id, kind: "done", batch: count, count: answer.state.processed });
          break;
        }
        if (stop.current) {
          setOutcome({ id: row.id, kind: "stopped", batch: count, count: answer.state.processed });
          break;
        }
      }
    } catch (error) {
      setFailure(refused("admin.dataUpgrades.stepFailed", row.title, error));
    } finally {
      setRunningId(null);
      setBusyId(null);
      reload();
    }
  }

  async function verify(row: DataUpgradeRow) {
    setBusyId(row.id);
    setFailure(null);
    try {
      setItem(row.id, (await verifyDataUpgrade(row.id)).state);
    } catch (error) {
      setFailure(refused("admin.dataUpgrades.verifyFailed", row.title, error));
    } finally {
      setBusyId(null);
      reload();
    }
  }

  async function reset(row: DataUpgradeRow) {
    setBusyId(row.id);
    setFailure(null);
    try {
      setItem(row.id, await resetDataUpgrade(row.id));
    } catch (error) {
      setFailure(refused("admin.dataUpgrades.resetFailed", row.title, error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen
      state={state}
      failed={t(locale, "admin.dataUpgrades.loadFailed")}
      onRetry={reload}
      locale={locale}
    >
      {(data) => (
        <DataUpgradeView
          locale={locale}
          data={data}
          busyId={busyId}
          runningId={runningId}
          batches={batches}
          outcome={outcome}
          failure={failure}
          onPreflight={(row) => void preflight(row)}
          onStep={(row) => void step(row)}
          onStop={() => {
            stop.current = true;
          }}
          onVerify={(row) => void verify(row)}
          onReset={(row) => void reset(row)}
        />
      )}
    </Screen>
  );
}
