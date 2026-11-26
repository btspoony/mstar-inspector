import { useState, type SubmitEvent } from "react";
import { Button, CardContent, CardHeader, Input } from "@design-system";
import { quotaStartsOn } from "../../store/quota-store";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { PageNotice } from "../pages/PageNotice";
import {
  AdminWriteError,
  createQuotaVersion,
  previewQuotaVersion,
  readQuotaVersions,
  useLoaded,
  type QuotaCandidate,
  type QuotaImpact,
  type QuotaVersionRow,
  type QuotaVersionsData,
} from "./api";
import { ConsolePath, Screen } from "./screen";

const STATE_COPY = {
  current: "admin.quotaVersions.statusCurrent",
  scheduled: "admin.quotaVersions.statusScheduled",
  past: "admin.quotaVersions.statusHistorical",
} as const satisfies Record<QuotaVersionRow["state"], DictionaryKey>;

const todayDate = (): string => new Date().toISOString().slice(0, 10);

function wholeNumber(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : null;
}

type Drafts = {
  effectiveFrom: string;
  quick: string;
  standard: string;
  deep: string;
  byok: string;
  shared: string;
  rpPerCredit: string;
  notes: string;
  ceilings: Record<string, string>;
};

function seedDrafts(data: QuotaVersionsData): Drafts {
  const current = data.versions.find((row) => row.version === data.judgingVersion);
  const ceilings: Record<string, string> = {};
  for (const plan of data.plans) {
    const rp = current?.monthlyRp[plan.id] ?? null;
    ceilings[plan.id] = rp === null ? "" : String(rp);
  }
  return {
    effectiveFrom: todayDate(),
    quick: String(current?.base.quick ?? ""),
    standard: String(current?.base.default ?? ""),
    deep: String(current?.base.deep ?? ""),
    byok: String(current?.source.byok ?? ""),
    shared: String(current?.source.shared ?? ""),
    rpPerCredit: String(current?.rpPerCredit ?? ""),
    notes: "",
    ceilings,
  };
}

function candidateOf(drafts: Drafts, data: QuotaVersionsData): QuotaCandidate | null {
  const quick = wholeNumber(drafts.quick);
  const standard = wholeNumber(drafts.standard);
  const deep = wholeNumber(drafts.deep);
  const byok = wholeNumber(drafts.byok);
  const shared = wholeNumber(drafts.shared);
  const rpPerCredit = wholeNumber(drafts.rpPerCredit);
  if (quick === null || standard === null || deep === null) return null;
  if (byok === null || shared === null || rpPerCredit === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drafts.effectiveFrom)) return null;
  const monthlyRp: Record<string, number | null> = {};
  for (const plan of data.plans) {
    const raw = drafts.ceilings[plan.id] ?? "";
    if (raw.trim().length === 0) {
      monthlyRp[plan.id] = null;
      continue;
    }
    const rp = wholeNumber(raw);
    if (rp === null) return null;
    monthlyRp[plan.id] = rp;
  }
  return {
    effectiveFrom: drafts.effectiveFrom,
    base: { quick, default: standard, deep },
    source: { byok, shared },
    rpPerCredit,
    monthlyRp,
  };
}

export function QuotaVersionsPage({ locale }: { locale: Locale }) {
  const { state, reload } = useLoaded(readQuotaVersions);

  const columns: DataTableColumn<QuotaVersionRow>[] = [
    {
      header: t(locale, "admin.quotaVersions.versionColumn"),
      cell: (row) => <span className="text-sm font-medium tabular-nums">v{row.version}</span>,
      meta: (row) => row.notes,
    },
    {
      header: t(locale, "admin.quotaVersions.intervalColumn"),
      cell: (row) => (
        <span className="text-sm tabular-nums">
          {row.effectiveFrom.slice(0, 10)} → {row.effectiveTo?.slice(0, 10) ?? "—"}
        </span>
      ),
    },
    {
      header: t(locale, "admin.quotaVersions.statusColumn"),
      cell: (row) => <span className="text-sm">{t(locale, STATE_COPY[row.state])}</span>,
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.quotaVersions")}
        description={t(locale, "admin.quotaVersions.description")}
        actions={<ConsolePath page="quota-versions" />}
      />
      <Screen
        state={state}
        failed={t(locale, "admin.quotaVersions.loadFailed")}
        onRetry={reload}
        locale={locale}
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            {data.judgingVersion === null ? (
              <PageNotice
                kind="warn"
                message={t(locale, "admin.quotaVersions.noVersion", {
                  plans: data.plans.map((plan) => plan.name).join(", "),
                })}
              />
            ) : data.uncoveredPlanIds.length === 0 ? null : (
              <PageNotice
                kind="error"
                message={t(locale, "admin.quotaVersions.uncoveredPlans", {
                  version: data.judgingVersion,
                  plans: data.uncoveredPlanIds
                    .map((id) => data.plans.find((plan) => plan.id === id)?.name ?? id)
                    .join(", "),
                })}
              />
            )}
            <DataTable columns={columns} rows={data.versions} rowKey={(row) => row.id} />
            <CreateQuotaVersionForm
              key={data.judgingVersion ?? 0}
              locale={locale}
              data={data}
              onPublished={reload}
            />
          </div>
        )}
      </Screen>
    </section>
  );
}

function CreateQuotaVersionForm({
  locale,
  data,
  onPublished,
}: {
  locale: Locale;
  data: QuotaVersionsData;
  onPublished: () => void;
}) {
  const [drafts, setDrafts] = useState<Drafts>(() => seedDrafts(data));
  const [preview, setPreview] = useState<{ fingerprint: string; impact: QuotaImpact } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const patch = (change: Partial<Drafts>) => setDrafts((previous) => ({ ...previous, ...change }));
  const candidate = candidateOf(drafts, data);
  const fingerprint = candidate === null ? null : JSON.stringify(candidate);
  const fresh = preview !== null && fingerprint !== null && preview.fingerprint === fingerprint;

  async function runPreview() {
    if (candidate === null) return;
    setPreviewing(true);
    setPreviewFailure(null);
    setNotice(null);
    try {
      const impact = await previewQuotaVersion(candidate);
      setPreview({ fingerprint: JSON.stringify(candidate), impact });
    } catch (error) {
      setPreview(null);
      setPreviewFailure(
        error instanceof AdminWriteError
          ? t(locale, "admin.quotaVersions.previewLoadFailed", { detail: error.message })
          : t(locale, "admin.quotaVersions.previewUnreachable"),
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function publish(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (candidate === null || preview === null || !fresh) return;
    setPublishing(true);
    setNotice(null);
    try {
      const version = await createQuotaVersion(
        candidate,
        drafts.notes.trim().length === 0 ? null : drafts.notes.trim(),
        preview.impact,
      );
      setPreview(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.quotaVersions.published", { version }),
      });
      onPublished();
    } catch (error) {
      const generic = t(locale, "admin.quotaVersions.publishFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
      });
    } finally {
      setPublishing(false);
    }
  }

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
    extra?: { hint?: string; inputMode?: "numeric"; required?: boolean },
  ) => (
    <div className="flex flex-col gap-1.5" key={id}>
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        className="w-32"
        autoComplete="off"
        required={extra?.required ?? true}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(extra?.inputMode === "numeric" ? { type: "number", min: 1, step: 1 } : {})}
      />
      {extra?.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{extra.hint}</p>
      )}
    </div>
  );

  return (
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "admin.quotaVersions.formTitle")}</SectionCardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t(locale, "admin.quotaVersions.formCopy")}</p>
        {notice === null ? null : <PageNotice kind={notice.kind} message={notice.message} />}
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void publish(event)}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t(locale, "admin.quotaVersions.fieldVersion")}</span>
              <span className="text-sm tabular-nums">v{data.nextVersion}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="quota-effective-from">
                {t(locale, "admin.quotaVersions.fieldEffectiveFrom")}
              </label>
              <Input
                id="quota-effective-from"
                type="date"
                className="w-44"
                required
                min={todayDate()}
                value={drafts.effectiveFrom}
                onChange={(event) => patch({ effectiveFrom: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t(locale, "admin.quotaVersions.effectiveFromHint")}
              </p>
              <p className="text-xs text-muted-foreground">
                {/^\d{4}-\d{2}-\d{2}$/.test(drafts.effectiveFrom)
                  ? t(locale, "admin.quotaVersions.effectiveFromJudges", {
                      date: quotaStartsOn(`${drafts.effectiveFrom}T00:00:00.000Z`),
                    })
                  : null}
              </p>
            </div>
            <div className="flex min-w-60 flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="quota-notes">
                {t(locale, "admin.quotaVersions.fieldNotes")}
              </label>
              <Input
                id="quota-notes"
                autoComplete="off"
                placeholder={t(locale, "admin.quotaVersions.notesPlaceholder")}
                value={drafts.notes}
                onChange={(event) => patch({ notes: event.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {field("quota-base-quick", t(locale, "admin.quotaVersions.fieldBaseQuick"), drafts.quick, (next) => patch({ quick: next }), { inputMode: "numeric" })}
            {field("quota-base-standard", t(locale, "admin.quotaVersions.fieldBaseStandard"), drafts.standard, (next) => patch({ standard: next }), { inputMode: "numeric" })}
            {field("quota-base-deep", t(locale, "admin.quotaVersions.fieldBaseDeep"), drafts.deep, (next) => patch({ deep: next }), { inputMode: "numeric" })}
            {field("quota-source-byok", t(locale, "admin.quotaVersions.fieldSourceByok"), drafts.byok, (next) => patch({ byok: next }), { inputMode: "numeric" })}
            {field("quota-source-shared", t(locale, "admin.quotaVersions.fieldSourceShared"), drafts.shared, (next) => patch({ shared: next }), { inputMode: "numeric" })}
            {field("quota-rp-per-credit", t(locale, "admin.quotaVersions.fieldRpPerCredit"), drafts.rpPerCredit, (next) => patch({ rpPerCredit: next }), { inputMode: "numeric" })}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {data.plans.map((plan) =>
              field(
                `quota-monthly-${plan.id}`,
                t(locale, "admin.quotaVersions.fieldMonthlyRp", { plan: plan.name }),
                drafts.ceilings[plan.id] ?? "",
                (next) =>
                  patch({ ceilings: { ...drafts.ceilings, [plan.id]: next } }),
                { hint: t(locale, "admin.quotaVersions.monthlyRpHint"), inputMode: "numeric", required: false },
              ),
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={candidate === null || previewing}
              onClick={() => void runPreview()}
            >
              {t(locale, "admin.quotaVersions.previewAction")}
            </Button>
            <Button type="submit" disabled={candidate === null || !fresh || publishing}>
              {t(locale, "admin.quotaVersions.publish")}
            </Button>
          </div>
        </form>
        {previewFailure !== null ? (
          <PageNotice kind="error" message={previewFailure} />
        ) : fresh && preview !== null ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm">
              {preview.impact.count === 0
                ? t(locale, "admin.quotaVersions.previewNone")
                : t(locale, "admin.quotaVersions.previewCount", {
                    count: preview.impact.count,
                    total: preview.impact.total,
                  })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(locale, "admin.quotaVersions.previewStartsOn", { date: preview.impact.startsOn })}
            </p>
          </div>
        ) : (
          <PageNotice kind="warn" message={t(locale, "admin.quotaVersions.previewRequired")} />
        )}
      </CardContent>
    </SectionCard>
  );
}
