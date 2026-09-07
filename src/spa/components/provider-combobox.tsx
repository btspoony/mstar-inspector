/**
 * Plan 54 (AD-542): the hand-rolled filterable provider combobox — the Add
 * Provider picker. The 214-entry catalog outgrew a plain Select, so the
 * picker is an input that narrows options as you type (case-insensitive
 * substring over label + id), with the 常用提供方 common tier grouped first
 * and the remaining entries under 目录模板 (grouping reads `display_group`
 * — display only; form/config branching keeps keying on tier/eligibility,
 * AD-547 red line).
 *
 * Deliberately hand-written at the components/ top level (the hand-written
 * layer — AppSidebar.tsx precedent), NOT in vendored components/ui/ (shadcn
 * copy-in only): Radix Select cannot host a free-typed query and cmdk is out
 * of scope (zero new dependencies, AD-542 lock). Accessibility follows the
 * ARIA combobox pattern at the plan-54 QA minimum bar: a typeable input
 * (role=combobox with aria-expanded/aria-controls/aria-autocomplete), a
 * listbox panel with role=option rows, Esc and outside-click to dismiss
 * (full keyboard traversal is explicitly not required by plan 54).
 *
 * Unavailable entries stay listed and marked (`aria-disabled` + the
 * "unavailable on {image}" suffix) in BOTH groups — selecting one is a no-op,
 * and the AddProviderSection gate plus the server-side eligibility pre-check
 * (plan-46) keep them unsaveable.
 */
import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { t, type Locale } from "../../i18n";
import type { CatalogProvider } from "../pages/data";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The pure filter (AD-542): case-insensitive substring match over the
 * entry's label or id. An empty/whitespace query keeps the full list in
 * payload order. Unavailable entries are never dropped here — they stay
 * visible (marked at render) so the breadth stays discoverable (plan 38).
 */
export function filterCatalogProviders(
  providers: readonly CatalogProvider[],
  query: string,
): CatalogProvider[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...providers];
  return providers.filter(
    (provider) =>
      provider.label.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle),
  );
}

/**
 * The pure display grouping (plan 54, AD-547): `common` (常用提供方) first,
 * `catalog` (目录模板) second, payload order preserved within each group.
 * Reads ONLY `display_group` — `tier`/`eligibility` stay the mechanics' keys.
 */
export function groupCatalogProviders(providers: readonly CatalogProvider[]): {
  common: CatalogProvider[];
  catalog: CatalogProvider[];
} {
  const common: CatalogProvider[] = [];
  const rest: CatalogProvider[] = [];
  for (const provider of providers) {
    (provider.display_group === "common" ? common : rest).push(provider);
  }
  return { common, catalog: rest };
}

/**
 * The open listbox face — pure (no state, no effects), exported so the tests
 * can pin grouping order, filtering, and unavailable marking through static
 * SSR (the AppInfoCard precedent). The stateful combobox renders it beneath
 * the input while open.
 */
export function ProviderComboboxPanel({
  locale,
  providers,
  query,
  value,
  imageId,
  listboxId,
  onSelect,
}: {
  locale: Locale;
  providers: readonly CatalogProvider[];
  query: string;
  value: string | undefined;
  imageId: string;
  listboxId: string;
  onSelect: (id: string) => void;
}) {
  const matches = filterCatalogProviders(providers, query);
  const groups = groupCatalogProviders(matches);
  const headed = [
    { key: "common" as const, label: t(locale, "settings.catalogBuiltin"), rows: groups.common },
    { key: "catalog" as const, label: t(locale, "settings.catalogTemplate"), rows: groups.catalog },
  ];
  const total = groups.common.length + groups.catalog.length;

  if (total === 0) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">
        {t(locale, "settings.noProviderMatch", { query: query.trim() })}
      </p>
    );
  }
  return (
    <div role="listbox" id={listboxId}>
      {headed.map(({ key, label, rows }) =>
        rows.length === 0 ? null : (
          <div key={key} role="group" aria-label={label}>
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{label}</div>
            {rows.map((provider) => {
              const unavailable = provider.eligibility === "unavailable";
              return (
                <div
                  key={provider.id}
                  role="option"
                  aria-selected={provider.id === value}
                  aria-disabled={unavailable || undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-sm select-none hover:bg-accent",
                    unavailable && "pointer-events-none opacity-50",
                  )}
                  onClick={() => {
                    // Unavailable stays unsaveable at every layer (plan-46):
                    // the row is inert here, gated again in AddProviderSection
                    // (no form), and pre-checked server-side on save.
                    if (!unavailable) onSelect(provider.id);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {provider.label}
                    {unavailable
                      ? ` — ${t(locale, "settings.eligibilityUnavailableShort", { image: imageId })}`
                      : ""}
                  </span>
                  {provider.id === value ? (
                    <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
                  ) : null}
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The stateful combobox shell: query + open state around the pure panel.
 * Focus or typing opens the list; Esc, an option pick, or a pointerdown
 * outside the root closes it. The selected entry is surfaced by the check
 * mark on its row (and by AddProviderSection's form heading) — the input
 * itself stays a query field and clears on selection.
 */
export function ProviderCombobox({
  locale,
  labelledby,
  providers,
  value,
  onValueChange,
  imageId,
}: {
  locale: Locale;
  /** id of the visible field label (plan-38 aria-labelledby precedent). */
  labelledby: string;
  providers: readonly CatalogProvider[];
  value: string | undefined;
  onValueChange: (id: string | undefined) => void;
  imageId: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Outside-click dismiss (QA minimum bar). Client-only: effects never run
  // during SSR, so the static-markup tests stay clean.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function select(id: string) {
    onValueChange(id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-1">
      <Input
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-labelledby={labelledby}
        placeholder={t(locale, "settings.selectProvider")}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />
      {open ? (
        // Height cap mirrors the old SelectContent max-h-72 (plan-42 pin):
        // an internal scroll keeps the 214-entry breadth usable.
        <div className="relative">
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <ProviderComboboxPanel
              locale={locale}
              providers={providers}
              query={query}
              value={value}
              imageId={imageId}
              listboxId={listboxId}
              onSelect={select}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
