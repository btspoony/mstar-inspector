# ADR: Separate the installed-App face from the creator face, and give Review Bots their own navigation

Status: implemented — shipped on `feat/app-bot-ui-ia` (HEAD `e1c5173f`), 1370 SPA/i18n + 158 worker/store tests green; PM acceptance recorded
Spec: docs/specs/feature/app-detail-visibility.md § Information architecture

## Problem

The App/bot split ([2026-11-25-github-app-review-bot-split](2026-11-25-github-app-review-bot-split.md) § UI) established three list origins — installed Apps, created Apps, usable bots — and gave the Review Bot a detail page. One detail page then answered for both App relations and for bot configuration:

- Both list tabs linked to the same href, `/apps/<github_app_id>`, one route matched it, and the detail page received only `appId`. The face was then chosen by `payload.can_manage`, which is a permission, not an origin: an owner arriving from 已安装 got the creator face, and a consumer never got the installed face's required content.
- The installed face was an identity card plus a chain table; no mounted bot's model chain, providers or runtime appeared, because `BotSettingsView` was composed only on the bot detail route.
- The creator face rendered all four tabs unconditionally, including 投递状态 and 已安装, whose data a consumer does not own.
- Bot configuration had no navigation home, so the App detail grew a header action that repeated the one-to-many mount: one identically labelled 机器人设置 anchor per chain bot, and a bots-list link when the chain was empty.
- App identity was stated three times in one viewport: the page header, the GitHub App block and the credentials block. The chain rendered twice: a `DataTable` and a second chip row that alone carried ↑ ↓ ✕.
- `BotSettingsPage` was a section collection with no page frame; its basic info was a flat key/value block whose 能力 lines restated the default chain as text, while the chain editor sat at the page bottom.
- The shipped tab set contradicted the spec.

The result was one page answering two different questions, a bot surface reachable only by leaving its App, and controls duplicated wherever a relation is one-to-many.

## Decision

### Two origins, two faces

The detail payload states which relation the viewer has to the App, and the face follows it. A single boolean is not enough: an App this workspace both created and installed is one App with two readings, and the list it was opened from selects the reading.

| Origin | Route | Face |
| --- | --- | --- |
| 已安装的应用 | `/apps/<github_app_id>?from=installed` | App identity read-only, this workspace's install/bind state, and the mount chain this workspace owns: order, add and remove are editable by its owner/admin, read-only for a member |
| 我创建的应用 | `/apps/<github_app_id>?from=created` | creator: merged App settings, delivery, installations — three tabs and no chain |

- `SettingsPayload` carries the viewer relation (`installed`, `created`, or both). Without the query parameter the page picks `created` for a creator and `installed` for a consumer, so old links still open the face the viewer can actually use. The relation is derived from facts that hold for every member, never from the role, because the SPA picks the face before it learns whether the viewer manages.
- The installed face renders **no** creator-only section: no credentials, no share switch, no delete/enable, no metadata refresh, no delivery tab. Its metric band carries 挂载的机器人, 安装 and 本月已用 in Credits. A 24h rejection count is rendered nowhere — not here, not on the creator face, not on a list.
- The installed face's chain is the one writer here: the installing workspace's owner/admin reorders it, removes a bot and adds another, and its rows state each bot's default model chain, runtime, multiplier and month spend. A member sees the same rows with no controls present (not disabled). This keeps the split record's rule — only the installing workspace's owner or admin edits a chain.
- The creator face keeps the App's own settings, delivery and installations, and owns no chain: the App is supply, the mount belongs to the install state. 应用设置 is ONE GitHub App section that carries the cached metadata and the credential state together (webhook URL, saved-credential line, refresh button) — there is no separate credentials block and no repository block, because review policy lives on the repository detail. The operations block stays; the share switch renders only for the official workspace, with the non-official read-only variant stated. The tab set is 应用设置 / 投递状态 / 已安装.
- Authorization stays server-side: `canManageApp` gates every creator route and field with ONE exception — the paged delivery LOG (`GET …/api/apps/:appId/deliveries`) is member-readable: it gates on `requireMember` and narrows a non-owner's rows to its own workspace, while the delivery SUMMARY on the detail payload stays manager-only. The face is a rendering choice over two already-authorized reads, never the gate itself. A manager that does not own the App is served the installer projection, not the creator's.

### App identity is stated once

The page header carries the display name, creator, status and the metric band. The tab body carries detail, not identity: GitHub App ID and local App ID appear once in the GitHub App block, the webhook URL once in the credentials block, and no block restates another's facts.

### Bots get a first-class entry

- The sidebar carries a bots entry: `/bots` lists every bot this workspace can use as TWO sections — 我创建的机器人 and 共享给我的机器人 — not a filter over one table; each row opens `/bots/<botId>`. A row is a readable **name** with its **description** underneath and the internal id as muted meta; the id is never the title. 我创建的机器人 carries 创建机器人 in its section header, opening a name-required / description-optional dialog.
- A bot's 基本信息 (name, description) is the first block of its 配置 tab and is the identity every other surface renders — App chain rows, the bots list, the detail header.
- `/bots/<botId>` is one route with two readings, and the reading decides the tab bar:
  - **Owner workspace's owner/admin** gets `PageHeader` (name, provider workspace) and `MetricBand` (multiplier, 本月已用, mounted-App count), then two tabs. 概览 is read-only: 使用情况 as a `FlowSection` (本月已用, 每月上限, 剩余, 计费来源, UTC calendar-month basis), 能力摘要 (default chain, runtime, multiplier as text), 挂载于, and the sharing state. 配置 is the writable side: 共享与定价 (the share switch, the multiplier, the monthly ceiling and the per-workspace ceiling overrides as one decision), 模型提供方 (one aggregate header per provider, its keys behind a disclosure), 模型链 (`ChainEditor`), 席位 and 运行时.
  - **Any other workspace** gets the same header and metric band, a read-only notice, and 使用情况 / 能力摘要 / 挂载于 — with **no tab bar at all**. A one-item tab bar would be a control that does nothing. 共享与定价, 模型提供方, 模型链, 席位 and 运行时 are **absent**, not disabled: a consumer must not see the owner's provider keys, pricing or chain mechanics. The multiplier stays visible to a consumer, because it is what makes the cost predictable before mounting the bot.
- 共享与定价 carries the share switch, the multiplier, the monthly ceiling and a 按工作区例外 list (`workspace`, ceiling, clear). The multiplier defaults to **×1** and is effective **only while sharing is on**: an own bot is never priced by it, so a non-shared bot's control is disabled and reads ×1. Ceiling and overrides follow the same rule. The section states this in one sentence; the fields stay editable while sharing is off so an owner can price before publishing, and they take effect when it is turned on.
- **Archive is the retirement state, not deletion.** A bot may be archived by its owning workspace's owner/admin from the 配置 tab's 危险区, behind a confirmation that names the three consequences: it stops being used by any review, every workspace that has it mounted sees 已归档, and it can be restored. An archived bot stays listed (with 已归档 and muted styling) rather than disappearing — the owner needs to find it to restore it, and a consumer must know why their chain stopped working. A mounted chain row renders it unavailable (the existing skipped-row treatment, labelled 已归档), and the relay skips it. While archived, 配置 is read-only except 恢复; 基本信息, pricing, providers, chain and seats are not editable.
- 配置 never repeats 能力摘要 or 挂载于; the metric band stays as its only context. Read-only facts have one home, so the two tabs cannot drift.
- The App detail keeps only the mount: each chain row links to the bot's detail and states that bot's default model chain, runtime and multiplier. The App detail header carries no bot-settings action, and the creator face carries no chain.
- The chain has one control surface per face. Move, remove and add live on the table row itself; no second copy of the chain renders beside it. The section header carries 添加机器人, matching the action placement other surfaces use.

### Units: Credits outside, RP never

RP is the platform's internal accounting unit (1,000 RP = 1 Credit). Every user-facing amount, ceiling and spend figure renders in **Credits** with exactly two decimals — the display quantum is **0.01 Credit**, and every surface rounds the same stored value the same way, so a list, a metric band and a usage section agree on the month. RP appears in no label, column, tooltip or empty state. A figure labelled 本月 is always 本月已用, and states its ceiling (`已用 / 上限`) or `不限（自有机器人）` — the reader must never guess whether the number is spend or remaining balance.

### Degraded reads degrade one control, not the page

A failed model-option read removes model *selection* only, and only on the bot's editable face. Existing chain rows still render from the payload, saving is either available or explicitly disabled with the reason, and retry is scoped to the failed read. A section never disappears into an "unavailable" state that hides values the page already holds.

## Alternatives considered

- **Keep one page selected by `can_manage`.** Rejected: `can_manage` is a permission, and an owner is simultaneously an installer and a creator, so the page cannot know which question it is answering. It also cannot produce the installed face's required bot summaries without rendering creator data beside them.
- **Split only the tabs, keeping one route and one face.** Rejected: the two faces differ in tab set, block set and write affordances, so a shared body would hide rather than remove creator controls — the spec's matrix requires field absence, not display-only hiding.
- **Give each mounted bot a sub-tab under the App.** Rejected: the App-to-bot relation is many-to-many and the chain is ordered but unbounded, so sub-tabs grow with the chain and imply the bot belongs to the App. The mount, not the tab bar, is the relation.
- **Keep a bots tab on the creator face.** Rejected: the chain is the install state's, so a tab there would edit a consumer's mount or show a chain the creator does not own. The creator's view of "who uses my bot" belongs on the bot detail's 挂载于, which is the relation seen from the bot side.
- **Filter one bot table instead of two sections.** Rejected: the two groups differ by write permission and by whose spend is shown, and a filter hides that difference behind a control the reader must discover.
- **Keep bot settings inside the App detail behind a per-bot link.** Rejected: it is what existed, and it is why the header needed an N-identical-links action; bot configuration also has an owner (the bot's workspace) unrelated to the App's owner.
- **Only restyle the current pages.** Rejected: styling leaves the installed face without bot configuration and leaves two owners for one route; the defects were structural.

## Consequences

- **One unit boundary.** The server keeps storing RP; the UI converts at the last step. A ceiling stored in RP and a figure rendered in Credits must round the same way in every surface, or the same month reads differently on a list, a metric band and a usage section. The conversion stays a display concern and never becomes a stored value; a payload that omits the credit rate falls back to the one documented rate on the SPA side.
- **Tab bars are viewer-dependent.** The owner's 概览/配置 and the consumer's no-tab bar are one route with two renderings; a shared component that always emits the tab bar would show a dead single tab to consumers, so the read-only face is pinned by absence in tests rather than by disabled controls.
- **Payload and SPA ship together.** `SettingsPayload` carries the viewer relation, and the spec's invariant that SPA and API ship in one Worker bundle holds; a mismatched deploy falls back to `can_manage` rather than rendering an empty face.
- **Archive reaches every reader.** The state lives on the bot row, and the three readers — bots list, App chain, relay — each treat it as unavailable, sharing one predicate: the read projection, the relay's chain query, the mount writer and every configuration write all test `archived_at IS NULL`, so a chain that renders a bot unavailable and a relay that still selects it cannot both be true.
- **Archive is not delete, and not a quota reset.** An archived bot keeps its usage history, overrides and mounts; restoring it resurrects nothing removed and re-prices no past usage. Nothing about archiving is a cascade — the archive column is additive, NULL means live, and rows written before it need no backfill.
- **Name and description are identity, not metadata.** They render on every surface that references a bot, so a rename needs no second write path per surface; one read returns them with the bot row.
- **The read-only bot face does not leak the owner's configuration.** The consumer read is a narrower payload than the owner's: provider names, key counts, seats, chain mechanics and the owner's raw default ceiling stay owner-only, and the consumer reads the ceiling the relay enforces on it. Serving one payload and hiding blocks in the SPA would put them in the response.
- **Bot detail has two faces over one route.** The viewer relation comes from the server; a client-side guess would render the wrong face for a workspace that is both owner and consumer.
- **URL compatibility.** Links without `from` keep working by deriving the face from the relation; the retired `/apps/:appId/bot` and `/apps/:appId/settings` redirects continue to land on the creator face, and a completed installation bind lands on the installed face.
- **Spec freshness.** `docs/specs/feature/app-detail-visibility.md` § Information architecture and § Invariants state the two faces, the three creator tabs and the install/creator split; the spec was restated in the same change that shipped them and is the current-state authority this record explains.
- **Navigation growth.** A seventh sidebar family segment means the Worker tenant gate and `WORKSPACE_FAMILY_SEGMENTS` admit `bots` for the workspace-scoped spelling; `/bots` is not reachable until that list carries it.
