# Feature: App detail visibility

## Scope

Dashboard App detail routing, the application detail's own two tabs, member identity-only reads and manager-only operational data.

## Current state

### App detail contract

| ID | Contract |
|----|----------|
| D2 | Insights and pull requests are read at exactly two scopes: one repository target and the whole workspace behind the 所有仓库 entry. No application-scoped and no deployment-global face exists. |
| D3 | `/dashboard/apps/:appId` (the numeric `github_app_id`) is the **应用详情 (App detail)** page and carries exactly two tabs: **应用设置** and **已安装**. Review policy belongs to the repository detail, `/dashboard/{workspaceRef}/targets/<targetId>` (target UUID). |
| D4 | A member without the workspace owner/admin role sees **GitHub App identity info only** on the detail face. The identity set: `github_app_id`, `status`, `review_enabled`, `created_by`, `created_at` — the App identity fields, plus creation time — **and** the App's cached public GitHub profile (`github_name`, `github_slug`, `github_description`, `github_html_url`, `github_avatar_url`, `github_metadata_synced_at`), plus local App `id` and top-level server-resolved `workspace_id` (the pair composing the manager-visible webhook URL). Operational fields — `installations`, `deliveries`, `delivery_summary`, `last_webhook_at`, `sandbox_image_id`, the settings payload — remain behind the `canManageApp` branch; insight and pull-request reads 403; every mutation 403. Non-managers receive no operational payload. `review_trigger_mode` is not an operational field of the application: it is a target-owned fact the payload echoes as read-only context only when the workspace holds exactly one target under the app. |
| D5 | Insight and pull-request reads are **workspace owner-or-admin** at both scopes: the target routes (`…/api/targets/:targetId/insights/summary`, `…/pull-requests`) and the workspace routes (`…/api/insights/summary`, `…/api/pull-requests`), both gated by `canManageApp`, which is `canManageRole(scope.role)`. Creating an App grants nothing: the creator of an App they are a plain member of gets the same 403 as any other member. |
| D6 | The Apps list stays visible to all members with its current columns/payload; every row links into the detail page. The list renders no manage affordances today; any affordance added later must be `can_manage`-gated. |

### AuthZ matrix

| Surface | member (non-manager) | workspace owner / admin |
|---|---|---|
| `GET /api/apps` (list) | visible (unchanged) | visible |
| App detail identity set (github_app_id, status, review_enabled, created_by, created_at, cached public GitHub profile `github_*`, local App `id`; top-level `workspace_id`) | visible | visible |
| Install health / delivery payload (`installations`, `deliveries`, `delivery_summary`, `last_webhook_at`) | **absent from payload** | visible |
| Runtime/ops config fields (`sandbox_image_id`) | **absent from payload** | visible |
| Settings payload (keys, chains, providers, application-scoped operations). The payload may echo the single target's review facts (`target_id`, `check_gate`, `review_trigger_mode`, `review_level`) as read-only context; it carries no review control and no allowlist. | hidden (`can_manage: false` shape) | visible |
| `GET …/api/targets/:targetId/insights/summary` | 403 | 200 |
| `GET …/api/insights/summary` (workspace scope) | 403 | 200 |
| Mutations (disable/enable/delete, pause/resume, settings writes, key/delete) | 403 (unchanged) | allowed (unchanged) |
| Global insights page | **removed for everyone** | removed |

Membership bootstrap, invite/remove/role flows, and the per-request membership guard are **unchanged**.

### Information architecture

- `/dashboard/apps/:appId` → App detail page (D3), with the workspace-scoped twin `/dashboard/{workspaceRef}/apps/{github_app_id}` served by the same page id and consuming `GET /api/apps/:appId/settings`. The tab set is 应用设置 | 已安装, derived from `?tab=`; a request without the parameter lands on 应用设置.
- The retired spellings `…/apps/:appId/settings` and `…/apps/:appId/bot` each answer one 302 to the canonical `…/apps/:appId?tab=settings`. The retired app-target policy POST family and its redirect helpers are deleted with the routes.
- The bot page is no longer a page: `/apps/:appId/bot` redirects into the 应用设置 tab, whose body renders the bot-scoped configuration.
- A non-manager sees the D4 identity card and neither tab's data: both tabs read manager payloads.
- `/dashboard/insights` is removed from `SPA_PAGES`, the sidebar, and i18n nav keys. Deep links to it fall through the normal unknown-route behavior (no longer shell-served: an HTML GET falls past the SPA dispatch to the guarded dashboard app's 404, exactly like any other unknown `/dashboard` path).
- Sidebar: four entries in the order 仓库 / 应用 / 成员 / 设置, from one source (`NAV_ITEMS`); the repository entry uses `FolderGit2`.
- Apps list: every row navigates to the detail page (row click, name link, and row action all target `/dashboard/apps/:appId`); the row action's copy moves from settings semantics to detail semantics in both locales. The list renders no manage affordances today and must not grow any that are not `can_manage`-gated (D6 invariant); columns and the list payload are otherwise unchanged.

#### App identity key

- **Every path above carries the numeric GitHub App id**, including the workspace-scoped form `/dashboard/{workspaceRef}/apps/{github_app_id}`, all `/api/apps/:appId/…` routes, and every server-generated redirect. A non-numeric segment is a 404.
- The numeric GitHub App id addresses detail routes; neither the former local slug nor cached `github_slug` addresses a detail URL. Old local-slug bookmarks have no redirect. Migration `0036_app_identity.sql` renamed the local slug to `webhook_path`; `0038_webhook_path_drop.sql` removed that duplicated key entirely. Webhook delivery uses `/webhook/{workspaces.id}/{github_apps.id}` with no single-segment compatibility route.
- The Apps list payload loses `slug` and gains `github_name` / `github_slug` / `github_avatar_url`; the display name falls back `github_name ?? github_slug ?? String(github_app_id)`, and the avatar is the App's own logo (the bot account's avatar), not the owner's.

### Data faces

- `insights-store` binds a target-id set (`ledgerScopeSql` promoted to `targetIds`); the workspace scope resolves the workspace's live targets in a subquery, so the bind count stays constant. No application-scoped filter exists.
- `GET …/api/targets/:targetId/insights/summary` and `GET …/api/insights/summary` — same `window` / `repo` / `include=repos` semantics and payload keys, manager gate, and malformed params answering 400.
- `GET /api/apps/:appId/settings` (SPA data face) — the `can_manage: false` base payload contains the D4 identity set + `can_manage: false`; `installations`, `deliveries`, `delivery_summary`, `last_webhook_at` and `sandbox_image_id` stay behind the `canManageApp` branch. Managers receive the operational shape in full. The payload echoes the single target's review facts (`target_id` as a string, then `check_gate`, `review_trigger_mode`, `review_level`, `review_enabled`) only when the workspace holds exactly one live target under the app; zero targets omits the slice, several send `target_id: null` with `targets_many: true`, and no allowlist or `owner_overlap` field is sent.

### Non-goals

- No new roles beyond `admin` / `member`; no per-App ACL or sharing model.
- No change to review engine, publication or gate evaluation. Webhook routing now resolves the target by repository identity, described on the repository target model page.
- No data migration is needed for the new scopes: the ledger already carries `target_id` (`0060_execution_ledger_target.sql`) and workspace scope resolves through `review_targets.workspace_id`. App identity routing follows migrations `0036_app_identity.sql` and `0038_webhook_path_drop.sql`.
- No redesign of the Apps list beyond affordance gating (D6).
- No Apps-list field-level narrowing this contract: status/health/creator columns stay member-visible as today (locked by D6). Whether non-managers should see the list's health column for Apps they do not manage is an **open product question**, deliberately not decided here (owner PM; trigger = explicit user request after live use).
- No deployment-global variant: the workspace scope replaces the former global face.

## Invariants

- The application detail's manager face carries 应用设置 and 已安装; review policy lives on the repository detail keyed by target UUID. Non-managers see only the identity card. Both retired spellings answer one 302 to `?tab=settings`.
- The scope predicate is a bound target-id set composed alongside `windowEraWhere`; no application predicate exists.
- SPA and API ship in one Worker bundle; payload narrowing and its parser change must deploy together.
- Membership bootstrap, invitations, removal, role flows and per-request membership guards retain their contracts.

## Where it lives

- `src/dashboard/index.ts`: `requireAppVisible`, `appSettingsRoute`, `targetInsightsRoute`, `targetPullRequestsRoute`, `workspaceInsightsRoute`, `workspacePullRequestsRoute`, the application settings read and the `canManageApp` branches.
- `src/dashboard/insights-store.ts`: `whereSql`, `windowEraWhere`, the bound target-id set.
- `src/spa/pages/data.ts`, `src/spa/pages/TargetsPage.tsx`: settings and insight payload parsing on the application and repository pages.
- `tests/worker/app-permission-matrix.test.ts`, `tests/dashboard/insights-store.test.ts`, `tests/spa/`, `tests/i18n/`: authorization, the bound target-id filter, routing/tabs, links and both locale contracts.
- `migrations/0036_app_identity.sql`, `migrations/0038_webhook_path_drop.sql`: numeric detail routing and internal-id webhook routing.

## Change obligations

Keep every authorization matrix row pinned, including field absence rather than display-only hiding. Update routing, tabs, row links, redirects, en/zh-CN keys and parsers with payload changes. Preserve `include=repos` at both scopes, era gating, and the distribution grid when no repository filter is supplied; keep the identity-only face's field absence pinned.

Decision history: [remove global insights](../../../.agents/adr/implemented/feature/2026-09-18-per-app-insights-only.md).
