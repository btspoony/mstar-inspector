/**
 * The Bots list (`/dashboard/<ref>/bots`, prototype screen 5): the front door
 * to the one bot detail page. TWO sections, not a filter — the bots this
 * workspace owns and the ones other workspaces share with it — and the create
 * action sits in the owned section's header, for a manager only.
 *
 * Credits render via `formatCredits` at the list payload's own rate; the route
 * omits `rp_per_credit` when the operator profile is unreadable, and the ADR
 * fallback (1 Credit = 1,000 RP) covers that case.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  StatusBadge,
} from "@design-system";
import { t } from "../../i18n";
import { postJson } from "../api";
import type { SpaBoot } from "../boot";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { GroupCard, GroupCardBody, GroupCardHeader } from "@/components/GroupCard";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { spaClick } from "../spa-click";
import { apiBase } from "../workspace-base";
import { canCreateAppFor, loadUsableBots } from "./AppsPage";
import { effectiveMultiplier, usageCeilingCell } from "./credits";
import type { UsableBotRow, UsableBotsPayload } from "./data";
import { PageNotice } from "./PageNotice";

export type BotsReadState =
  | { kind: "loading" }
  | { kind: "ok"; payload: UsableBotsPayload }
  | { kind: "error"; message: string };

export function BotsPage({ boot }: { boot: SpaBoot }) {
  const { locale } = boot;
  const base = apiBase();
  const [state, setState] = useState<BotsReadState>({ kind: "loading" });
  const canCreate = canCreateAppFor(boot, base === "/dashboard" ? null : base.slice("/dashboard/".length));

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ok", payload: await loadUsableBots(base) });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error && err.message !== "" ? err.message : t(locale, "common.loadFailed"),
      });
    }
  }, [base, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <BotsView
      locale={locale}
      base={base}
      state={state}
      canCreate={canCreate}
      onRetry={() => void load()}
      onCreated={() => void load()}
    />
  );
}

export function BotsView({
  locale,
  base,
  state,
  canCreate,
  onRetry,
  onCreated,
}: {
  locale: SpaBoot["locale"];
  base: string;
  state: BotsReadState;
  canCreate: boolean;
  onRetry?: () => void;
  onCreated: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(locale, "bots.list.title")} description={t(locale, "bots.list.description")} />
      {state.kind === "loading" ? <PageSkeleton locale={locale} kind="table" /> : null}
      {state.kind === "error" ? (
        <ErrorState locale={locale} message={state.message} onRetry={onRetry} />
      ) : null}
      {state.kind === "ok" ? (
        <BotsSections
          locale={locale}
          base={base}
          payload={state.payload}
          canCreate={canCreate}
          onCreated={onCreated}
        />
      ) : null}
    </div>
  );
}

/** The two sections: owned first (where the create action lives), then shared. */
function BotsSections({
  locale,
  base,
  payload,
  canCreate,
  onCreated,
}: {
  locale: SpaBoot["locale"];
  base: string;
  payload: UsableBotsPayload;
  canCreate: boolean;
  onCreated: () => void;
}) {
  const columns = botColumns(locale, base, payload);
  const owned = payload.bots.filter((bot) => bot.owned);
  const shared = payload.bots.filter((bot) => !bot.owned);
  return (
    <>
      <GroupCard>
        <GroupCardHeader
          title={t(locale, "bots.list.ownedSection")}
          summary={t(locale, "bots.list.ownedHint")}
          actions={
            canCreate ? <CreateBotDialog locale={locale} base={base} onCreated={onCreated} /> : undefined
          }
        />
        <GroupCardBody>
          <DataTable
            columns={columns}
            rows={owned}
            rowKey={(bot) => `owned-${bot.id}`}
            rowProps={(bot) => (bot.archived ? { className: "text-muted-foreground" } : {})}
            empty={
              <EmptyState
                title={t(locale, "apps.bots.emptyMineTitle")}
                description={t(locale, "apps.bots.emptyMineDescription")}
              />
            }
          />
        </GroupCardBody>
      </GroupCard>
      <GroupCard>
        <GroupCardHeader
          title={t(locale, "bots.list.sharedSection")}
          summary={t(locale, "bots.list.sharedHint")}
        />
        <GroupCardBody>
          <DataTable
            columns={columns}
            rows={shared}
            rowKey={(bot) => `shared-${bot.id}`}
            rowProps={(bot) => (bot.archived ? { className: "text-muted-foreground" } : {})}
            empty={
              <EmptyState
                title={t(locale, "apps.bots.emptySharedTitle")}
                description={t(locale, "apps.bots.emptySharedDescription")}
              />
            }
          />
        </GroupCardBody>
      </GroupCard>
    </>
  );
}

/**
 * One row face: the name links to the bot's detail page, the description rides
 * the muted second line, and an archived bot keeps its row — muted, with the
 * 已归档 pill instead of the sharing state.
 */
function botColumns(
  locale: SpaBoot["locale"],
  base: string,
  payload: UsableBotsPayload,
): DataTableColumn<UsableBotRow>[] {
  const hrefOf = (botId: string): string => `${base}/bots/${encodeURIComponent(botId)}`;
  return [
    {
      header: t(locale, "bots.fieldName"),
      cell: (bot) => (
        <a
          className={
            bot.archived
              ? "text-sm font-semibold text-muted-foreground no-underline hover:underline"
              : "text-sm font-semibold text-foreground no-underline hover:underline"
          }
          href={hrefOf(bot.id)}
          onClick={(event) => spaClick(hrefOf(bot.id), event)}
        >
          {bot.name}
        </a>
      ),
      meta: (bot) => bot.description,
    },
    {
      header: t(locale, "apps.bots.columnOwner"),
      cell: (bot) => <span className="text-muted-foreground">{bot.workspace_name}</span>,
    },
    {
      header: t(locale, "bots.fieldSharing"),
      cell: (bot) =>
        bot.archived ? (
          <StatusBadge tone="neutral">{t(locale, "bots.list.archived")}</StatusBadge>
        ) : (
          <StatusBadge tone={bot.scope === "shared" ? "accent" : "neutral"}>
            {t(locale, bot.scope === "shared" ? "bots.stateShared" : "bots.stateOwn")}
          </StatusBadge>
        ),
    },
    {
      header: t(locale, "bots.fieldMultiplier"),
      cell: (bot) => (
        <span className="tabular-nums">×{effectiveMultiplier(bot.owned, bot.scope, bot.multiplier)}</span>
      ),
    },
    {
      header: t(locale, "credits.usedThisMonth"),
      align: "right",
      cell: (bot) => (
        <span className="text-muted-foreground tabular-nums">
          {/* F10: an unknown ceiling is an error, never "no ceiling". */}
          {usageCeilingCell(locale, { used_rp: bot.month_used_rp }, {
            owned: bot.owned,
            quotaError: payload.quota_error === true,
            ceilingRp: payload.plan_monthly_rp,
            rpPerCredit: payload.rp_per_credit,
          })}
        </span>
      ),
    },
  ];
}

/** 创建机器人: name required, description optional; a 201 reloads the list. */
export function CreateBotDialog({
  locale,
  base,
  onCreated,
}: {
  locale: SpaBoot["locale"];
  base: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (busy) return;
    setError(null);
    if (!next) {
      setName("");
      setDescription("");
    }
    setOpen(next);
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError(t(locale, "bots.create.nameRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const trimmedDescription = description.trim();
      const { status } = await postJson(`${base}/api/review-bots`, {
        name: trimmed,
        ...(trimmedDescription === "" ? {} : { description: trimmedDescription }),
      });
      if (status !== 201) {
        setError(t(locale, "bots.create.failed"));
        return;
      }
      setName("");
      setDescription("");
      setOpen(false);
      onCreated();
    } catch {
      setError(t(locale, "bots.create.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          {t(locale, "bots.create.open")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(locale, "bots.create.title")}</DialogTitle>
          <DialogDescription>{t(locale, "bots.create.hint")}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void onCreate(event)}>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="create-bot-name">
              {t(locale, "bots.create.nameLabel")}
            </label>
            <Input
              id="create-bot-name"
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="create-bot-description">
              {t(locale, "bots.create.descriptionLabel")}
            </label>
            <Input
              id="create-bot-description"
              autoComplete="off"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {error === null ? null : <PageNotice kind="error" message={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
              {t(locale, "common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(locale, "bots.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
