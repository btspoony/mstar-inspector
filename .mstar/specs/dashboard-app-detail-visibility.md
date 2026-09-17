# Dashboard App-Detail Visibility & Per-App Insights

**Status:** draft — authored 2026-09-18 at the start of the dashboard App-detail visibility / per-App insights iteration; frozen by the pre-implementation Review & Edit chain.
**Scope:** `dev-dashboard` (SPA + dashboard routes) and `_default` (insights store, permission-matrix contracts).

## Problem statement

1. **Cross-App data exposure.** The global insights face (`/dashboard/insights` page + `GET /api/insights/summary`) is gated by membership only: every signed-in member sees aggregated audit data (repos, findings, verdicts) of **every** App on the deployment. Insights are per-App audit products; there is no legitimate global consumer among members.
2. **Detail read face over-exposes ops data.** On another member's App detail, a non-manager member sees the install health panel and recent deliveries. The product decision (PM, 2026-09-18): identity info is public to members; everything operational is not.
3. **IA mismatch.** `/dashboard/apps/:slug/settings` is titled "settings" but acts as the app detail page, and per-App insights have no home.

## Locked decisions (direction 2026-09-18)

| ID | Decision |
|----|----------|
| D2 | The global insights face is **removed entirely** (page, SPA route/nav, `GET /api/insights/summary`). No admin-only global variant exists: insights have no global concept. |
| D3 | `/dashboard/apps/:slug` becomes the **应用详情 (App detail)** page with exactly two tabs: **应用设置** (existing settings capability, unchanged) and **洞察** (per-App insights view). |
| D4 | A member who is neither the App creator nor an admin sees **GitHub App identity info only** on the detail face. The identity set: `slug`, `github_app_id`, `status`, `review_enabled`, `created_by`, `created_at` — the per-App fields the unchanged Apps list already shows, plus creation time — **and** the App's cached public GitHub profile (`github_name`, `github_description`, `github_html_url`, `github_avatar_url`, `github_metadata_synced_at`). Everything else in today's base payload — `installations`, `deliveries`, `delivery_summary`, `last_webhook_at`, `sandbox_image_id`, `review_trigger_mode`, the settings payload — moves behind the `canManageApp` branch; insights 403; every mutation 403. This narrows today's behavior (install health + deliveries were member-visible) and adds only `created_at` to the wire. |
| D5 | The insights tab (and its data endpoint) is **creator-or-admin** (`canManageApp`), consistent with D4. Members see insights for Apps they manage (their own, or any if admin). |
| D6 | The Apps list stays visible to all members with its current columns/payload; every row links into the detail page. The list renders no manage affordances today; any affordance added later must be `can_manage`-gated. |

## AuthZ matrix (normative end state)

| Surface | member (non-manager) | creator / admin |
|---|---|---|
| `GET /api/apps` (list) | visible (unchanged) | visible |
| App detail identity set (slug, github_app_id, status, review_enabled, created_by, created_at, cached public GitHub profile `github_*`) | visible | visible |
| Install health / delivery payload (`installations`, `deliveries`, `delivery_summary`, `last_webhook_at`) | **absent from payload** (narrowing vs today) | visible |
| Runtime/ops config fields (`sandbox_image_id`, `review_trigger_mode`) | **absent from payload** (narrowing vs today) | visible |
| Settings payload (keys, chains, providers, trigger mode) | hidden (`can_manage: false` shape) | visible (unchanged) |
| `GET /api/apps/:slug/insights/summary` | 403 | 200 |
| Mutations (disable/enable/delete, pause/resume, settings writes, key/delete) | 403 (unchanged) | allowed (unchanged) |
| Global insights page + `GET /api/insights/summary` | **removed for everyone** | removed |

Membership bootstrap, invite/remove/role flows, and the per-request membership guard are **unchanged**.

## IA (normative end state)

- `/dashboard/apps/:slug` → App detail page (two tabs as per D3). The SPA matcher owns the route: **one matcher entry (one page id)** serves both `/dashboard/apps/:slug` (default tab: 应用设置) and the legacy `/dashboard/apps/:slug/settings` (settings tab active); tab state derives from the path via the shared pure URL-state helpers. `/dashboard/apps` (exact) stays the Apps list. No second page and no second data face: both paths consume `GET /api/apps/:slug/settings`.
- The legacy `/settings` path is a **permanent** settings-tab deep link, not a temporary compat shim: the settings POST family's HTML-navigation 302 targets (`settings400Response`, `settingsPostResponse`, `reviewActionRedirect`'s settings-origin branch) are pinned to `/dashboard/apps/:slug/settings`, so the path keeps resolving for as long as those zero-JS form-navigation contracts exist. Removing the path instead would mean re-pinning every form-POST redirect — deliberately out of scope.
- The 洞察 tab renders only on the `can_manage: true` face; a non-manager sees the 应用设置 tab only (carrying the D4 identity-only content). "Exactly two tabs" is the manager face; the tab's absence for non-managers is pinned by tests.
- `/dashboard/insights` is removed from `SPA_PAGES`, the sidebar, and i18n nav keys. Deep links to it fall through the normal unknown-route behavior (no longer shell-served: an HTML GET falls past the SPA dispatch to the guarded dashboard app's 404, exactly like any other unknown `/dashboard` path).
- Sidebar: Apps and Members entries unchanged; the Insights entry is gone.
- Apps list: every row navigates to the detail page (row click, slug link, and row action all target `/dashboard/apps/:slug`); the row action's copy moves from settings semantics to detail semantics in both locales. The list renders no manage affordances today and must not grow any that are not `can_manage`-gated (D6 invariant); columns and the list payload are otherwise unchanged.

## Data faces

- `insights-store` gains an **optional `appId` filter** (the `github_apps.id` row PK — a string, not the numeric `github_app_id`) bound as `r.app_id = ?`. It is additive-only and applied to **both** WHERE faces inside the store: the shared WHERE (`whereSql`) used by every aggregation, **and** the opt-in window-scoped `repos` aggregation, which deliberately shares only the window+era predicates (`windowEraWhere`) and ignores `repo` today. Without the second composition the per-App endpoint's `repos` list would carry other Apps' repo names — the exact cross-App leak this spec removes. The existing zero-diff pin over time-bucket grids (knowledge: `d1-time-bucket-distribution-grids`) must keep holding when the filter is absent (both queries byte-identical); the era gate (`r.envelope IS NOT NULL`) and the single `WEEK_BUCKET_SQL` are untouched. Legacy `app_id IS NULL` rows are excluded by the filter, by design.
- `GET /api/apps/:slug/insights/summary` — query params `window` (integer days; >90 clamped to 90 at the store entry; non-integer/negative → 400), `repo` (optional `owner/repo`, within the App's reviews), and `include=repos` (opt-in window-scoped distinct repo list, **app-scoped** — it feeds the insights tab's repo selector; same opt-in semantics as the retired global face). Response reuses the existing summary shape (per-App population) and echoes the effective `window_days` (and `repo` when present) exactly as the retired global face did. Gate: the mount-level membership guard + route-local slug resolution (`requireAppVisible` pattern; unknown/soft-deleted slug → 404) + `canManageApp` (→ 403). The endpoint's 4xx bodies are JSON (`{ error }`), consistent with its 400 face — the sole consumer is the SPA fetcher; no HTML face exists on this route (unlike the mutation routes' `forbiddenPage`, which serve zero-JS form navigation).
- `GET /api/apps/:slug/settings` (SPA data face) — the `can_manage: false` base payload shrinks to the D4 identity set + `can_manage: false` (`created_at` joins the wire; it is absent from today's payload); `installations`, `deliveries`, `delivery_summary`, `last_webhook_at`, `sandbox_image_id`, and `review_trigger_mode` move behind the `canManageApp` branch. Managers keep today's shape in full.

## Non-goals

- No new roles beyond `admin` / `member`; no per-App ACL or sharing model.
- No changes to review engine / pipeline / webhook behavior.
- No data migrations (`reviews.app_id` exists since migration 0005).
- No redesign of the Apps list beyond affordance gating (D6).
- No Apps-list field-level narrowing this iteration: status/health/creator columns stay member-visible as today (locked by D6). Whether non-managers should see the list's health column for Apps they do not manage is an **open product question**, deliberately not decided here (owner PM; trigger = explicit user request after live use).
- No admin-only global dashboard variant (superseded by D2).

## Risks & rollback

- **Transient no-insights state (accepted).** Between the per-App insights data-face plan's integration merge (global face removed) and the app-detail IA plan's (per-App tab added), the integration branch briefly has no insights surface anywhere. Bounded to the iteration's integration branch — `main` is never in that state; both plans merge within the iteration, before the PR to `main`.
- **Payload narrowing has no cross-deploy skew (single deploy unit).** The SPA and the API ship in one Worker bundle — assets and routes deploy together — so the narrowed non-manager payload and its consumer cannot skew across deploys. The real sequencing is intra-plan: today's SPA `parseSettings` hard-requires `installations`, `deliveries`, `sandbox_image_id`, and `review_trigger_mode` on **both** faces, so the payload narrowing and its compensating detail-face parse rewrite must land in one plan merge; they are never deployed apart.
- **Rollback granularity.** Each plan reverts independently: reverting 76 restores today's member-visible detail payload while keeping the per-App endpoint; reverting 75 restores the global face (the store's `appId` filter is additive-only, so its revert alone is a byte-level no-op for every existing aggregation). Rollback = revert the plan's integration-branch merge commit; no data migrations exist to undo.
- **Watch item (era gate).** The `appId` predicate must never be folded into `windowEraWhere` itself — the era gate string is shared verbatim by the `repos` aggregation and the main WHERE by design; the app predicate composes alongside it, keeping the absent-filter case byte-identical.

## Acceptance anchors

Pinned by tests: the AuthZ matrix rows above (extend tests/worker/app-permission-matrix.test.ts), the absence of the global insights face, the per-App filter's additive zero-diff behavior — including the app-scoped `repos` aggregation under `include=repos` (tests/dashboard/insights-store.test.ts) — SPA routing/tabs (default settings tab, legacy path → settings tab, 洞察 tab absent on the `can_manage: false` face) and Apps-list row links + manage-affordance absence (tests/spa/), and i18n completeness for en + zh-CN (tests/i18n/).
