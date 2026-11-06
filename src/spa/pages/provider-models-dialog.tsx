/**
 * The model picker: which model ids of an already-configured provider the App
 * exposes (the `update-provider-models` settings op). The stored declaration
 * is the seed — a stored id the catalog no longer lists stays listed and
 * checked, never silently dropped. At least one id must stay selected, and
 * the 32-id cap (MAX_CUSTOM_PROVIDER_MODEL_IDS) is enforced client-side: an
 * unchecked box is unavailable at the cap, and the server still refuses an
 * over-limit write.
 *
 * Busy state, the disabled save and the failure contract are this dialog's —
 * `StepDialog` owns only the shell. Like the add-key flow, a failed submit
 * stays open with the selection intact; a success is the only close.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@design-system";
import { t } from "../../i18n";
import type { SpaBoot } from "../boot";
import { StepDialog } from "../components/StepDialog";
import { NoticeRegion, type OpNotice } from "./PageNotice";

/** The store's per-declaration ceiling; the server refuses anything above it. */
export const MAX_PROVIDER_MODEL_IDS = 32;

export function ProviderModelsDialog({
  locale,
  open,
  onOpenChange,
  provider,
  label,
  storedModelIds,
  catalogModelIds,
  onSettings,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider id the settings POST names. */
  provider: string;
  /** The group's display label — the dialog title's subject. */
  label: string;
  /** The declaration's stored ids — the selection seed. */
  storedModelIds: readonly string[];
  /** The catalog vocabulary for the provider. */
  catalogModelIds: readonly string[];
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
}) {
  // Catalog order first, then stored ids the catalog no longer lists (older
  // declarations) — listed and checked, never silently dropped.
  const allIds = [
    ...catalogModelIds,
    ...storedModelIds.filter((id) => !catalogModelIds.includes(id)),
  ];
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(storedModelIds));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const inFlight = useRef(false);

  // Opening re-seeds from the stored list: the declaration is the source of
  // truth, and a cancelled earlier edit must not leak into the next open.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(storedModelIds));
    setQuery("");
    setNotice(null);
  }, [open, storedModelIds]);

  const needle = query.trim().toLowerCase();
  const filtered = needle === "" ? allIds : allIds.filter((id) => id.toLowerCase().includes(needle));
  const atCap = selected.size >= MAX_PROVIDER_MODEL_IDS;

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_PROVIDER_MODEL_IDS) {
        next.add(id);
      }
      return next;
    });
  }

  function selectAll(): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of allIds) {
        if (next.size >= MAX_PROVIDER_MODEL_IDS) break;
        next.add(id);
      }
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (inFlight.current || selected.size === 0) return;
    inFlight.current = true;
    setBusy(true);
    try {
      let outcome: OpNotice;
      try {
        outcome = await onSettings({
          op: "update-provider-models",
          provider,
          model_ids: [...selected].join(","),
        });
      } catch {
        outcome = { kind: "error", message: t(locale, "settings.providers.submitFailed") };
      }
      if (outcome.kind !== "success") {
        setNotice(outcome);
        return;
      }
      setNotice(null);
      onOutcome(outcome);
      onOpenChange(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <StepDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(locale, "settings.providers.models.title", { label })}
      description={t(locale, "settings.providers.models.counter", {
        selected: selected.size,
        max: MAX_PROVIDER_MODEL_IDS,
      })}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => setSelected(new Set())} disabled={busy}>
            {t(locale, "settings.providers.models.selectNone")}
          </Button>
          <Button type="button" variant="outline" onClick={selectAll} disabled={busy || atCap}>
            {t(locale, "settings.providers.models.selectAll")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t(locale, "common.cancel")}
          </Button>
          <Button type="submit" form="provider-models-form" disabled={busy || selected.size === 0}>
            {busy ? t(locale, "settings.providers.saving") : t(locale, "settings.providers.models.save")}
          </Button>
        </>
      }
    >
      <form
        id="provider-models-form"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <NoticeRegion notice={notice} />
        {atCap ? (
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.providers.models.capReached", { max: MAX_PROVIDER_MODEL_IDS })}
          </p>
        ) : null}
        <Input
          type="search"
          aria-label={t(locale, "settings.providers.models.searchLabel")}
          placeholder={t(locale, "settings.providers.models.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.providers.models.noMatch", { query })}
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-(--radius-control) border border-(--border-default) bg-(--surface-inset) px-3 py-2">
            {filtered.map((id) => {
              const checked = selected.has(id);
              return (
                <li key={id}>
                  {/* The house checkbox: native input, accent tone (the allowlist switch). */}
                  <label className="flex items-center gap-2 font-mono text-xs">
                    <input
                      type="checkbox"
                      className="size-4 accent-(--tone-accent-solid)"
                      checked={checked}
                      disabled={!checked && atCap}
                      onChange={() => toggle(id)}
                    />
                    <span>{id}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </form>
    </StepDialog>
  );
}
