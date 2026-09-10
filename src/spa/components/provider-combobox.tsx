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
 * listbox panel with role=option rows, ArrowDown/ArrowUp walking an
 * active-descendant highlight across the filtered rows with Enter to select
 * (task-3 review fix: 「可选」 must be keyboard-reachable) and Esc /
 * Tab / outside-click to dismiss (the full ARIA 1.2 pattern is still not
 * required; the highlight scrolls into view — QC fix round).
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
 * Deterministic option-row id — the aria-activedescendant bridge between the
 * combobox input and the panel rows. The panel renders it on every option;
 * the shell points the input at the highlighted one. Both call this, so the
 * two sides cannot drift.
 */
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
  /** id of the keyboard-highlighted row (rendered via bg-accent). */
  activeId?: string;
  /** Hover sync: the pointer moving over a row moves the highlight. */
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
      // Carries the listbox id so the input's aria-controls never dangles in
      // the zero-match state (task-3 review fix).
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
                  aria-disabled={unavailable || undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-sm select-none hover:bg-accent",
                    activeId === rowId && "bg-accent",
                    unavailable && "pointer-events-none opacity-50",
                  )}
                  onMouseMove={() => onHoverOption?.(provider.id)}
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
 * Focus, click, typing, or an arrow key opens the list; Esc, Tab, an option
 * pick, or a pointerdown outside the root closes it. ArrowDown/ArrowUp move
 * the active-descendant highlight across the filtered rows and Enter selects
 * it, so 「可选」 is keyboard-reachable (task-3 review fix); a highlight
 * change scrolls the row into view inside the height-capped list (QC fix
 * round). The selected entry
 * is surfaced by the check mark on its row (and by AddProviderSection's form
 * heading) — the input itself stays a query field and clears on selection.
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
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // The keyboard highlight walks the FILTERED rows in the panel's render
  // order (common block, then catalog block) — derived from the same pure
  // filter/group helpers the panel renders with, so the two cannot drift.
  const groups = groupCatalogProviders(filterCatalogProviders(providers, query));
  const visible = [...groups.common, ...groups.catalog];
  const active = visible[activeIndex];

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

  // The keyboard highlight stays visible (QC fix round): the list is capped
  // at max-h-72 with an internal scroll and arrow defaults are prevented, so
  // without this an ArrowDown past the fold moves the highlight (and a
  // following Enter commits) to a row the user cannot see — the replaced
  // Radix Select auto-scrolled its active item. Same id bridge as
  // aria-activedescendant. Client-only: effects never run during SSR, so the
  // static-markup tests stay clean and the pure panel stays effect-free.
  useEffect(() => {
    if (!open || !active) return;
    document.getElementById(optionId(listboxId, active.id))?.scrollIntoView({ block: "nearest" });
  }, [open, active, listboxId]);

  function select(id: string) {
    onValueChange(id);
    setQuery("");
    // The query re-narrows the list — the highlight resets to the first
    // match with it.
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
        // Click re-opens after an Esc: focus is already on the input, so
        // onFocus alone never re-fires (task-3 review fix).
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          // Every keystroke re-narrows the list — reset the highlight to the
          // first match.
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          // Tab moves focus out: collapse first so the overlay and
          // aria-expanded don't go stale (QC fix round). In keydown, so it
          // runs before the default focus move; no preventDefault — focus
          // still advances (and a keydown sidesteps the blur-before-click
          // trap that a blur-based close would hit on row clicks).
          if (event.key === "Tab") setOpen(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              // Arrows open the list standalone (the replaced Radix Select
              // was keyboard-operable): ArrowDown lands on the first match,
              // ArrowUp on the last.
              setActiveIndex(event.key === "ArrowDown" ? 0 : Math.max(visible.length - 1, 0));
              setOpen(true);
            } else if (visible.length > 0) {
              // Walk the highlight, clamped to the filtered list bounds
              // (both group blocks, in panel render order).
              setActiveIndex((index) =>
                event.key === "ArrowDown"
                  ? Math.min(index + 1, visible.length - 1)
                  : Math.max(index - 1, 0),
              );
            }
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            // Same inert rule as the pointer path: an unavailable row never
            // selects (plan-46 red line at every layer).
            if (active && active.eligibility !== "unavailable") select(active.id);
          }
        }}
      />
      {open ? (
        // Height cap mirrors the old SelectContent max-h-72 (plan-42 pin):
        // an internal scroll keeps the 214-entry breadth usable.
        <div className="relative">
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-(--shadow-pop)">
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
