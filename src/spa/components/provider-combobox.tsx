import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { t, type Locale } from "../../i18n";
import type { CatalogProvider } from "../pages/data";
import { Input, cn } from "@design-system";

/**
 * The pure filter (AD-542): case-insensitive substring match over the
 * entry's label or id. An empty/whitespace query keeps the full list in
 * payload order. Unavailable entries are never dropped here — they stay
 * visible (marked at render) so the breadth stays discoverable.
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
 * The pure display grouping (AD-547): `common` (常用提供方) first,
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

function optionId(listboxId: string, providerId: string): string {
  return `${listboxId}-option-${providerId}`;
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
  activeId,
  onHoverOption,
}: {
  locale: Locale;
  providers: readonly CatalogProvider[];
  query: string;
  value: string | undefined;
  imageId: string;
  listboxId: string;
  onSelect: (id: string) => void;
  activeId?: string;
  onHoverOption?: (providerId: string) => void;
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
      <p id={listboxId} className="px-2 py-1.5 text-sm text-muted-foreground">
        {t(locale, "settings.noProviderMatch", { query: query.trim() })}
      </p>
    );
  }
  return (
    <div role="listbox" id={listboxId}>
      {headed.map(({ key, label, rows }) =>
        rows.length === 0 ? null : (
          <div key={key} role="group" aria-label={label}>
            <div className="px-2 py-1.5 text-xs tracking-(--typo-label-12-tracking) text-muted-foreground">{label}</div>
            {rows.map((provider) => {
              const unavailable = provider.eligibility === "unavailable";
              const rowId = optionId(listboxId, provider.id);
              return (
                <div
                  key={provider.id}
                  id={rowId}
                  role="option"
                  aria-selected={provider.id === value}
                  data-active={activeId === rowId ? "true" : undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-sm select-none hover:bg-accent",
                    activeId === rowId && "bg-accent",
                    unavailable && "opacity-50",
                  )}
                  onMouseMove={() => onHoverOption?.(provider.id)}
                  onClick={() => onSelect(provider.id)}
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
 * Focus, click, typing, or an arrow key opens the list; Esc, Tab, an option
 * pick, or a pointerdown outside the root closes it. ArrowDown/ArrowUp move
 * the active-descendant highlight across the filtered rows and Enter selects
 * it, so 「可选」 is keyboard-reachable (task-3 review fix); a highlight
 * change scrolls the row into view inside the height-capped list (QC fix
 * round). The selected entry
 * is surfaced by the check mark on its row (and by the add-provider dialog's
 * configuration step) — the input itself stays a query field and clears on
 * selection.
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
  labelledby: string;
  providers: readonly CatalogProvider[];
  value: string | undefined;
  onValueChange: (id: string | undefined) => void;
  imageId: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const groups = groupCatalogProviders(filterCatalogProviders(providers, query));
  const visible = [...groups.common, ...groups.catalog];
  const active = visible[activeIndex];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || !active) return;
    document.getElementById(optionId(listboxId, active.id))?.scrollIntoView({ block: "nearest" });
  }, [open, active, listboxId]);

  function select(id: string) {
    onValueChange(id);
    setQuery("");
    setActiveIndex(0);
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
        aria-activedescendant={open && active ? optionId(listboxId, active.id) : undefined}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-labelledby={labelledby}
        placeholder={t(locale, "settings.selectProvider")}
        value={query}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Tab") setOpen(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              setActiveIndex(event.key === "ArrowDown" ? 0 : Math.max(visible.length - 1, 0));
              setOpen(true);
            } else if (visible.length > 0) {
              setActiveIndex((index) =>
                event.key === "ArrowDown"
                  ? Math.min(index + 1, visible.length - 1)
                  : Math.max(index - 1, 0),
              );
            }
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (active) select(active.id);
          }
        }}
      />
      {open ? (
        <div className="relative">
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-(--border-default) bg-popover p-1 text-popover-foreground shadow-(--shadow-pop)">
            <ProviderComboboxPanel
              locale={locale}
              providers={providers}
              query={query}
              value={value}
              imageId={imageId}
              listboxId={listboxId}
              onSelect={select}
              activeId={active ? optionId(listboxId, active.id) : undefined}
              onHoverOption={(id) => {
                const index = visible.findIndex((provider) => provider.id === id);
                if (index >= 0) setActiveIndex(index);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
