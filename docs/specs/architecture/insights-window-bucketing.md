# Architecture: insights window bucketing

## Scope

The shared window-to-bucket contract for `findings_distribution`, `weekly_trend`, `daily_trend`, and their SPA display mirrors.

## Current state

### Window semantics

- `windowDays` is integer days, default 30. Values >90 are clamped to 90 by `clampWindow` at the store entry, the only clamp point; downstream queries bind the clamped value.
- Non-integers and negative values receive route 400; the store does not revalidate.
- All aggregations share the window predicate `reviews.reviewed_at >= datetime('now', '-' || ? || ' days')` plus era gate `r.envelope IS NOT NULL`.

### Granularity

- Clamped `windowDays > 30` means `"week"`; otherwise `"day"`. UI 7/30-day segments use days; 90 days uses weeks; direct 31–89-day URLs also use weeks.
- Day expression: UTC `date(r.reviewed_at)`, in the same UTC domain as the window predicate.
- Week expression: the single Monday-anchored `WEEK_BUCKET_SQL`; JavaScript mirrors it with `mondayOf` / `weekGrid`, synchronized by concrete-date pins.

### Wire and filling semantics

| Wire key | Granularity | Filling | Count semantics | Contract |
|---|---|---|---|---|
| `weekly_trend` | Always weeks, for any window | Raw SQL output; no zero fill; absent weeks omitted | reviews = `COUNT(DISTINCT r.id)` through LEFT JOIN, so a review without findings counts as 1; findings = `COUNT(f.id)` | Stable existing key |
| `findings_distribution` | Window-derived day or week | JS `dayGrid`/`weekGrid` zero fill, union observed bucket starts, partial first/last buckets, grid ordering | `by_severity` zero-filled grid only; no `by_category` | Stable single-series contract |
| `daily_trend` | Days only when clamped window ≤30; week windows return `[]` without running a query | `dayGrid` zero fill, union observed day starts, grid ordering | Same review/finding counts as `weekly_trend`, using days | Additive daily key |

- Daily rows: `{ day_start: string; reviews: number; findings: number }`, matching weekly rows with `week_start`.
- The 90-day trend card reads `weekly_trend`, not duplicated weekly data. SPA display zero-fills it using the payload `findings_distribution.bucket_start` grid; no API key changes.
- Category names are model-produced open-set free slugs, unstable across providers; their union is not a comparable metric. `by_category` is absent. Recurrence likewise has no stable cross-repository App-level meaning. Window predicates, granularity, grids and trend row shapes are unchanged by that exclusion.

### SPA mirrors

- `parseInsights` requires aggregation keys; missing/malformed data falls back to null. Only opt-in `repos` tolerates absence; `daily_trend` is required.
- SPA granularity mirrors `data.window_days > 30`, using the effective clamped wire echo. The intentional mirror is documented; SPA does not import a dashboard leaf or require a shared module.
- Chart x-axis uses `formatDateLabel` fixed `M/D` in every locale. Above 8 buckets, label every other bucket, always the first. `TrendChart` and `StackedBarChart` both declare `X_LABEL_MAX_VISIBLE = 8`; changes must synchronize both.

## Invariants

- Never introduce a second SQL or JavaScript day/week definition.
- All consumers use the one clamped window and Monday-anchored grid.
- Review counts include zero-finding reviews; findings count actual finding rows.

## Where it lives

- `src/dashboard/insights-store.ts`: `clampWindow`, `WEEK_BUCKET_SQL`, shared predicates and aggregation queries.
- `src/dashboard/insights-dates.ts`: `mondayOf`, `dayGrid`, `weekGrid`.
- `src/spa/pages/data.ts`: `parseInsights` and wire guards.
- `src/spa/components/charts/TrendChart.tsx`, `src/spa/components/charts/StackedBarChart.tsx`: display grids and label cadence.
- `tests/dashboard/insights-store.test.ts`: bucket/count/grid pins.

## Change obligations

New time-bucket faces reuse `WEEK_BUCKET_SQL` / `date()` and `dayGrid` / `weekGrid`, derive granularity from the clamped window, add an additive wire key, required parser field and row guards. Any shape, filling or count change to a stable key requires explicit architecture review, never an incidental implementation change.
