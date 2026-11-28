---
module: dashboard Apps/Bots surfaces (SPA and Worker)
date: 2026-11-28
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
applies_when:
  - one route must answer for more than one relation to the same resource
  - a retirement state must be honoured by every reader and every writer
  - a stored unit and a displayed unit meet in one figure
  - a UI branch is standing in for an authorization rule
tags:
  - route-face
  - read-projection
  - lifecycle-state
  - authorization
  - credits
  - multi-tenant
related_components:
  - src/dashboard/index.ts
  - src/dashboard/apps-store.ts
  - src/dashboard/app-config-store.ts
  - src/worker/select-review-bot.ts
  - src/contracts/rp-limits.ts
---

# A face is a projection; a lifecycle state is a predicate

## Problem

One GitHub App has two legitimate readings — what this workspace mounted, and what it created — and the same workspace can be both reader and creator at once. The first attempt answered for both on one route, chose the reading from `can_manage`, and duplicated the mount chain into every surface that mentioned a bot. Bot configuration, meanwhile, had no owner-facing home, and a bot's retirement was heading for a cascade delete because nothing else expressed "kept, but not runnable".

The reusable difficulty is not the screen: it is that a *viewer's relation* to a resource, a resource's *lifecycle state*, a *unit boundary* and an *authorization boundary* are four different facts, and each fails quietly when expressed by the wrong mechanism. This document states the mechanisms that survived; the surfaces themselves and their decisions live in [the spec](../../../docs/specs/feature/app-detail-visibility.md) and [the ADR](../../adr/implemented/architecture/2026-11-27-app-installed-face-and-bot-navigation.md).

## What does not work

- **Deriving the face from a permission.** `can_manage` is true for an installer manager and for a creator, so it cannot say which question the page is answering; an owner arriving from the installed list got the creator face while a consumer never got the installed one.
- **Choosing the face from the URL alone.** A link is not a relation: an installed-only App stays a mount whatever `?from=` says.
- **Serving one payload and hiding blocks in the SPA.** Hiding is not authorization; the owner's provider keys, prices and chain mechanics ride the response unless the server projects a narrower payload.
- **Honouring a retirement state in the reader only.** A chain row that renders a bot unavailable while the relay still selects it, or a writer that still edits its configuration, is worse than neither half.
- **Re-applying a write bound on the read path.** A legal price edit or the removal of a sub-1 factor lifts an already-admitted aggregate past the write bound; refusing it at read time turns the whole list into a load error for data no rule forbids.
- **Converting units per surface.** Two surfaces that round the same stored value differently make one month read two ways.

## Working rules

### The served relation picks the face; the URL only breaks a tie

The payload carries a relation computed from facts that hold for **every** member — does this workspace own the resource, and does it reach it another way (`src/dashboard/index.ts:5122-5133`, `:5154-5157`). The face follows it; `?from=` selects between faces only when the relation is `both`, and the absent parameter defaults to the owner's creation (`src/spa/pages/AppDetailPage.tsx:141-144`). The relation must not be derived from the role, because the SPA renders the face before it learns whether the viewer manages.

The payload that comes back is then projected separately for whom it reaches: the creator's App-wide policy slice is withheld from an installer manager (`src/dashboard/index.ts:2606-2650`, `:2733-2748`), and a bot's writable sections, overrides and raw ceiling are withheld from every workspace but the owner's manager (`:3565-3576`). Reader capability is served as its own fact (`can_edit_chain`, `:5145-5147`) rather than inferred from the relation.

### One predicate per lifecycle state, and it rides every statement

Archive is a column, not a delete: `archived_at IS NULL` means live, so rows written before the column need no backfill and a restore is the same column cleared (`migrations/0127_review_bots_archived.sql`). The predicate is one string repeated at every place the state matters, and each place is load-bearing:

- the relay's chain query, so an archived bot is skipped exactly like an unshared one (`src/worker/select-review-bot.ts:48-54`);
- the mount writer's admission guard, so a NEW mount cannot be an archived bot, and the price guard counts an archived row as `1` exactly as the served projection does (`src/dashboard/apps-store.ts:1837`, `:1879`);
- the chain copy and revival paths, so binding an installation never mounts one (`:582`, `:678`);
- the read projection, which keeps the row, its recorded spend and its mount while dropping the owner-only facts (`:1990-1992`, `:2055`);
- every configuration write, both as a guard before the batch and inside each statement, so an archive landing between them changes zero rows instead of configuring a locked bot (`src/dashboard/app-config-store.ts:993-1024`).

The only write an archived row accepts is the flag itself: `botWriteAuthority(..., "archive")` skips the archived refusal, every other mode keeps it (`src/dashboard/apps-store.ts:3089-3105`), and `setBotArchived` is the single writer (`:3210-3229`). Retirement that must stay reversible is therefore a state plus one transition pair — never a cascade, and never a second predicate invented by the surface that happens to render it.

### One unit boundary: store internal, render external, convert once

The ledger stores the internal unit (RP); every user-facing amount is a derived value rendered in Credits at a fixed quantum of two decimals (`src/spa/pages/data.ts:2774-2776`). The rate travels with the payload and is **optional**: when the operator profile is unreadable the field is omitted and the SPA applies the one documented fallback, because a missing rate must degrade a figure, not fail the page (`src/dashboard/index.ts:2619-2626`).

Conversion is display-only, so the conversion helper takes the stored value and the rate — it never writes a converted amount back. The mirror rule is on the server: a rate or a price has a write domain and a wider read domain, so legacy rows still open (`src/contracts/rp-limits.ts:130-147`), while the charge itself re-validates base, multiplier and price at the moment money moves, refusing rather than metering an unrepresentable amount (`src/store/quota-store.ts:193-196`, `src/store/usage-store.ts:200-218`, `:240-270`).

### Aggregates are computed order-independently, degrade to `null`, and never reuse a write bound as a read bound

A chain's factor is the product of its mounted multipliers. It is computed in the order the request holds and the served value reduces in, so an exactly-at-bound chain is admitted on the same bits the reader accepts (`src/dashboard/apps-store.ts:1875-1896`). Two bounds are deliberately different objects:

- `CHAIN_MULTIPLIER_MAX` bounds what a **new mount** may produce (`src/contracts/rp-limits.ts:21-33`, `:56`);
- `isServedChainProduct` accepts any positive finite product on read (`:87-95`), because a price edit or a removal can lift an admitted product and no rule forbids the result.

A product outside the double range degrades to `null` and renders its unavailable marker (`src/dashboard/apps-store.ts:1990-2055`); it never fails the list, and the charge path still refuses it where the money is taken. The same rule governs the write guard: rows the viewer may not price and archived rows count as `1`, so the guard folds exactly the factors the served value folds and the two cannot drift (`:1790-1805`).

### Three owners, three checks; a face is never the gate

Three different subjects authorize three different operations, and collapsing them is how a read-only face becomes a write hole:

| Operation | Subject checked | Where |
| --- | --- | --- |
| Creator routes and fields, App-wide policy | App's owning workspace + owner/admin | `canManageApp` (`src/dashboard/index.ts:2020`), creator projection (`:2609-2650`) |
| Chain rewrite | the install state's own workspace + owner/admin | `replaceInstallChain`'s own install row (`src/dashboard/apps-store.ts:1807-1817`), `chainCapabilityOf` (`src/dashboard/index.ts:5145-5147`) |
| Bot configuration | the bot's owning workspace + owner/admin, bound to the target id | `requireBotWrite` (`src/dashboard/app-config-store.ts:993-1010`), `botWriteAuthority` (`src/dashboard/apps-store.ts:3089-3105`) |

A rendering choice may *mirror* one of these — a member sees no chain controls, a consumer sees no provider block — but the check is always on the request path, and the face is verified by **absence** in tests, not by disabled controls. The delivery log is the instructive exception: it is member-readable and workspace-narrowed while its summary stays manager-only, which is why the rule is "each read states its own gate", not "the page has one gate".

## Why

Each mechanism fails in a different direction when expressed by the wrong one. Permission-derived faces flip identity mid-session. URL-derived faces open a page the viewer cannot use. Hidden-but-served data leaks through the response. A retirement predicate enforced in one reader produces half-retired resources that are more confusing than either state. A write bound reused on read converts correct data into a load error. Two units with per-surface conversion disagree on the same month. An authorization rule expressed by rendering disappears the moment a client crafts the request. Stating each as its own fact, with one owner and one home, keeps a rendering change from silently editing a contract.

## Checks

- The relation → face mapping, including each relation with and without `?from=`: `tests/worker/app-detail-relation.test.ts`, `tests/spa/app-detail-installed-face.test.tsx`, `tests/spa/app-bot-ux-contract.test.tsx`.
- Absence of creator/consumer-only facts in the narrower payloads, across surfaces: `tests/spa/app-detail-creator-face.test.tsx`, `tests/spa/bot-detail-faces.test.tsx`, `tests/worker/app-permission-matrix.test.ts`.
- The archive predicate at every site, and the restore pair: `tests/store/review-bots-archived-migration.test.ts`, `tests/worker/select-review-bot-archived.test.ts`, `tests/worker/bot-profile-pricing-archive.test.ts`, `tests/store/install-chain.test.ts`.
- The one RP domain and its charge-time refusal: `tests/worker/rp-domain.test.ts`, `tests/worker/rp-domain-relay.test.ts`, `tests/worker/apps-store.test.ts`.
- Credits rendering and the no-`RP` scanner: `tests/spa/app-bot-ux-contract.test.tsx`, `tests/i18n/i18n.test.ts`.
