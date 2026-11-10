# Feature: App detail visibility

## Scope

Dashboard App detail routing, member identity-only reads, manager-only operational data, and per-App insights. Global insights have no page or data endpoint.

## Current state

### App detail contract

| ID | Contract |
|----|----------|
| D2 | The global insights face is **removed entirely** (page, SPA route/nav, `GET /api/insights/summary`). No admin-only global variant exists: insights have no global concept. |
| D3 | `/dashboard/apps/:appId` (the numeric `github_app_id`) becomes the **应用详情 (App detail)** page with exactly two tabs: **应用设置** (existing settings capability, unchanged) and **洞察** (per-App insights view). |
| D4 | A member who is neither the App creator nor an admin sees **GitHub App identity info only** on the detail face. The identity set: `github_app_id`, `status`, `review_enabled`, `created_by`, `created_at` — the App identity fields, plus creation time — **and** the App's cached public GitHub profile (`github_name`, `github_slug`, `github_description`, `github_html_url`, `github_avatar_url`, `github_metadata_synced_at`), plus local App `id` and top-level server-resolved `workspace_id` (the pair composing the manager-visible webhook URL). Operational fields — `installations`, `deliveries`, `delivery_summary`, `last_webhook_at`, `sandbox_image_id`, `review_trigger_mode`, the settings payload — remain behind the `canManageApp` branch; insights 403; every mutation 403. Non-managers receive no operational payload. |
| D5 | The insights tab (and its data endpoint) is **creator-or-admin** (`canManageApp`), consistent with D4. Members see insights for Apps they manage (their own, or any if admin). |
| D6 | The Apps list stays visible to all members with its current columns/payload; every row links into the detail page. The list renders no manage affordances today; any affordance added later must be `can_manage`-gated. |

### AuthZ matrix

| Surface | member (non-manager) | creator / admin |
|---|---|---|
| `GET /api/apps` (list) | visible (unchanged) | visible |
| App detail identity set (github_app_id, status, review_enabled, created_by, created_at, cached public GitHub profile `github_*`, local App `id`; top-level `workspace_id`) | visible | visible |
| Install health / delivery payload (`installations`, `deliveries`, `delivery_summary`, `last_webhook_at`) | **absent from payload** | visible |
| Runtime/ops config fields (`sandbox_image_id`, `review_trigger_mode`) | **absent from payload** | visible |
| Settings payload (keys, chains, providers, trigger mode) | hidden (`can_manage: false` shape) | visible (unchanged) |
| `GET /api/apps/:appId/insights/summary` | 403 | 200 |
| Mutations (disable/enable/delete, pause/resume, settings writes, key/delete) | 403 (unchanged) | allowed (unchanged) |
| Global insights page + `GET /api/insights/summary` | **removed for everyone** | removed |

Membership bootstrap, invite/remove/role flows, and the per-request membership guard are **unchanged**.

### Information architecture

- `/dashboard/apps/:appId` → App detail page (two tabs as per D3), with the workspace-scoped form `/dashboard/{workspaceRef}/apps/{github_app_id}` served by the same page id. The SPA matcher owns the route: **one matcher entry (one page id)** serves both `/dashboard/apps/:appId` (default tab: 应用设置) and the legacy `/dashboard/apps/:appId/settings` (settings tab active); tab state derives from the path via the shared pure URL-state helpers. `/dashboard/apps` (exact) stays the Apps list. No second page and no second data face: both paths consume `GET /api/apps/:appId/settings`.
- The legacy `/settings` path is a **permanent** settings-tab deep link, not a temporary compat shim: the settings POST family's HTML-navigation 302 targets (`settings400Response`, `settingsPostResponse`, `reviewActionRedirect`'s settings-origin branch) are pinned to `/dashboard/apps/:appId/settings`, so the path keeps resolving for as long as those zero-JS form-navigation contracts exist. Removing the path instead would mean re-pinning every form-POST redirect — deliberately out of scope.
- The 洞察 tab renders only on the `can_manage: true` face; a non-manager sees the 应用设置 tab only (carrying the D4 identity-only content). "Exactly two tabs" is the manager face; the tab's absence for non-managers is pinned by tests.
- `/dashboard/insights` is removed from `SPA_PAGES`, the sidebar, and i18n nav keys. Deep links to it fall through the normal unknown-route behavior (no longer shell-served: an HTML GET falls past the SPA dispatch to the guarded dashboard app's 404, exactly like any other unknown `/dashboard` path).
- Sidebar: Apps and Members entries unchanged; the Insights entry is gone.
- Apps list: every row navigates to the detail page (row click, name link, and row action all target `/dashboard/apps/:appId`); the row action's copy moves from settings semantics to detail semantics in both locales. The list renders no manage affordances today and must not grow any that are not `can_manage`-gated (D6 invariant); columns and the list payload are otherwise unchanged.

#### App identity key

- **Every path above carries the numeric GitHub App id**, including the workspace-scoped form `/dashboard/{workspaceRef}/apps/{github_app_id}`, all `/api/apps/:appId/…` routes, and every server-generated redirect. A non-numeric segment is a 404.
- The numeric GitHub App id addresses detail routes; neither the former local slug nor cached `github_slug` addresses a detail URL. Old local-slug bookmarks have no redirect. Migration `0036_app_identity.sql` renamed the local slug to `webhook_path`; `0038_webhook_path_drop.sql` removed that duplicated key entirely. Webhook delivery uses `/webhook/{workspaces.id}/{github_apps.id}` with no single-segment compatibility route.
- The Apps list payload loses `slug` and gains `github_name` / `github_slug` / `github_avatar_url`; the display name falls back `github_name ?? github_slug ?? String(github_app_id)`, and the avatar is the App's own logo (the bot account's avatar), not the owner's.

### Data faces

- `insights-store` accepts an **optional `appId` filter** (the `github_apps.id` row PK — a string, not the numeric `github_app_id`) bound as `r.app_id = ?`. It is additive-only and applied to **both** WHERE faces inside the store: the shared WHERE (`whereSql`) used by every aggregation, **and** the opt-in window-scoped `repos` aggregation, which deliberately shares only the window+era predicates (`windowEraWhere`) and ignores `repo` today. Without the second composition the per-App endpoint's `repos` list would carry other Apps' repo names — the exact cross-App leak this spec removes. The existing zero-diff pin over time-bucket grids (knowledge: `d1-time-bucket-distribution-grids`) must keep holding when the filter is absent (both queries byte-identical); the era gate (`r.envelope IS NOT NULL`) and the single `WEEK_BUCKET_SQL` are untouched. Legacy `app_id IS NULL` rows are excluded by the filter, by design.
- `GET /api/apps/:appId/insights/summary` — query params `window` (integer days; >90 clamped to 90 at the store entry; non-integer/negative → 400), `repo` (optional `owner/repo`, within the App's reviews), and `include=repos` (opt-in window-scoped distinct repo list, **app-scoped** — it feeds the insights tab's repo selector; same opt-in semantics as the retired global face). Response reuses the existing summary shape (per-App population) and echoes the effective `window_days` (and `repo` when present) exactly as the retired global face did. Gate: the mount-level membership guard + route-local App resolution (`requireAppVisible` pattern; unknown/soft-deleted App, or a non-numeric segment → 404) + `canManageApp` (→ 403). The endpoint's 4xx bodies are JSON (`{ error }`), consistent with its 400 face — the sole consumer is the SPA fetcher; no HTML face exists on this route (unlike the mutation routes' `forbiddenPage`, which serve zero-JS form navigation).
- `GET /api/apps/:appId/settings` (SPA data face) — the `can_manage: false` base payload contains the D4 identity set + `can_manage: false`; `installations`, `deliveries`, `delivery_summary`, `last_webhook_at`, `sandbox_image_id`, and `review_trigger_mode` move behind the `canManageApp` branch. Managers receive the operational shape in full.

### Non-goals

- No new roles beyond `admin` / `member`; no per-App ACL or sharing model.
- No changes to review engine / pipeline / webhook behavior.
- The insights filter itself needs no new data migration: `reviews.app_id` exists since `0005_reviews_app_id.sql`. App identity routing follows migrations `0036_app_identity.sql` and `0038_webhook_path_drop.sql`.
- No redesign of the Apps list beyond affordance gating (D6).
- No Apps-list field-level narrowing this contract: status/health/creator columns stay member-visible as today (locked by D6). Whether non-managers should see the list's health column for Apps they do not manage is an **open product question**, deliberately not decided here (owner PM; trigger = explicit user request after live use).
- No admin-only global dashboard variant (superseded by D2).

## Invariants

- The manager face has exactly two tabs, settings and insights; non-managers see only settings with identity-only content.
- Never compose the App predicate into `windowEraWhere` itself: compose alongside it on both aggregation faces and preserve byte-identical absent-filter queries.
- SPA and API ship in one Worker bundle; payload narrowing and its parser change must deploy together.
- Membership bootstrap, invitations, removal, role flows and per-request membership guards retain their contracts.

## Where it lives

- `src/dashboard/index.ts`: `requireAppVisible`, `appSettingsRoute`, per-App insights routes and `canManageApp` branches.
- `src/dashboard/insights-store.ts`: `whereSql`, `windowEraWhere`, optional internal App filter.
- `src/spa/pages/data.ts`: settings and insights payload parsing.
- `tests/worker/app-permission-matrix.test.ts`, `tests/dashboard/insights-store.test.ts`, `tests/spa/`, `tests/i18n/`: authorization, additive filter, routing/tabs, links and both locale contracts.
- `migrations/0036_app_identity.sql`, `migrations/0038_webhook_path_drop.sql`: numeric detail routing and internal-id webhook routing.

## Change obligations

Keep every authorization matrix row pinned, including field absence rather than display-only hiding. Update routing, tabs, row links, redirects, en/zh-CN keys and parsers with payload changes. Preserve app-scoped `include=repos`, era gating, and the distribution grid when no App filter is supplied.

Decision history: [remove global insights](../../../.agents/adr/implemented/feature/2026-09-18-per-app-insights-only.md).
