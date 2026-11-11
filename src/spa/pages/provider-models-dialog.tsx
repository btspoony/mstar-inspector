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
import { t, type DictionaryKey } from "../../i18n";
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
  return {
    contextWindow: meta?.contextWindow === undefined ? "" : String(meta.contextWindow),
    maxTokens: meta?.maxTokens === undefined ? "" : String(meta.maxTokens),
    name: meta?.name ?? "",
    reasoning: meta?.reasoning === undefined ? "" : meta.reasoning ? "true" : "false",
    input: meta?.input === undefined ? "" : meta.input.join(", "),
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
   * The metadata statement this form carries. A save that states nothing sends
   * NO field at all — the plain id-list save, which leaves an id-only
   * declaration saved-but-not-usable instead of inventing a size. As soon as
   * one fact is stated the overlay is posted, and the server refuses any
   * selected model that does not carry both required sizes.
   */
  function overlayStatement(): string | null {
    const meta: CustomProviderModelsMeta = {};
    let stated = false;
    for (const id of selected) {
      const state = stateOf(id);
      const entry: Record<string, unknown> = {};
      let entryStated = false;
      for (const key of ["contextWindow", "maxTokens"] as const) {
        const text = state[key].trim();
        if (text === "") continue;
        entryStated = true;
        const value = Number(text);
        // A non-numeric entry travels as typed so the server names the field
        // rather than the dialog dropping it silently.
        entry[key] = Number.isFinite(value) ? value : text;
      }
      if (state.name.trim() !== "") {
        entryStated = true;
        entry.name = state.name.trim();
      }
      if (state.reasoning !== "") {
        entryStated = true;
        entry.reasoning = state.reasoning === "true";
      }
      if (state.input.trim() !== "") {
        entryStated = true;
        entry.input = state.input
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "");
      }
      if (!entryStated) continue;
      meta[id] = entry as CustomProviderModelMeta;
      stated = true;
    }
    return stated ? JSON.stringify(meta) : null;
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
      const modelsMeta = overlayStatement();
      let outcome: OpNotice;
      try {
        outcome = await onSettings({
          op: "update-provider-models",
          provider,
          model_ids: [...selected].join(","),
          ...(modelsMeta === null ? {} : { models_meta: modelsMeta }),
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
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">
              {t(locale, "settings.providers.models.requirements")}
            </legend>
            {incomplete ? (
              <p className="text-sm text-muted-foreground">
                {t(locale, "settings.providers.models.notUsable")}
              </p>
            ) : null}
            <ul className="flex flex-col gap-3">
              {[...selected].map((id) => {
                const state = stateOf(id);
                const label = (key: DictionaryKey) => t(locale, key, { model: id });
                return (
                  <li
                    key={id}
                    className="rounded-(--radius-control) border border-(--border-default) bg-(--surface-inset) px-3 py-2"
                  >
                    <p className="font-mono text-xs">{id}</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <Input
                        inputMode="numeric"
                        aria-label={label("settings.providers.models.fields.contextWindow")}
                        placeholder={t(locale, "settings.providers.models.fields.contextWindowHint")}
                        value={state.contextWindow}
                        onChange={(event) => setField(id, "contextWindow", event.target.value)}
                      />
                      <Input
                        inputMode="numeric"
                        aria-label={label("settings.providers.models.fields.maxTokens")}
                        placeholder={t(locale, "settings.providers.models.fields.maxTokensHint")}
                        value={state.maxTokens}
                        onChange={(event) => setField(id, "maxTokens", event.target.value)}
                      />
                      <Input
                        type="text"
                        aria-label={label("settings.providers.models.fields.name")}
                        placeholder={t(locale, "settings.providers.models.fields.nameHint")}
                        value={state.name}
                        onChange={(event) => setField(id, "name", event.target.value)}
                      />
                      <Input
                        type="text"
                        aria-label={label("settings.providers.models.fields.input")}
                        placeholder={t(locale, "settings.providers.models.fields.inputHint")}
                        value={state.input}
                        onChange={(event) => setField(id, "input", event.target.value)}
                      />
                      <select
                        aria-label={label("settings.providers.models.fields.reasoning")}
                        className="h-9 rounded-(--radius-control) border border-(--border-default) bg-(--surface-page) px-2 text-sm"
                        value={state.reasoning}
                        onChange={(event) => setField(id, "reasoning", event.target.value)}
                      >
                        <option value="">{t(locale, "settings.providers.models.fields.reasoningUnset")}</option>
                        <option value="true">{t(locale, "settings.providers.models.fields.reasoningYes")}</option>
                        <option value="false">{t(locale, "settings.providers.models.fields.reasoningNo")}</option>
                      </select>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
      </form>
    </StepDialog>
  );
}
