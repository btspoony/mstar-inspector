# ADR: Retire the install claim — GitHub's setup redirect never reaches this app

Status: implemented — the claim table, both callback routes and the claim UI are gone; an installation is recorded by the `installation.created` webhook alone
Date: 2026-11-20
Supersedes: `.agents/adr/implemented/feature/2026-11-15-shared-bot-scope-and-claiming.md` — the claim half only; that record's scope and official-workspace designation stand unchanged

## Problem

The shared-bot record introduced `install_claims` to bridge one gap it took as given: GitHub's setup redirect carries `installation_id` and `setup_action` but no `state`, so a browser-delivered installation id proves nothing about which App it belongs to. The claim recorded the intent before sending the manager to GitHub, and `/bot/setup` bound the installation to whichever live claim the signed-in session held.

The premise never held here. Every App is created through the manifest conversion flow (`src/dashboard/manifest.ts`), and that manifest declares no `setup_url` — the field does not appear in the file. GitHub therefore never redirects to `/bot/setup`, no claim is ever consumed, and the "Claim an installation" button in App settings was a control whose only effect was a row nothing reads.

The installation was never the missing piece. `installation.created` arrives on the App's own webhook with the installation's `account.login` and writes `bot_installations` directly; the 已安装 tab and the bind action both read that table. So the dead claim carried a cost that did not stop at dead code: the bind action reused the claim batch to write the same row, which bound a workspace-initiated action to the claim's `scope = 'shared'` predicate, and the claim's absence made the install block render a "this App has no GitHub slug" explanation for a shared bot that had simply not been installed yet.

## Decision

Four facts, each with one writer:

- **No intent table.** `install_claims` is dropped (`migrations/0081_drop_install_claims.sql`). Nothing records a pre-install intent, because nothing needs one.
- **No callback route.** `/bot/setup` (`GET` and `POST`), `install-setup.ts`, `POST …/api/apps/:appId/claim` and `install-claims-store.ts` are deleted. The manifest stays as it is: the setup URL is not part of this deployment's App shape.
- **The webhook records installations.** An `installation.created` delivery writes `bot_installations` with the installation's own `account.login` (authoritative), and an `installation.deleted` delivery stamps `removed_at`. Nothing else creates an installation row.
- **Binding writes that row directly.** `POST …/api/apps/:appId/bind-installation` keeps its path and its shared-only bar and calls the same `upsertInstallation` the webhook uses — the conflict-tolerant `ON CONFLICT (bot_id, installation_id)` upsert — after confirming the named installation answers the pending read. It creates and consumes nothing.

A shared bot with no bound installation now shows the same plain GitHub install link as an owned bot, and the pending list sits under it.

## Alternatives considered

- **Set `setup_url` so the claim starts working.** This buys a second write path for an installation the webhook already records, plus a table and two routes to keep alive; the redirect would only ever re-record a row that arrived anyway. It also makes installation state depend on whether the manager happened to start from the dashboard.
- **Keep the table, delete only the button.** A table with no writer and no reader is the same dead weight one layer down, and the next reader would take it for live state.
- **Keep the bind action on the claim batch.** The batch exists to consume an intent that no longer exists. Reusing it also made a dashboard write inherit the claim's `shared` predicate rather than the webhook's, so the two paths disagreed about which bots can carry an installation.
- **Drop the bind action's shared-only bar as well.** The pending read already answers a workspace's own bots, so this is a plausible extension — but it is a separate product decision about owned-bot attribution, not part of removing a dead mechanism.
- **Drop the table without a migration.** Deployed databases carry `install_claims` rows and indexes; leaving the table behind is exactly the leftover this record removes.
- **Trust the callback's `installation_id` and bind on the `GET`.** The value is caller-supplied and arrives by top-level navigation, so a prefetched or mailed link would attach an installation the visitor never installed. This stands as a reason the delete is safe: there is no window in which an unverified id can write.

## Consequences

- `0081` is forward-only and drops the table with any in-flight rows. Those rows were intents that could never bind anything, so the loss is nil — but the migration cannot be rolled back to restore them.
- The webhook is the single source of installation state, so a target's pending list stays empty until GitHub delivers `installation.created`. That ordering was already true; it is now the only path, and a webhook delivery failure is visible as a missing pending row rather than masked by a claim.
- The claim's `bot_not_shared` refusal disappears with the batch. The bind route keeps its own `404 bot is not shared` at the top, which is the equivalent refusal and the only one a caller could observe.
- A deployment that had configured `setup_url` by hand outside this repository would now land on a 404. No code path in this repository ever set it, and the manifest remains the single App-creation route.
- Removing the claim fixed the install block: a shared bot with no bound installation renders its GitHub link instead of the "no slug" explanation, which had been reachable only because the claim replaced the link.

