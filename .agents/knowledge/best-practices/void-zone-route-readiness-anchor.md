---
module: deploy / hostname routing
date: 2026-11-13
problem_type: best_practice
category: best-practices
severity: medium
topic: Workers Routes cutover (inspector.mstar.page)
tags:
  - cloudflare-workers
  - workers-routes
  - void
  - readiness-probe
  - custom-domain
  - longest-match
  - workers-dev
  - preview-urls
title: "A Void-deployed Worker's readiness probe needs a hostname it is already published on"
last_updated: 2026-11-13
source: inspector.mstar.page hostname cutover; mstar-product-site deploy anchoring
---

# Void readiness needs a hostname the Worker is already published on

## Context

`inspector.mstar.page` serves two Workers from the same hostname:

| Pattern | Worker |
|---|---|
| `inspector.mstar.page/dashboard*`, `/_internal_admin*`, `/webhook/*`, `/healthz`, `/app-assets/*` | Inspector (this repo, Workers Routes on the `mstar.page` zone) |
| `inspector.mstar.page/*` | Marketing site (`mstar-product-site`, deployed through Void) |

Cloudflare resolves the longest matching pattern, so the five specific patterns win on their paths and the marketing Worker owns everything else, including `/`.

## The constraint

Void requests `GET /__void/ready` **before** it activates a version. The probe's target must be a hostname that already belongs to that Worker. Two shapes qualify, and they start qualifying at different times:

| Anchor | Qualifies |
|---|---|
| Custom Domain in `routes` (`custom_domain: true`) | at deploy time — Cloudflare creates the record and attaches the hostname as part of it |
| `workers.dev` hostname (`workers_dev: true`) | only **after** that binding has been published once |

A zone route does not qualify on its own: before activation it points at whatever else holds the zone, so probing it tells you nothing about the new version.

## Why `workers_dev` fails on a Worker that never had it published

Cloudflare publishes the `workers.dev` binding **after** a deploy succeeds, while Void probes **before** it will activate that deploy. On a Worker whose binding has never been published, nothing can satisfy the first probe — it is a deadlock, not a propagation delay.

Observed on `mstar-product-site`: deploy run `43441149739` failed with `deploy: the uploaded Worker Version did not pass /__void/ready.`, and `https://mstar-inspector-page.silent-dew-2478.workers.dev/` answered 404 while its DNS record existed. The subdomain was there; the Worker was not on it.

The remedy at that point was a preview Custom Domain as the first `routes` entry (`inspector-preview.mstar.page`, `custom_domain: true`).

## The correction: a published binding is a valid anchor

The same Worker probes fine through `workers.dev` once the binding is live:

- `https://mstar-inspector-page.silent-dew-2478.workers.dev/__void/ready` → `{"ready":true}`
- The deploy anchored on it succeeded (run `43448786213`).

Publishing the switch by hand in the dashboard made the binding live immediately, and the next automated deploy passed. The preview Custom Domain was then retired: `mstar-product-site` now carries a single route (`inspector.mstar.page/*`), `workers_dev: true`, `preview_urls: false`, and no preview hostname.

So the rule is **not** "`workers_dev` must stay off". It is:

- Never aim the probe at a hostname this Worker has not been published on.
- A Worker that has never been deployed needs a Custom Domain anchor for its first run — or a manually published `workers.dev` binding beforehand.
- Once `workers_dev` is on and published, it is a stable anchor and the preview Custom Domain is redundant.

## Two facts that decide the switches

1. **`preview_urls: true` mints a separate public hostname per version.** None of them is the probe target, and none is covered by a hostname-scoped gate (Access, WAF custom rules, page rules). Do not turn it on to make the probe work; `workers_dev` is the stable anchor.
2. **Void's probe understands Cloudflare Access.** `cf-access-*.mjs` builds `CF-Access-Client-Id` / `CF-Access-Client-Secret` from `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`; precedence is service token > user JWT (`CF_ACCESS_TOKEN`) > none. `mstar-product-site` configures none of them today, so its `workers.dev` hostname is public.

## Rules that follow

- The probe target must be a hostname the Worker is **already published on**. A zone route alone never is, before activation.
- `workers_dev: true` is the steady-state anchor once published; prefer it to carrying a preview Custom Domain forever.
- Keep `preview_urls` off — it widens the public surface and does nothing for the probe.
- Precedence inside `@void/deploy-cloudflare`: `desiredTriggerConfig.workers_dev` outranks `customRouteReadinessUrl(routes)`. With both configured the probe targets `workers.dev`; that is another reason the custom-domain anchor becomes redundant, and a reason not to leave a half-retired one in the config.
- The Inspector's own trade is the opposite one: a Custom Domain owns the whole hostname and refuses a second Worker, which is why it moved to routes and gave up its root.
- Route patterns are host-qualified and `*` is "zero or more of any character"; a literal `/` before it is part of the match, so `/x/*` never matches `/x`. The console document lives at the bare `/_internal_admin`, which is why that pattern carries no trailing slash.

## Verification for this split

- `curl -s -H 'accept: text/html' https://inspector.mstar.page/_internal_admin` → 404 whose response carries `server-timing: …cfWorker…`. The 404 is the operator gate's designed answer (never a 403, never a redirect); `cfWorker` is what proves the request reached the Worker instead of falling to the marketing route.
- `curl -s https://inspector.mstar.page/healthz` → `{"ok":true,"version":"v<tag>"}`.
- Request a hashed bundle from the login page's own HTML (`/app-assets/main-*.js`) — a 200 proves the longest match survived, since `/assets/*` now belongs to the marketing site.
- `webhook_deliveries` gains a row with `outcome = 'ok'` on the next real GitHub delivery; an unsigned `POST /webhook/x/y` answering with the Worker's own `unknown webhook path` proves reachability in the meantime.

## Window and rollback

Removing the Custom Domain and adding routes leaves the hostname unbound for 1–3 minutes unless a proxied record already exists — `zone_name` routes never create one. Rollback is a deploy of the previous tag (whose config still carries `custom_domain: true`), but a hand-created A/AAAA record for the hostname must be deleted first: a Custom Domain cannot attach over an existing record.

## How this conclusion changed

Worth keeping, because the first version of this page was wrong in a way that is easy to repeat:

1. Run `#23` — `workers_dev: true` + `preview_urls: true`, preview Custom Domain removed. Deploy failed; `workers.dev` answered 404. Read at the time as "the mechanism does not work".
2. Run `#24` — reverted to the preview Custom Domain anchor. Deploy passed. Read at the time as "the Custom Domain is required".
3. Run `#25` — the `workers.dev` switch was published by hand first, then the config kept `workers_dev: true` with a single zone route. Deploy passed.

The difference between (1) and (3) is not the mechanism but the **state of the binding when the probe ran**. State the precondition, not the switch.
