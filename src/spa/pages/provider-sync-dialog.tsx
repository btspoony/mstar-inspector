/**
 * note: I-000644: the "sync from the provider" flow. A template / custom declaration's
 * model list starts as the catalog snapshot's vocabulary, which is a
 * third-party guess — stale, and possibly spelled in a dialect the provider
 * stopped accepting. This dialog asks the provider's OWN `/models` endpoint what
 * it serves, shows the replace arithmetic (kept / added / dropped) BEFORE
 * anything is written, and only then replaces the stored list.
 *
 * Replace, never union: the stale ids are exactly what the operator asked to
 * retire, and after a dialect change they fail at request time. The counts are
 * the confirmation — the operator sees what a stale snapshot costs them.
 *
 * The fetch is the Worker's (`GET …/provider-models/preview`), so the credential
 * and the outbound request never touch the browser. `not fetched` (the initial
 * state), a refusal, and `fetched N` are three distinct faces.
 */
import { useState } from "react";
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@design-system";
import { t } from "../../i18n";
import type { SpaBoot } from "../boot";
import { postForm } from "../api";
import { apiBase } from "../workspace-base";
import { settingsErrorMessage, settingsOpOutcome } from "./SettingsPage";
import { NoticeRegion, type OpNotice } from "./PageNotice";

/** invariant: The preview shape the Worker answers: counts only, never the ids. */
type Preview = { current: number; fetched: number; kept: number; added: number; dropped: number };

type ProviderSyncDialogProps = {
  locale: SpaBoot["locale"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: number;
  provider: string;
  label: string;
  onOutcome: (notice: OpNotice) => void;
  /** note: The stored declaration changed — the card re-reads its count. */
  onReload: () => Promise<unknown>;
};

export function ProviderSyncDialog(props: ProviderSyncDialogProps) {
  return props.open ? <OpenProviderSyncDialog {...props} /> : null;
}

function OpenProviderSyncDialog({
  locale,
  open,
  onOpenChange,
  appId,
  provider,
  label,
  onOutcome,
  onReload,
}: ProviderSyncDialogProps) {
  // invariant: null = not fetched yet. The dialog never guesses a count it did not fetch.
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<"preview" | "write" | null>(null);
  const busy = pending !== null;
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function fetchPreview(): Promise<void> {
    if (busy) return;
    setPending("preview");
    setNotice(null);
    setPreview(null);
    try {
      const res = await fetch(
        `${apiBase()}/api/apps/${encodeURIComponent(String(appId))}/provider-models/preview?provider=${encodeURIComponent(provider)}`,
        { credentials: "same-origin", headers: { Accept: "application/json" }, redirect: "manual" },
      );
      const body = await res.text();
      if (!res.ok) {
        setNotice({ kind: "error", message: settingsErrorMessage(locale, body) });
        return;
      }
      setPreview(JSON.parse(body) as Preview);
    } catch {
      // invariant: A fetch that never reached the server: no preview, and the failure says
      // so instead of leaving the operator guessing whether it ran.
      setNotice({ kind: "error", message: t(locale, "settings.providers.sync.fetchFailed") });
    } finally {
      setPending(null);
    }
  }

  async function confirmSync(): Promise<void> {
    if (busy || preview === null) return;
    setPending("write");
    setNotice(null);
    try {
      const { status, body } = await postForm(`${apiBase()}/apps/${encodeURIComponent(String(appId))}/settings`, {
        op: "sync-provider-models",
        provider,
      });
      const outcome = settingsOpOutcome(
        locale,
        status,
        body,
        t(locale, "settings.providers.sync.saved", { provider, count: preview.fetched }),
      );
      if (outcome.kind === "success") {
        // note: The reload is what makes the card's count honest: the new list is the
        // only place the number comes from.
        await onReload();
        onOutcome(outcome);
        onOpenChange(false);
        return;
      }
      setNotice(outcome);
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (pending !== "write") onOpenChange(next);
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(locale, "settings.providers.sync.title", { label })}</DialogTitle>
          <DialogDescription>{t(locale, "settings.providers.sync.body", { provider })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void fetchPreview()}>
            {t(locale, preview === null ? "settings.providers.sync.action" : "settings.providers.sync.refetch")}
          </Button>
          <p className="text-muted-foreground">
            {preview === null ? t(locale, "settings.providers.sync.notFetched") : null}
          </p>
          {preview === null ? null : (
            <p>
              {t(locale, "settings.providers.sync.summary", {
                fetched: preview.fetched,
                kept: preview.kept,
                added: preview.added,
                dropped: preview.dropped,
              })}
            </p>
          )}
          <NoticeRegion notice={notice} />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              {t(locale, "common.cancel")}
            </Button>
          </DialogClose>
          <Button disabled={busy || preview === null} onClick={() => void confirmSync()}>
            {t(locale, "settings.providers.sync.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
