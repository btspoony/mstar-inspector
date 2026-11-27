# ADR: Separate the installed-App face from the creator face, and give Review Bots their own navigation

Status: proposed — no face split ships yet; the split record's UI section is unimplemented and this record fixes the surfaces it left open
Spec: docs/specs/feature/app-detail-visibility.md § Information architecture

## Problem

The App/bot split ([2026-11-25-github-app-review-bot-split](2026-11-25-github-app-review-bot-split.md) § UI) established three list origins — installed Apps, created Apps, usable bots — and gave the Review Bot a detail page. The shipped SPA has the list origins but not the two faces, so one detail page answers for both:

- Both list tabs emit the same href, `/apps/<github_app_id>` (`src/spa/pages/AppsPage.tsx:412`, `:827`), one route matches it (`src/spa/routes.ts:105`, `:191-192`), and the detail page receives only `appId` (`src/spa/pages/AppDetailPage.tsx:139`). The face is then chosen by `payload.can_manage` (`:806`), which is a permission, not an origin: an owner arriving from 已安装 gets the creator face, and a consumer never gets the installed face's required content.
- The installed face is identity card plus chain table (`AppDetailPage.tsx:806-823`); no mounted bot's model chain, providers or runtime appear, because `BotSettingsView` is composed only on `/bots/:botId` (`src/spa/pages/BotDetailPage.tsx:213`).
- The creator face renders all four tabs unconditionally (`AppDetailPage.tsx:838-849`), including 投递状态 and 已安装, whose data a consumer does not own.
- Bot configuration has no navigation home, so the App detail grew a header action that repeats the one-to-many mount: `BotSettingsLink` emits one identically labelled 机器人设置 anchor per chain bot, and a bots-list link when the chain is empty (`AppDetailPage.tsx:285-322`).
- App identity is stated three times in one viewport: page header (`:628-640`), the GitHub App block (`src/spa/pages/SettingsPage.tsx:400-464`) and the credentials block (`AppDetailPage.tsx:745-877`).
- The chain renders twice: a `DataTable` and a second chip row that alone carries ↑ ↓ ✕ (`AppDetailPage.tsx:566-579`, `:419-460`).
- `BotSettingsPage` is a section collection with no page frame (`src/spa/pages/BotSettingsPage.tsx:59-310`); its basic info is a flat key/value block whose 能力 lines restate the default chain as text, while the chain editor sits at the page bottom (`:237-310`, `:376-398`).
- The shipped tab set contradicts the spec, which still states two tabs (`docs/specs/feature/app-detail-visibility.md` § Information architecture, § Invariants); the split record's UI section is the newer intent.

The result is one page answering two different questions, a bot surface reachable only by leaving its App, and controls duplicated wherever a relation is one-to-many.

## Proposal

### Two origins, two faces

The detail payload states which relation the viewer has to the App, and the face follows it. A single boolean is not enough: an App this workspace both created and installed is one App with two readings, and the list it was opened from selects the reading.

| Origin | Route | Face |
| --- | --- | --- |
| 已安装的应用 | `/apps/<github_app_id>?from=installed` | App identity read-only, this workspace's install/bind state, and the mount chain this workspace owns: order, add and remove are editable by its owner/admin, read-only for a member |
| 我创建的应用 | `/apps/<github_app_id>?from=created` | creator: merged App settings, delivery, installations — three tabs and no chain |

- `SettingsPayload` gains the viewer relation (`installed`, `created`, or both). Without the query parameter the page picks `created` for a creator and `installed` for a consumer, so old links still open the face the viewer can actually use.
- The installed face renders **no** creator-only section: no credentials, no share switch, no delete/enable, no metadata refresh, no delivery tab. Its metric band carries 挂载的机器人, 安装 and 本月 spend only — a 24h rejection count is removed from the face.
- The installed face's chain is the one writer here: the installing workspace's owner/admin reorders it, removes a bot and adds another, and its rows state each bot's default model chain, runtime, multiplier and month spend. A member sees the same rows with no controls present (not disabled). This keeps the split record's rule — only the installing workspace's owner or admin edits a chain.
- The creator face keeps the App's own settings, delivery and installations, and owns no chain: the App is supply, the mount belongs to the install state. 应用设置 is ONE GitHub App section that carries the cached metadata and the credential state together (webhook URL, saved-credential line, refresh button) — there is no separate credentials block and no repository block, because review policy lives on the repository detail. The operations block stays; the share switch renders only for the official workspace, with the non-official read-only variant stated. The tab set is 应用设置 / 投递状态 / 已安装.
- Authorization stays server-side: `canManageApp` continues to gate every creator route and field, and the face is a rendering choice over two already-authorized reads, never the gate itself.

### App identity is stated once

The page header carries the display name, creator, status and the metric band. The tab body carries detail, not identity: GitHub App ID and local App ID appear once in the GitHub App block, the webhook URL once in the credentials block, and no block restates another's facts.

### Bots get a first-class entry

- The sidebar gains a bots entry: `/bots` lists every bot this workspace can use as TWO sections — 我创建的机器人 and 共享给我的机器人 — not a filter over one table; each row opens `/bots/<botId>`.
- `/bots/<botId>` is the only place a bot is configured, and it has two faces. The owner workspace's owner/admin sees `PageHeader` (name, provider workspace, sharing state), `MetricBand` (multiplier, month spend, mounted-App count), then 使用情况, 模型提供方 (one aggregate header per provider, its keys behind a disclosure), 模型链 (`ChainEditor`), 席位 and 运行时.
- Any other workspace sees the same frame and then a pure read-only face: a read-only notice, 能力摘要 (default model chain, runtime and multiplier as text), 使用情况 (this workspace's spend against its ceiling) and 挂载于 (the Apps that mount it). The provider section, the seats and every chain control are **absent**, not disabled — a consumer must not see the owner's provider keys or chain mechanics at all.
- The App detail keeps only the mount: each chain row links to the bot's detail and states that bot's default model chain, runtime and multiplier. The App detail header carries no bot-settings action, and the creator face carries no chain.
- The chain has one control surface per face. Move, remove and add live on the table row itself; no second copy of the chain renders beside it.

### Degraded reads degrade one control, not the page

A failed model-option read removes model *selection* only, and only on the bot's editable face. Existing chain rows still render from the payload, saving is either available or explicitly disabled with the reason, and retry is scoped to the failed read. A section never disappears into an "unavailable" state that hides values the page already holds.

## Alternatives considered

- **Keep one page selected by `can_manage`.** Rejected: `can_manage` is a permission, and an owner is simultaneously an installer and a creator, so the page cannot know which question it is answering. It also cannot produce the installed face's required bot summaries without rendering creator data beside them.
- **Split only the tabs, keeping one route and one face.** Rejected: the two faces differ in tab set, block set and write affordances, so a shared body would hide rather than remove creator controls — the spec's matrix already requires field absence, not display-only hiding.
- **Give each mounted bot a sub-tab under the App.** Rejected: the App-to-bot relation is many-to-many and the chain is ordered but unbounded, so sub-tabs grow with the chain and imply the bot belongs to the App. The mount, not the tab bar, is the relation.
- **Keep a bots tab on the creator face.** Rejected: the chain is the install state's, so a tab there would edit a consumer's mount or show a chain the creator does not own. The creator's view of "who uses my bot" belongs on the bot detail's 挂载于, which is the relation seen from the bot side.
- **Filter one bot table instead of two sections.** Rejected: the two groups differ by write permission and by whose spend is shown, and a filter hides that difference behind a control the reader must discover.
- **Keep bot settings inside the App detail behind a per-bot link.** Rejected: it is what exists today, and it is why the header needed an N-identical-links action; bot configuration also has an owner (the bot's workspace) unrelated to the App's owner.
- **Only restyle the current pages.** Rejected: styling leaves the installed face without bot configuration and leaves two owners for one route; the defects are structural.

## Acceptance criteria

- The repo list's 已安装的应用 and 我创建的应用 rows open different faces of the same App; the URL records the origin, and an owner opening from 已安装 does not see creator-only blocks.
- The installed face contains App identity, install/bind state and the mount chain; its App facts are read-only, its chain carries exactly one set of move/remove/add controls for the installing workspace's owner/admin, and a member sees no controls. It contains no credentials, share, delete, enable, metadata-refresh or delivery surface, and no 24h rejection metric.
- The creator face has exactly three tabs; the bots tab and every chain control are gone from it; 应用设置 renders one merged GitHub App section (metadata plus credential state), one operations block and the share switch, with no repository block.
- `/bots` exists in the sidebar and renders two sections (我创建的机器人, 共享给我的机器人); `/bots/<botId>` shows 能力摘要 on the read-only face and 使用情况/模型提供方/模型链/席位/运行时 on the editable one.
- The read-only bot face contains no provider block, no key list, no seat control and no chain control — asserted by absence, not by disabling.
- The App detail header contains no bot-settings action; the App detail renders no identity fact twice.
- A failed model-option read leaves existing chain rows visible on the editable bot face and states what the reader can still do.
- `canManageApp` still refuses every creator route and field for a non-manager; the chain write on the installed face is authorized by installer owner/admin on the server, never by the rendered face.

## Risks

- **Payload and SPA ship together.** `SettingsPayload` gains the viewer relation, and the spec's invariant that SPA and API ship in one Worker bundle holds; a mismatched deploy must fall back to `can_manage` rather than render an empty face.
- **Two authorization readings on one page.** The installed face's chain write needs the installer owner/admin check (the chain's owner), while the App's own fields stay creator-gated; a page that renders both must not derive either permission from the face it is showing.
- **Read-only bot face must not leak the owner's configuration.** The consumer read has to be a narrower payload than the owner's: provider names, key counts, seats and chain mechanics stay owner-only. Serving one payload and hiding blocks in the SPA would put them in the response.
- **Bot detail has two faces over one route.** The viewer relation (`bot owner/admin` vs consumer) must come from the server; a client-side guess would render the wrong face for a workspace that is both owner and consumer.
- **URL compatibility.** Links without `from` keep working by deriving the face from the relation; the retired `/apps/:appId/bot` and `/apps/:appId/settings` redirects continue to land on the creator face.
- **Spec drift.** `docs/specs/feature/app-detail-visibility.md` § Information architecture and § Invariants still describe a two-tab detail; shipping this record requires restating them, in the same change that ships the faces.
- **Navigation growth.** A seventh sidebar family segment means the Worker tenant gate and `WORKSPACE_FAMILY_SEGMENTS` must admit `bots` for the workspace-scoped spelling; `/bots` is not reachable until that list lands.
