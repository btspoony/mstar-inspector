/**
 * The model picker: which model ids of an already-configured provider the App
 * exposes (the `update-provider-models` settings op). The stored declaration
 * is the seed — a stored id the catalog no longer lists stays listed and
 * checked, never silently dropped. At least one id must stay selected, and
 * the model-id cap (MAX_CUSTOM_PROVIDER_MODEL_IDS, src/contracts/provider-models.ts)
 * is enforced client-side: an unchecked box is unavailable at the cap, and the
 * server still refuses an over-limit write.
 *
 * Busy state, the disabled save and the failure contract are this dialog's —
 * `StepDialog` owns only the shell. Like the add-key flow, a failed submit
 * stays open with the selection intact; a success is the only close.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@design-system";
import { t } from "../../i18n";
import { MAX_CUSTOM_PROVIDER_MODEL_IDS } from "../../contracts/provider-models";
import type { SpaBoot } from "../boot";
import { StepDialog } from "../components/StepDialog";
import type { CustomProviderModelMeta, CustomProviderModelsMeta } from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";

/**
 * What the owner typed for ONE selected model. Strings, never numbers: a blank
 * field is the absent fact (we do not guess), and a value that is not a whole
 * number is sent as typed so the server names the field instead of silently
 * dropping it.
 */
type FieldState = {
  contextWindow: string;
  maxTokens: string;
  name: string;
  /** "" = not stated (distinct from an explicit no), "true" / "false" = stated. */
  reasoning: "" | "true" | "false";
  input: string;
};

function fieldStateOf(meta: CustomProviderModelMeta | undefined): FieldState {
  // Canonical "unset" is an ABSENT field (the store's read boundary normalizes
  // any legacy null away). The null checks stay as the last line of defence at
  // THIS boundary: a null must render blank, never as "No reasoning".
  const size = (value: number | null | undefined): string => (value === undefined || value === null ? "" : String(value));
  return {
    contextWindow: size(meta?.contextWindow),
    maxTokens: size(meta?.maxTokens),
    name: meta?.name ?? "",
    reasoning: meta?.reasoning === undefined || meta.reasoning === null ? "" : meta.reasoning ? "true" : "false",
    input: meta?.input?.join(", ") ?? "",
  };
}

function seedFields(ids: readonly string[], meta: CustomProviderModelsMeta | undefined): Record<string, FieldState> {
  const fields: Record<string, FieldState> = {};
  for (const id of ids) fields[id] = fieldStateOf(meta?.[id]);
  return fields;
}

export function ProviderModelsDialog({
  locale,
  open,
  onOpenChange,
  provider,
  label,
  storedModelIds,
  storedModelsMeta,
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
  /** The owner's stored per-model facts — the field seed (absent = unstated). */
  storedModelsMeta?: CustomProviderModelsMeta;
  /** The catalog vocabulary for the provider. */
  catalogModelIds: readonly string[];
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
}) {
  // Catalog order first, then stored ids the catalog no longer lists (older
  // declarations) — listed and checked, never silently dropped. The Set also
  // folds duplicate stored ids into one row: the write path never deduped.
  const allIds = [...new Set([...catalogModelIds, ...storedModelIds])];
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(storedModelIds));
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    seedFields(storedModelIds, storedModelsMeta),
  );
  const [query, setQuery] = useState("");
  // The detail editor is folded away by default: the selection list is the
  // dialog's business, and the per-model facts are an optional second step.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const inFlight = useRef(false);

  // Opening re-seeds from the stored list: the declaration is the source of
  // truth, and a cancelled earlier edit must not leak into the next open.
  // Seed exactly once per open transition — background reloads hand us a
  // fresh storedModelIds identity while open and must not wipe the
  // in-progress selection.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setSelected(new Set(storedModelIds));
    setFields(seedFields(storedModelIds, storedModelsMeta));
    setQuery("");
    setDetailsOpen(false);
    setDetailsFor(null);
    setNotice(null);
  }, [open, storedModelIds, storedModelsMeta]);

  const needle = query.trim().toLowerCase();
  const filtered = needle === "" ? allIds : allIds.filter((id) => id.toLowerCase().includes(needle));
  const atCap = selected.size >= MAX_CUSTOM_PROVIDER_MODEL_IDS;
  // Any selected model whose statement lacks a required size: the row is
  // usable only when the owner stated both, and we never guess them.
  const incomplete = [...selected].some((id) => {
    const state = stateOf(id);
    return state.contextWindow.trim() === "" || state.maxTokens.trim() === "";
  });
  // Select-all acts on the rendered list, so it has nothing to do once every
  // visible id is checked — the cap alone never disables it.
  const allFilteredSelected = filtered.every((id) => selected.has(id));
  // The detail editor always shows exactly one selected model; a stale choice
  // (its id was just unchecked) falls back to the first selected id.
  const selectedIds = [...selected];
  const detailId = detailsFor !== null && selected.has(detailsFor) ? detailsFor : (selectedIds[0] ?? "");
  const detailState = stateOf(detailId);

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_CUSTOM_PROVIDER_MODEL_IDS) {
        next.add(id);
      }
      return next;
    });
  }

  /** The typed state of one selected model (a never-touched id seeds from store). */
  function stateOf(id: string): FieldState {
    return fields[id] ?? fieldStateOf(storedModelsMeta?.[id]);
  }

  function setField(id: string, key: keyof FieldState, value: string): void {
    setFields((current) => ({
      ...current,
      [id]: { ...(current[id] ?? fieldStateOf(storedModelsMeta?.[id])), [key]: value },
    }));
  }

  /**
   * The metadata statement this form carries. ALWAYS posted, one entry per
   * selected id, blanks simply absent from their entry: an omitted field would
   * read as "no statement" and let a save change the id set while never
   * stating the sizes the product requires. The server refuses the first
   * selected model that lacks one, naming it.
   */
  function overlayStatement(): string {
    const meta: CustomProviderModelsMeta = {};
    for (const id of selected) {
      const state = stateOf(id);
      const entry: Record<string, unknown> = {};
      for (const key of ["contextWindow", "maxTokens"] as const) {
        const text = state[key].trim();
        if (text === "") continue;
        const value = Number(text);
        // A non-numeric entry travels as typed so the server names the field
        // rather than the dialog dropping it silently.
        entry[key] = Number.isFinite(value) ? value : text;
      }
      if (state.name.trim() !== "") entry.name = state.name.trim();
      if (state.reasoning !== "") entry.reasoning = state.reasoning === "true";
      if (state.input.trim() !== "") {
        entry.input = state.input
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "");
      }
      meta[id] = entry as CustomProviderModelMeta;
    }
    return JSON.stringify(meta);
  }

  function selectAll(): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of filtered) {
        if (next.size >= MAX_CUSTOM_PROVIDER_MODEL_IDS) break;
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
          models_meta: overlayStatement(),
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
        max: MAX_CUSTOM_PROVIDER_MODEL_IDS,
      })}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => setSelected(new Set())} disabled={busy}>
            {t(locale, "settings.providers.models.selectNone")}
          </Button>
          <Button type="button" variant="outline" onClick={selectAll} disabled={busy || allFilteredSelected}>
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
            {t(locale, "settings.providers.models.capReached", { max: MAX_CUSTOM_PROVIDER_MODEL_IDS })}
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
        {selected.size === 0 ? null : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="self-start text-sm font-medium text-(--tone-accent-fg)"
              aria-expanded={detailsOpen}
              // The region mounts only while open, so the control never names a
              // missing element (the combobox precedent).
              aria-controls={detailsOpen ? "provider-models-details" : undefined}
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              {t(locale, "settings.providers.models.detailsToggle")}
            </button>
            {detailsOpen ? (
              <div
                id="provider-models-details"
                className="flex flex-col gap-3 rounded-(--radius-control) border border-(--border-default) bg-(--surface-inset) px-3 py-2"
              >
                <p className="text-sm text-muted-foreground">
                  {t(locale, "settings.providers.models.requirements")}
                </p>
                {incomplete ? (
                  <p className="text-sm text-muted-foreground">
                    {t(locale, "settings.providers.models.sizesUnstated")}
                  </p>
                ) : null}
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  {t(locale, "settings.providers.models.detailsSelectLabel")}
                  <select
                    className="h-9 rounded-(--radius-control) border border-(--border-default) bg-(--surface-page) px-2 text-sm"
                    value={detailId}
                    onChange={(event) => setDetailsFor(event.target.value)}
                  >
                    {selectedIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    inputMode="numeric"
                    aria-label={t(locale, "settings.providers.models.fields.contextWindow", { model: detailId })}
                    placeholder={t(locale, "settings.providers.models.fields.contextWindowHint")}
                    value={detailState.contextWindow}
                    onChange={(event) => setField(detailId, "contextWindow", event.target.value)}
                  />
                  <Input
                    inputMode="numeric"
                    aria-label={t(locale, "settings.providers.models.fields.maxTokens", { model: detailId })}
                    placeholder={t(locale, "settings.providers.models.fields.maxTokensHint")}
                    value={detailState.maxTokens}
                    onChange={(event) => setField(detailId, "maxTokens", event.target.value)}
                  />
                  <Input
                    type="text"
                    aria-label={t(locale, "settings.providers.models.fields.name", { model: detailId })}
                    placeholder={t(locale, "settings.providers.models.fields.nameHint")}
                    value={detailState.name}
                    onChange={(event) => setField(detailId, "name", event.target.value)}
                  />
                  <Input
                    type="text"
                    aria-label={t(locale, "settings.providers.models.fields.input", { model: detailId })}
                    placeholder={t(locale, "settings.providers.models.fields.inputHint")}
                    value={detailState.input}
                    onChange={(event) => setField(detailId, "input", event.target.value)}
                  />
                  <select
                    aria-label={t(locale, "settings.providers.models.fields.reasoning", { model: detailId })}
                    className="h-9 rounded-(--radius-control) border border-(--border-default) bg-(--surface-page) px-2 text-sm"
                    value={detailState.reasoning}
                    onChange={(event) => setField(detailId, "reasoning", event.target.value)}
                  >
                    <option value="">{t(locale, "settings.providers.models.fields.reasoningUnset")}</option>
                    <option value="true">{t(locale, "settings.providers.models.fields.reasoningYes")}</option>
                    <option value="false">{t(locale, "settings.providers.models.fields.reasoningNo")}</option>
                  </select>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </form>
    </StepDialog>
  );
}
