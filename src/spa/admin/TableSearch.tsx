/**
 * Client-side table filter: one search input above a
 * DataTable plus the "shown / total" counter. The page owns the query state
 * and the filtering — this renders the controls only. No URL state, no
 * request: the filter runs over the already-loaded rows.
 */
import { Input } from "@design-system";
import { t, type DictionaryKey } from "../../i18n";
import type { Locale } from "../../i18n";

export function TableSearch({
  locale,
  value,
  onChange,
  shown,
  total,
  placeholderKey,
}: {
  locale: Locale;
  value: string;
  onChange: (value: string) => void;
  shown: number;
  total: number;
  placeholderKey: DictionaryKey;
}) {
  const placeholder = t(locale, placeholderKey);
  return (
    <div className="flex items-center gap-3">
      <Input
        type="search"
        className="max-w-xs"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="text-sm tabular-nums text-muted-foreground">
        {t(locale, "admin.search.counter", { shown, total })}
      </span>
    </div>
  );
}
