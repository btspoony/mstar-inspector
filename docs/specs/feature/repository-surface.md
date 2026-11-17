# Feature: repository surface

Promoted from: iteration v1.18 (package specs repository-surface / repository-target-model / operator-data-upgrade).

## Scope

The workspace repository surface: the sidebar entry and its route family, the repository list and its fixed 所有仓库 row, the add-repository dialog and the API behind it, the three-tab repository detail, review settings as two tiers with inheritance, the application detail's two-tab split, and the boundary states and refusal vocabulary those surfaces answer with.

Data and execution contracts — target identity, schema, webhook resolution, effective settings, installation claims, application-settings gates — live in the repository target model page. The operator maintenance window and the historical repository backfill live in the operator data-upgrade page.

Out of scope: review pipeline behaviour, billing and quota faces, cross-workspace sharing of one repository (one workspace per repository per App), and any compatibility layer for the retired application-scoped surfaces.

## Current state

### Information architecture

| ID | Contract |
|----|----------|
| N1 | The sidebar carries four entries in the order 仓库 (Repositories) → 应用 (Apps) → 成员 (Members) → 设置 (Settings). The repository entry uses the `FolderGit2` icon and is current on every `/dashboard/<workspaceRef>/targets…` path. |
| N2 | The family keeps the `targets` route segment: the list is `/dashboard/<workspaceRef>/targets`, the fixed default entry is `/dashboard/<workspaceRef>/targets/all`, one repository is `/dashboard/<workspaceRef>/targets/<targetId>` carrying the target UUID. 仓库 / Repositories is a display name, never a path segment. |
| N3 | The workspace page segments are `apps`, `targets`, `members`, `settings`. There is no deployment-level copy of the repository surface: a workspace-less `/dashboard/…` path is the family's 404 before SPA dispatch. |

### Repository list

| ID | Contract |
|----|----------|
| R1 | The first row is the fixed entry 所有仓库, linking to `/targets/all`, with the meta line "工作区默认评审配置 · 全工作区洞察与拉取请求" and a pill carrying the count of the workspace's live targets ("0 个仓库" / "1 个仓库" / "<n> 个仓库"). |
| R2 | Every following row is one live target: `owner/name` as the title, the meta line `<应用名> · 最近审查 <relative time>` (or `· never reviewed`), and one status pill. Rows are ordered newest first with the target id as a stable tiebreak. A row whose `repo_id` is still null renders the placeholder title `—` and the 未绑定安装 · 等待接收投递 meta line instead of the application/时间 line, because its repository identity is not confirmed by a delivery yet. |
| R3 | The status pill vocabulary is 审查中 / 待安装 / 已暂停, decided by the row alone: 待安装 exactly when `repo_id` is null (awaiting the first delivery that carries the id), 已暂停 when the business pause is off, 审查中 otherwise. |
| R4 | The list costs one read (`GET /dashboard/<workspaceRef>/api/targets`), which carries the application display name and the newest review stamp per row. `repo_id: null` is the only 待安装 discriminator; the page makes no second installation call to decide a row's state. |
| R5 | Zero targets: the 所有仓库 row is still present with "0 个仓库" and an empty state 还没有仓库 whose single call to action is 添加仓库. The empty state never replaces the 所有仓库 row. |
| R6 | A failed list load renders an inline error row with a retry action; the 所有仓库 row stays navigable, so the workspace-default face is reachable while the target rows are not. |

### Add repository

| ID | Contract |
|----|----------|
| A1 | 添加仓库 on the list opens a dialog that selects the application first. Zero applications: no select, the copy 本工作区还没有应用 plus a link to the applications page; the dialog offers no way to proceed without an application. Exactly one application: no select, the fixed context line 将绑定到 <app>. Several: a select with the first application preselected and switchable before any repository is chosen. |
| A2 | Repository options come from the selected application's live installations (`GET …/api/apps/:appId/installation-repositories`), deduped by `repo_id` across installations. The multi-select shows already-added repositories disabled with an 已添加 tag instead of hiding them. |
| A3 | Confirming creates one target per selected repository, bound to the chosen application with inheritance on (`follow_workspace_defaults = 1`). The answer is `201 { created, duplicates }`. |
| A4 | A duplicate is a value, never a failed batch: a repository the same application already holds in any workspace lands in `duplicates`, rows already created by the same submission are kept, and the dialog stays open naming 以下仓库已存在. Nothing is rolled back and no partial-failure message is invented. |
| A5 | Every submitted `repo_id` must be one the application's live installations grant. An unproven id refuses the whole request (`400 repository_not_installed`, naming the ids) with zero rows written, so a manager cannot pre-claim a repository another workspace would then receive deliveries for. |
| A6 | Confirm stays disabled with no repository selected, when the application's installation grants no repository ("该应用尚未安装到任何仓库" plus a link to the application's 已安装 tab), and when the repository load failed (inline error with retry). |

### Repository detail

| ID | Contract |
|----|----------|
| T1 | `/targets/<targetId>` is the repository detail with the header `owner/name` and exactly three tabs: 评审配置 / 洞察 / 拉取请求. A target whose repository columns are still empty names the 待安装 state in the header instead of rendering an empty heading. |
| T2 | The 评审配置 tab carries 评审触发, 审查深度, 审查门禁 (最低分 plus 通过结论), 继承开关 and 暂停开关. 审查范围 is static copy — 本仓库（随应用安装自动授权） — because no allowlist control exists anywhere on this surface. |
| T3 | 洞察 and 拉取请求 read the single-target scope; the 所有仓库 entry reads the workspace scope over every live target. Both scopes are manager reads, and a target-scope payload is the one-id set of the same store call the workspace face makes. |
| T4 | An unknown, foreign or soft-deleted `targetId` is a 404 page with a link back to the repository list. A target with no insight or pull-request data renders 暂无洞察数据 / 暂无拉取请求, never an error. |
| T5 | A repository renamed or transferred on GitHub keeps its target row and its URL; the header shows the refreshed `owner/name` from the next delivery, not a new row. |

### Two-tier review settings

| ID | Contract |
|----|----------|
| S1 | 所有仓库 opens the same three-tab page and is the workspace default tier: its 评审配置 tab edits `default_review_trigger_mode`, `default_review_level`, `default_check_pass_verdicts` and the gate floor `workspaces.check_min_score`. It carries the same field set as one repository minus the inheritance switch and the pause switch — this page *is* the default, and the pause belongs to a repository. |
| S2 | Effective settings are computed at every read: `follow_workspace_defaults = 1` answers the workspace defaults, `= 0` answers the row's own columns. A default change therefore reaches every inheriting target at its next read or execution; there is no propagation job and no defaults copy inside the row. |
| S3 | Turning inheritance off snapshots the values the target is running with at that moment into the row (workspace defaults for still-inheriting fields); the toggle itself changes no live behaviour. Turning inheritance on sets the flag only: stored overrides become inert and are never read again, and a later toggle-off re-snapshots from the then-current defaults. |
| S4 | A target created through the surface inherits (`= 1`). A target created by the historical backfill carries its copied configuration with inheritance off (`= 0`), so the upgrade changes no live review behaviour. |
| S5 | A settings save validates every value before the first write: an off-vocabulary trigger mode, review level, score or verdict is a keyed 400 with nothing stored, and naming any policy column without `follow: 1` is an explicit override that also flips the row to `follow = 0` in the same statement. |
| S6 | An unreadable stored gate (a `check_pass_verdicts` value that does not parse) refuses every policy save — including the inheritance snapshot — with `400 review_gate_unreadable`, and the tab renders its read-only recovery notice in place of an editable gate. The pause switch stays writable. |

### Application detail

| ID | Contract |
|----|----------|
| P1 | The application detail carries exactly two tabs: 应用设置 and 已安装. 应用设置 holds the GitHub App identity card (name, App ID, webhook URL, refresh), 运维 (暂停审查 / 停用（可恢复）/ 删除), model and provider configuration (model, provider, fallback chain, seats), and keys and sandbox. 已安装 holds the installation list and delivery health. |
| P2 | 洞察, 拉取请求, 评审触发, 审查深度, 审查门禁 and 允许名单 have no control on the page and no application-level route serves them: no insights or pull-request panel, no review-policy section, no allowlist control. The settings family serves the application-scoped operations only — identity refresh, pause/disable/delete, providers, chains, seats, keys and sandbox. |
| P3 | The retired spellings `/apps/:appId/settings` and `/apps/:appId/bot` each answer one redirect to the canonical address `/apps/:appId?tab=settings` and never render a page; the tab set is query-derived (`?tab=settings\|installations`). |

### Admission

| ID | Contract |
|----|----------|
| W1 | Installation is the only admission mechanism: an application installed on a repository authorizes review there, and adding the repository creates the target. There is no per-repository admission switch, no allowlist table holding history, and no allowlist copy in either locale. |
| W2 | `allowlist_enabled` and `target_owner_allowlist` are gone with their rows; no reader, writer, i18n key or settings control survives them. The rows are not migrated anywhere and are not surfaced afterwards. |

### Refusal vocabulary

| ID | Contract |
|----|----------|
| V1 | `403 forbidden` — a caller without the workspace owner/admin role on every write of this surface and on the aggregate read faces (insight summary, pull requests, installation repositories). |
| V2 | `404 unknown app` / `404 unknown target` — unknown, foreign or soft-deleted subject; always zero writes. An unmatched path is the family's 404. |
| V3 | `400` — `no repositories selected`, `invalid repository`, `repository_not_installed` (with `repo_ids`), the keyed settings validation 400s, and `review_gate_unreadable`. A refused body stores nothing. |
| V4 | `502 installation_repositories_unavailable` — the installation walk failed for every installation, or could not run at all. The dialog fills its inline error from it; the add write fails closed on it. |
| V5 | `201 { created, duplicates }` — a partial add is reported per repository, never converted into a whole-batch failure and never rolled back. |
| V6 | Read faces refuse malformed query values (`window`, `repo`, `include`, `limit`, `offset`) with a 400 rather than a silent default; a well-formed `limit` outside its bounds is clamped, never rejected. |

### Boundary states

| ID | Contract |
|----|----------|
| Z1 | Empty and failure states are inline in the surface that owns them — the list's empty state and error row, the dialog's disabled-confirm notices, the detail tabs' empty states, the 404 page — never a modal, a blank page or a redirect away from the surface. |
| Z2 | While the platform is in its maintenance window every dashboard page answers the maintenance page instead of its content; no repository surface renders partial data in that state. |

## AuthZ matrix

| Surface | member (non-manager) | workspace owner / admin |
|---|---|---|
| Sidebar, repository list rows, 所有仓库 row | visible | visible |
| `GET …/api/targets` (list payload) | 200 | 200 |
| `GET …/api/targets/:targetId`, `GET …/api/targets/all` | 200 (read-only face) | 200 |
| `GET …/api/apps/:appId/installation-repositories` | 403 | 200 |
| `POST …/api/targets` (add repository) | 403 | 201 |
| `POST …/api/targets/:targetId`, `POST …/api/targets/defaults` | 403 | 200 |
| `GET …/api/targets/:targetId/insights/summary`, `GET …/api/targets/:targetId/pull-requests` | 403 | 200 |
| `GET …/api/insights/summary`, `GET …/api/pull-requests` (workspace scope) | 403 | 200 |
| Application detail tabs (应用设置 / 已安装), `POST …/api/apps/:appId/bind-installation` | tabs absent — identity card only; 403 | visible |

## Invariants

- One live target is one repository under one workspace; the list, the detail page and the add path all address the target UUID, never an application id or an installation id.
- The two settings tiers never drift into copies: an inheriting target answers the defaults at read time, and an inheriting target's own policy columns are inert.
- The add path proves every `repo_id` against the application's live installations before the first insert.
- Installation is authorization; no page, API or locale key reintroduces a per-repository admission switch.
- The application detail edits no review policy and the repository detail edits no application configuration.

## Where it lives

- `src/i18n/nav.ts` (`NAV_ITEMS`), `src/spa/components/AppSidebar.tsx` (`NAV_ICONS`)
- `src/spa/routes.ts` (workspace page segments, `settingsTabRedirect`), `src/spa/shell.ts`, `src/spa/components/AppSidebar.tsx`
- `src/spa/pages/TargetsPage.tsx` (list, add dialog, three-tab detail), `src/spa/pages/TargetSettingsTab.tsx`, `src/spa/pages/WorkspaceDefaultsTab.tsx`, `src/spa/pages/AppDetailPage.tsx`, `src/spa/pages/BotSettingsPage.tsx` (the 应用设置 tab's body)
- `src/dashboard/index.ts` — `targetListRoute`, `targetCreateRoute`, `appInstallationRepositoriesRoute`, `targetSettingsReadRoute`, `targetSettingsWriteRoute`, `workspaceDefaultsReadRoute`, `workspaceDefaultsWriteRoute`, `workspaceInsightsRoute`, `workspacePullRequestsRoute`
- `src/dashboard/targets-store.ts` (`listLiveWithApp`, `countLive`, `getInWorkspace`, `readEffectiveTargetSettings`, `setInheritance`)
- `tests/spa/targets-page.test.tsx`, `tests/spa/app-detail.test.tsx`, `tests/spa/shell.test.ts`, `tests/dashboard/targets-store.test.ts`

## Change obligations

A change to navigation order, the route family, the list or dialog states, the tab set, the settings tiers, the application detail tabs or the refusal vocabulary updates this page in the same change. Adding a review-policy field means adding it to both tiers and to the inheritance snapshot in the same change. Adding any admission mechanism replaces the Admission section in the same change.
