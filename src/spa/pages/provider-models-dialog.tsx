import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@design-system";
import { t } from "../../i18n";
import { MAX_CUSTOM_PROVIDER_MODEL_IDS, resolveModelSize } from "../../contracts/provider-models";
import type { ModelSize, ModelSizeSource } from "../../contracts/provider-models";

type SizeProvenance = ModelSizeSource | "mixed";
import type { SpaBoot } from "../boot";
import { StepDialog } from "../components/StepDialog";
import type { CustomProviderModelMeta, CustomProviderModelsMeta } from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";

type FieldState = {
  contextWindow: string;
  maxTokens: string;
  name: string;
  reasoning: "" | "true" | "false";
  input: string;
  fromCatalog: { contextWindow: boolean; maxTokens: boolean };
};

function fieldStateOf(meta: CustomProviderModelMeta | undefined, catalog: ModelSize | undefined): FieldState {
  const size = (value: number | null | undefined): string => (value === undefined || value === null ? "" : String(value));
  const resolved = resolveModelSize(meta, catalog);
  const unstated = (value: unknown): boolean => value === undefined || value === null;
  return {
    contextWindow: size(resolved.contextWindow),
    maxTokens: size(resolved.maxTokens),
    name: meta?.name ?? "",
    reasoning: meta?.reasoning === undefined || meta.reasoning === null ? "" : meta.reasoning ? "true" : "false",
    input: meta?.input?.join(", ") ?? "",
    fromCatalog: {
      contextWindow: unstated(meta?.contextWindow) && catalog?.contextWindow !== undefined,
      maxTokens: unstated(meta?.maxTokens) && catalog?.maxTokens !== undefined,
    },
  };
}

function seedFields(
  ids: readonly string[],
  meta: CustomProviderModelsMeta | undefined,
  catalogLimits: Record<string, ModelSize>,
): Record<string, FieldState> {
  const fields: Record<string, FieldState> = {};
  for (const id of ids) fields[id] = fieldStateOf(meta?.[id], catalogLimits[id]);
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
  catalogLimits,
  limitsSnapshot,
  onSettings,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: string;
  label: string;
  storedModelIds: readonly string[];
  storedModelsMeta?: CustomProviderModelsMeta;
  catalogModelIds: readonly string[];
  catalogLimits: Record<string, ModelSize>;
  limitsSnapshot: string;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
}) {
  const allIds = [...new Set([...catalogModelIds, ...storedModelIds])];
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(storedModelIds));
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    seedFields(storedModelIds, storedModelsMeta, catalogLimits),
  );
  const [query, setQuery] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const inFlight = useRef(false);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setSelected(new Set(storedModelIds));
    setFields(seedFields(storedModelIds, storedModelsMeta, catalogLimits));
    setQuery("");
    setDetailsOpen(false);
    setDetailsFor(null);
    setNotice(null);
  }, [open, storedModelIds, storedModelsMeta]);

  const needle = query.trim().toLowerCase();
  const filtered = needle === "" ? allIds : allIds.filter((id) => id.toLowerCase().includes(needle));
  const atCap = selected.size >= MAX_CUSTOM_PROVIDER_MODEL_IDS;
  const allFilteredSelected = filtered.every((id) => selected.has(id));
  const selectedIds = [...selected];
  const detailId = detailsFor !== null && selected.has(detailsFor) ? detailsFor : (selectedIds[0] ?? "");
  const detailState = stateOf(detailId);
  const detailSource = sourceOf(detailId);
  const catalogKnowsSizes = Object.keys(catalogLimits).length > 0;

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

  function stateOf(id: string): FieldState {
    return fields[id] ?? fieldStateOf(storedModelsMeta?.[id], catalogLimits[id]);
  }

  function setField(id: string, key: keyof FieldState, value: string): void {
    setFields((current) => {
      const base = current[id] ?? fieldStateOf(storedModelsMeta?.[id], catalogLimits[id]);
      const next = { ...base, [key]: value };
      if (key === "contextWindow" || key === "maxTokens") {
        next.fromCatalog = { ...base.fromCatalog, [key]: false };
      }
      return { ...current, [id]: next };
    });
  }

  function sourceOf(id: string): SizeProvenance {
    const state = stateOf(id);
    const fields = ["contextWindow", "maxTokens"] as const;
    const filled = fields.filter((field) => state[field].trim() !== "");
    if (filled.length === 0) return "absent";
    const fromCatalog = filled.filter((field) => state.fromCatalog[field]);
    if (fromCatalog.length === 0) return "declared";
    return fromCatalog.length === filled.length ? "catalog" : "mixed";
  }

  function overlayStatement(): string {
    const meta: CustomProviderModelsMeta = {};
    for (const id of selected) {
      const state = stateOf(id);
      const entry: Record<string, unknown> = {};
      for (const key of ["contextWindow", "maxTokens"] as const) {
        const text = state[key].trim();
        if (text === "") continue;
        if (state.fromCatalog[key]) continue;
        const value = Number(text);
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
      if (Object.keys(entry).length > 0) meta[id] = entry as CustomProviderModelMeta;
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
                {catalogKnowsSizes ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t(locale, "settings.providers.models.requirements")}
                    </p>
                    {detailSource === "absent" ? (
                      <p className="text-sm text-muted-foreground">
                        {t(locale, "settings.providers.models.sizesUnstated")}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t(locale, "settings.providers.models.sizesUnknownProvider")}
                  </p>
                )}
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
                </div>
                {detailSource === "catalog" ? (
                  <p className="text-xs text-muted-foreground">
                    {t(locale, "settings.providers.models.sizesFromCatalog", { snapshot: limitsSnapshot })}
                  </p>
                ) : detailSource === "declared" ? (
                  <p className="text-xs text-muted-foreground">
                    {t(locale, "settings.providers.models.sizesFromDeclaration")}
                  </p>
                ) : detailSource === "mixed" ? (
                  <p className="text-xs text-muted-foreground">
                    {t(locale, "settings.providers.models.sizesFromMixed", { snapshot: limitsSnapshot })}
                  </p>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
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
