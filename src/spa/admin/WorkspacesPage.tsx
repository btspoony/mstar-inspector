/**
 * Workspaces — every live tenant with its SQL-side counts, owner and resolved
 * plan (spec §3.3), a plan picker per row that writes one `PATCH
 * /api/workspaces/:id/plan` (spec §3.2), a slug editor that writes one
 * `PATCH /api/workspaces/:id/slug`, and — above the table — the platform's
 * official-workspace card: the one tenant whose bots may be offered
 * platform-wide (contract § 8.1).
 *
 * A downgrade below the live member count is legal and this screen never
 * touches a membership: the server's seat guard only blocks NEW invites, which
 * is what the page description says. The slug is platform-authored here — the
 * owner can rename the label (name) but not the readable URL segment — so the
 * server owns its grammar, reserved words and both collision guards; this
 * dialog only carries the value.
 */
import { useState, type FormEvent } from "react";
import {
  Button,
  CardContent,
  CardHeader,
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
} from "@design-system";
import { t, type DictionaryKey } from "../../i18n";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import {
  AdminWriteError,
  readRuntime,
  readWorkspaces,
  setOfficialWorkspace,
  setPlan,
  setWorkspaceSlug,
  useLoaded,
  type WorkspaceRow,
} from "./api";
import { ConsolePath, Screen } from "./screen";
import { TableSearch } from "./TableSearch";

/**
 * The plan ids the picker offers, in tier order — the wire values mirrored
 * from `plans` (migrations 0031/0032); no admin read exposes the catalogue.
 * The row's own plan leads with its localised catalogue label (see
 * `planOptions`), falling back to the server's `planName` only when the
 * stored plan is outside this list, so it still renders and keeps it. Add a
 * `GET /api/plans` read when a tier ships without a UI change.
 */
const PLAN_IDS = ["free", "pro", "unlimited"] as const;

/** Display-name dictionary keys, keyed by the wire plan id. */
const PLAN_LABEL_KEYS: Record<(typeof PLAN_IDS)[number], DictionaryKey> = {
  free: "admin.workspaces.planFree",
  pro: "admin.workspaces.planPro",
  unlimited: "admin.workspaces.planUnlimited",
};

/** The picker's label for a catalogue plan; an unknown id renders `fallback`. */
function planLabel(locale: Locale, planId: string, fallback: string = planId): string {
  const key = (PLAN_LABEL_KEYS as Record<string, DictionaryKey>)[planId];
  return key ? t(locale, key) : fallback;
}

/**
 * The options the picker shows: the row's own plan first (localised, falling
 * back to the server's name only for a stored plan outside `PLAN_IDS`),
 * then the rest of the catalogue with localised labels.
 */
function planOptions(row: WorkspaceRow, locale: Locale): readonly { id: string; name: string }[] {
  return [
    { id: row.planId, name: planLabel(locale, row.planId, row.planName) },
    ...PLAN_IDS.filter((planId) => planId !== row.planId).map((planId) => ({
      id: planId,
      name: planLabel(locale, planId),
    })),
  ];
}

/**
 * `<used> / <cap>` seat headroom. A NULL cap is unlimited, which is `—`; it
 * must never render as `0` (migration 0031: NULL means no limit).
 */
function seatHeadroom(row: WorkspaceRow): string {
  return row.includedMembers === null ? "—" : `${row.memberCount} / ${row.includedMembers}`;
}

/**
 * The official workspace (contract § 8.1) — the one tenant whose bots may be
 * marked shared platform-wide. Two writes, one each: Save designates the
 * selected live workspace, Clear removes the designation. Clearing is its own
 * action because an empty save is refused by the server, and it does not touch
 * a share already granted (those stay revocable from the Bots screen).
 */
function OfficialWorkspaceCard({
  locale,
  workspaces,
}: {
  locale: Locale;
  /** The page's own loaded rows — the selector's only source. */
  workspaces: readonly WorkspaceRow[];
}) {
  const { state, reload, update } = useLoaded(readRuntime);
  /** The operator's pick; `null` follows the stored designation. */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const current = state.status === "ready" ? state.data.officialWorkspaceId : null;
  // A designation pointing at a workspace this page no longer lists still
  // reads as the stored id: the card reports what the server holds.
  const currentName = current === null ? null : (workspaces.find((row) => row.id === current)?.name ?? current);
  const selection = draft ?? current ?? workspaces[0]?.id ?? "";

  async function commit(workspaceId: string | null): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const stored = await setOfficialWorkspace(workspaceId);
      update((data) => ({ ...data, officialWorkspaceId: stored }));
      setDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, stored === null ? "admin.workspaces.officialCleared" : "admin.workspaces.officialSaved"),
      });
    } catch (error) {
      // Generic message primary, the server's own refusal text as secondary detail.
      const generic = t(locale, "admin.workspaces.officialSaveFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "admin.workspaces.officialTitle")}</SectionCardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {t(locale, "admin.workspaces.officialDescription")}
        </p>
        {notice ? (
          <div className="mt-4">
            <PageNotice kind={notice.kind} message={notice.message} />
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <PageNotice kind="error" message={t(locale, "admin.workspaces.officialLoadFailed")} />
            <Button type="button" variant="secondary" size="sm" onClick={reload}>
              {t(locale, "common.retry")}
            </Button>
          </div>
        ) : null}
        {state.status === "ready" ? (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t(locale, "admin.workspaces.officialCurrent")}</span>
              <strong data-official-workspace={current ?? "none"}>
                {currentName ?? t(locale, "admin.workspaces.officialNone")}
              </strong>
              {current === null ? null : <code className="text-xs text-muted-foreground">{current}</code>}
            </div>
            {workspaces.length === 0 ? null : (
              <form
                className="mt-4 flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void commit(selection);
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="official-workspace">
                    {t(locale, "admin.workspaces.officialSelectLabel")}
                  </label>
                  <Select value={selection} disabled={busy} onValueChange={setDraft}>
                    <SelectTrigger
                      id="official-workspace"
                      size="sm"
                      className="w-64"
                      aria-label={t(locale, "admin.workspaces.officialSelectAria")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={busy || selection === current}>
                  {t(locale, "admin.workspaces.officialSave")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || current === null}
                  onClick={() => void commit(null)}
                >
                  {t(locale, "admin.workspaces.officialClear")}
                </Button>
              </form>
            )}
          </>
        ) : null}
      </CardContent>
    </SectionCard>
  );
}

export function WorkspacesPage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readWorkspaces);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Client-side filter over the loaded rows — no URL state, no request. */
  const [search, setSearch] = useState("");
  /** The row whose slug dialog is open, plus the value being typed. */
  const [slugTarget, setSlugTarget] = useState<WorkspaceRow | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  /** The slug refusal belongs to the dialog, not the page: Radix's modal
   * overlay covers the page notice while the dialog stays open. */
  const [slugRefusal, setSlugRefusal] = useState<string | null>(null);

  async function changePlan(target: WorkspaceRow, planId: string) {
    if (planId === target.planId) return;
    const previousId = target.planId;
    const previousName = target.planName;
    setBusy(target.id);
    setRefusal(null);
    // Optimistic: a controlled picker has to show the choice while the one
    // PATCH is in flight, and the label has to move with the id or the row's
    // own option would keep the old name. The seat cap is the server's answer,
    // so the accepted write re-reads instead of guessing it; a refusal puts
    // the stored pair back.
    const apply = (id: string, name: string) =>
      update((workspaces) =>
        workspaces.map((item) => (item.id === target.id ? { ...item, planId: id, planName: name } : item)),
      );
    apply(planId, planLabel(locale, planId));
    try {
      await setPlan(target.id, planId);
      reload();
    } catch (error) {
      apply(previousId, previousName);
      // The generic failure message stays primary; the server's own `{error}`
      // text rides along as secondary detail, never the only copy.
      const generic = t(locale, "admin.workspaces.planChangeFailed", { name: target.name });
      setRefusal(
        error instanceof AdminWriteError
          ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
          : generic,
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * Submit the dialog's slug. The row is patched in place on success (the read
   * endpoint's row carries `slug`), and the dialog closes; a refusal keeps it
   * open with the server's own message as secondary detail so the operator can
   * correct the value without retyping it.
   */
  async function submitSlug(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = slugTarget;
    if (!target) return;
    setBusy(target.id);
    setSlugRefusal(null);
    try {
      await setWorkspaceSlug(target.id, slugDraft.trim());
      update((workspaces) =>
        workspaces.map((item) =>
          item.id === target.id ? { ...item, slug: slugDraft.trim() } : item,
        ),
      );
      setSlugTarget(null);
    } catch (error) {
      const generic = t(locale, "admin.workspaces.slugChangeFailed", { name: target.name });
      setSlugRefusal(
        error instanceof AdminWriteError
          ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
          : generic,
      );
    } finally {
      setBusy(null);
    }
  }

  const columns: DataTableColumn<WorkspaceRow>[] = [
    {
      header: t(locale, "admin.workspaces.workspaceColumn"),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{row.name}</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs text-muted-foreground">{row.slug}</code>
            <span className="text-xs text-muted-foreground">{row.id}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy !== null}
              aria-label={t(locale, "admin.workspaces.slugAria", { name: row.name })}
              onClick={() => {
                setSlugTarget(row);
                setSlugDraft(row.slug);
                setSlugRefusal(null);
              }}
            >
              {t(locale, "admin.workspaces.slugAction")}
            </Button>
          </div>
        </div>
      ),
    },
    { header: t(locale, "admin.workspaces.ownerColumn"), cell: (row) => <span className="text-sm">{row.ownerLogin ?? "—"}</span> },
    {
      header: t(locale, "admin.workspaces.membersColumn"),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">{row.memberCount}</span>
          {row.pendingInviteCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t(locale, "admin.workspaces.pendingInvites", { count: row.pendingInviteCount })}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      header: t(locale, "admin.workspaces.seatsColumn"),
      align: "right",
      cell: (row) => <span className="text-sm tabular-nums">{seatHeadroom(row)}</span>,
    },
    {
      header: t(locale, "admin.workspaces.planColumn"),
      cell: (row) => (
        <Select
          value={row.planId}
          disabled={busy !== null}
          onValueChange={(planId) => void changePlan(row, planId)}
        >
          <SelectTrigger size="sm" aria-label={t(locale, "admin.workspaces.planAria", { name: row.name })}>
            <SelectValue>{planLabel(locale, row.planId, row.planName)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* The row's own plan leads, localised; only an id outside
                PLAN_IDS keeps the server's name. */}
            {planOptions(row, locale).map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    { header: t(locale, "admin.workspaces.createdColumn"), cell: (row) => <span className="text-sm">{row.createdAt.slice(0, 10)}</span> },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.workspaces")}
        description={t(locale, "admin.workspaces.description")}
        actions={<ConsolePath page="workspaces" />}
      />
      <Screen state={state} failed={t(locale, "admin.workspaces.loadFailed")} onRetry={reload} locale={locale}>
        {(workspaces) => {
          const query = search.trim().toLowerCase();
          const filtered = query
            ? workspaces.filter((row) =>
                [row.name, row.id, row.slug, row.ownerLogin ?? ""].some((field) =>
                  field.toLowerCase().includes(query),
                ),
              )
            : workspaces;
          return (
            <div className="flex flex-col gap-4">
              <OfficialWorkspaceCard locale={locale} workspaces={workspaces} />
              <TableSearch
                locale={locale}
                value={search}
                onChange={setSearch}
                shown={filtered.length}
                total={workspaces.length}
                placeholderKey="admin.search.placeholder"
              />
              {refusal ? <PageNotice kind="error" message={refusal} /> : null}
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(row) => row.id}
                empty={
                  // No-match copy is only true when there were rows to match.
                  query && workspaces.length > 0 ? (
                    <EmptyState
                      title={t(locale, "admin.search.emptyTitle")}
                      description={t(locale, "admin.search.emptyDescription")}
                    />
                  ) : (
                    <EmptyState
                      title={t(locale, "admin.workspaces.emptyTitle")}
                      description={t(locale, "admin.workspaces.emptyDescription")}
                    />
                  )
                }
              />
            </div>
          );
        }}
      </Screen>
      <Dialog
        open={slugTarget !== null}
        onOpenChange={(open) => (open ? undefined : setSlugTarget(null))}
      >
        {slugTarget ? (
          <DialogContent showCloseButton={false}>
            <form className="flex flex-col gap-4" onSubmit={(event) => void submitSlug(event)}>
              <DialogHeader>
                <DialogTitle>
                  {t(locale, "admin.workspaces.slugDialogTitle", { name: slugTarget.name })}
                </DialogTitle>
                <DialogDescription>{t(locale, "admin.workspaces.slugDialogDescription")}</DialogDescription>
              </DialogHeader>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t(locale, "admin.workspaces.slugLabel")}</span>
                <Input
                  value={slugDraft}
                  onChange={(event) => setSlugDraft(event.target.value)}
                  autoFocus
                />
              </label>
              {/* Inside the dialog: the modal overlay covers the page notice. */}
              {slugRefusal ? <PageNotice kind="error" message={slugRefusal} /> : null}
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setSlugTarget(null)}>
                  {t(locale, "admin.workspaces.cancelAction")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  // An unchanged draft would write a no-op UPDATE plus an audit
                  // row with identical before/after.
                  disabled={
                    busy !== null ||
                    slugDraft.trim().length === 0 ||
                    slugDraft.trim() === slugTarget.slug
                  }
                >
                  {t(locale, "admin.workspaces.slugSave")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}
