# Feature: repository surface

## Scope

The workspace repository surface: the sidebar entry and its route family, the repository list and its fixed 所有仓库 row, the add-repository dialog and the API behind it, the three-tab repository detail, review settings as two tiers with inheritance, the application detail's two-tab split, and the boundary states and refusal vocabulary those surfaces answer with.

Data and execution contracts — target identity, schema, webhook resolution, effective settings, installation claims, application-settings gates — live in the repository target model page. The operator maintenance window and the historical repository backfill live in the operator data-upgrade page.

Out of scope: review pipeline behaviour, billing and quota faces, cross-workspace sharing of one repository (one workspace per repository per App), and any compatibility layer for the retired application-scoped surfaces.

## Current state

### Information architecture

| ID | Contract |
|----|----------|
| N1 | The sidebar carries four entries in the order 仓库 (Repositories) → 应用 (Apps) → 成员 (Members) → 设置 (Settings). The repository entry uses the `FolderGit2` icon and is current on every `/dashboard/<workspaceRef>/repos…` path. |
| N2 | The family carries the `repos` route segment: the list is `/dashboard/<workspaceRef>/repos` — the dashboard default, where `/dashboard` and the retired `/dashboard/apps` spelling both redirect — the fixed default entry is `/dashboard/<workspaceRef>/repos/all`, one repository is `/dashboard/<workspaceRef>/repos/<targetId>` carrying the target UUID. 仓库 / Repositories is a display name, never a path segment. |
| N3 | The workspace page segments are `repos`, `apps`, `members`, `settings`. There is no deployment-level copy of the repository surface: the two dashboard roots refuse to render it (they redirect), and a workspace-less `/dashboard/<segment>/…` path is the family's 404 before SPA dispatch. |

### Repository list

| ID | Contract |
|----|----------|
| R1 | The list is one `DataTable` — the Apps table's vocabulary: a name cell with a quieter second line, a status badge, right-aligned figure columns. Its first row is the fixed aggregate entry 所有仓库, linking to `/repos/all`, naming 工作区默认评审配置 · 全工作区洞察与拉取请求 as its second line; its status cell carries the count of the workspace's live targets ("0 个仓库" / "1 个仓库" / "<n> 个仓库"), its two figure columns carry the sums over every live target, and its last-review cell carries the newest review stamp over the same set. |
| R2 | Every following row is one live target, with five cells: the repository (`owner/name`, with the application's display name as the cell's second line), the state badge, the total review count, the review count of the last 7 days, and the last review as relative time. Rows are ordered by last review descending with never-reviewed repositories last, and the target id as a stable tiebreak — so a reload shows the same order and the filter never reorders what it keeps. A row whose `repo_id` is still null but that names `owner/name` keeps that name, because such a row is a target whose installation went away and its review history is real: `repo_id` is the ONE installation axis — it keys the 待安装 badge, the 待安装 filter's count and nothing else — while the row's identity and its review figures follow `owner/name`, so a named row keeps its history. Only a row naming no repository at all renders the placeholder title `—`. |
| R3 | The status pill vocabulary is 审查中 / 待安装 / 已暂停, decided by the row alone: 待安装 exactly when `repo_id` is null (awaiting the first delivery that carries the id), 已暂停 when the business pause is off, 审查中 otherwise. |
| R4 | The list costs one read (`GET /dashboard/<workspaceRef>/api/targets`), which carries the application display name, the newest review stamp, the total review count and the last-7-day review count per row — the three review aggregates are correlated subqueries over the target's own reviews, so the payload's size, not its row count, decides the cost. `repo_id: null` is the only 待安装 discriminator; the page makes no second installation call to decide a row's state. The page header derives its three figures from that same payload by summing the row aggregates — the live target count, the reviews across every live target, and the reviews of the last 7 days across the same set (a named-but-unbound row's history is real, so it counts here too) — so the overview needs no second read. |
| R5 | Zero targets: the 所有仓库 row is still present with "0 个仓库" and an empty state 还没有仓库 whose single call to action is 添加仓库. The empty state never replaces the 所有仓库 row. |
| R6 | A failed list load renders an inline error row with a retry action; the 所有仓库 row stays navigable, so the workspace-default face is reachable while the target rows are not. |
| R7 | 待安装 is a filter over the list, not a metric: a segmented control carrying the count of rows whose `repo_id` is null (待安装 (<n>)) beside 全部, rendered only while that count is non-zero. Switching to it narrows the table to those rows and leaves the 所有仓库 aggregate row in place; switching back restores the payload's order unchanged, because the order is the server's. A narrowed list with no row left states that no repository is awaiting its install. The header band never reports 待安装. |

### Add repository

| ID | Contract |
|----|----------|
| A1 | 添加仓库 on the list opens a dialog with three steps in one surface: the application (bot) the repository belongs to, that application's installation, then the repositories. The application step is ALWAYS a control — with one application too, never an implicit first — and states that a repository scope shared across several applications is planned, not available. It carries the select of every visible application, the page's list read being the source. Zero applications: no steps, the copy 本工作区还没有应用 plus a link to the applications page. |
| A2 | The installation step shows the chosen application's live installations from the application-settings payload the dialog already reads — `installations[]`, each naming its account login, its installation id and when it was last seen — with a re-check that refetches that payload. With none, it states that the application is installed nowhere and links to `https://github.com/apps/<slug>/installations/new` (no slug, no link). The repository step is query-first: nothing is listed before the operator types, the query matches on `owner/name`, and the answer is bounded to 40 mounted rows with the match count printed above them and a keep-typing hint when the bound hides some. Options come from the application's live installations (`GET …/api/apps/:appId/installation-repositories`), deduped by `repo_id` across installations; already-added repositories show disabled with an 已添加 tag instead of being hidden. |
| A3 | Confirming creates one target per selected repository, bound to the chosen application with inheritance on (`follow_workspace_defaults = 1`). The answer is `201 { created, duplicates }`. |
| A4 | A duplicate is a value, never a failed batch: a repository the same application already holds in any workspace lands in `duplicates`, rows already created by the same submission are kept, and the dialog stays open naming 以下仓库已存在. Nothing is rolled back and no partial-failure message is invented. |
| A5 | Every submitted `repo_id` must be one the application's live installations grant. An unproven id refuses the whole request (`400 repository_not_installed`, naming the ids) with zero rows written, so a manager cannot pre-claim a repository another workspace would then receive deliveries for. |
| A6 | Confirm stays disabled with no repository selected, while the chosen application has no live installation, when the application's installation grants no repository ("该应用已安装，但没有授予任何仓库" plus a link to the application's 已安装 tab), and when the repository load failed (inline error with retry). |

### Repository detail

| ID | Contract |
|----|----------|
| T1 | `/repos/<targetId>` is the repository detail with the header `owner/name` and exactly three tabs: 评审配置 / 洞察 / 拉取请求. A target naming no repository at all names the 待安装 state in the header instead of rendering an empty heading. |
| T2 | The 评审配置 tab names the application the repository is bound to as a labelled read-only row (the payload's `app_name`) beside one line stating that changing the bound application is planned and not supported yet — no rebind control exists. It carries 评审触发, 审查深度, 审查门禁 (最低分 plus 通过结论), 继承开关 and 暂停开关. 审查范围 is static copy — 本仓库（随应用安装自动授权） — because no allowlist control exists anywhere on this surface. |
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
