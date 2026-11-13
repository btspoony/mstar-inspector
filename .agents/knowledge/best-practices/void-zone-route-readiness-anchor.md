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
title: "A Void-deployed Worker on a zone route needs an activated hostname as its readiness anchor"
last_updated: 2026-11-13
source: inspector.mstar.page hostname cutover
---

# Void readiness needs an activated hostname — keep the preview anchor

## Context

`inspector.mstar.page` serves two Workers from the same hostname:

| Pattern | Worker |
|---|---|
| `inspector.mstar.page/dashboard*`, `/_internal_admin*`, `/webhook/*`, `/healthz`, `/app-assets/*` | Inspector (this repo, Workers Routes on the `mstar.page` zone) |
| `inspector.mstar.page/*` | Marketing site (`mstar-product-site`, deployed through Void) |

Cloudflare resolves the longest matching pattern, so the five specific patterns win on their paths and the marketing Worker owns everything else, including `/`.

## The constraint

Void's readiness probe requests `/__void/ready`. That probe needs a hostname **already activated** on the Worker. A Worker whose only routing is a zone route on a hostname with no DNS record has no target to probe, so the first deploy of a route-only Worker fails.

The marketing Worker therefore keeps `inspector-preview.mstar.page` as its readiness anchor and adds the `inspector.mstar.page/*` route alongside it. The preview hostname is **not** a leftover from an earlier shape — deleting it removes the only hostname the probe can reach, and the next deploy fails.

## Rules that follow

- Never clean up `inspector-preview.mstar.page` as "unused": it is the probe path, not user traffic.
- A Custom Domain is the opposite trade for the Inspector: it owns the whole hostname and refuses a second Worker. That is why the Inspector moved to routes and gave up its root.
- Route patterns are host-qualified and `*` is "zero or more of any character"; a literal `/` before it is part of the match, so `/x/*` never matches `/x`. The console document lives at the bare `/_internal_admin`, which is why that pattern carries no trailing slash.

## Verification for this split

- `curl -s -H 'accept: text/html' https://inspector.mstar.page/_internal_admin` → 404 whose response carries `server-timing: …cfWorker…`. The 404 is the operator gate's designed answer (never a 403, never a redirect); `cfWorker` is what proves the request reached the Worker instead of falling to the marketing route.
- `curl -s https://inspector.mstar.page/healthz` → `{"ok":true,"version":"v<tag>"}`.
- Request a hashed bundle from the login page's own HTML (`/app-assets/main-*.js`) — a 200 proves the longest match survived, since `/assets/*` now belongs to the marketing site.
- `webhook_deliveries` gains a row with `outcome = 'ok'` on the next real GitHub delivery; an unsigned `POST /webhook/x/y` answering with the Worker's own `unknown webhook path` proves reachability in the meantime.

## Window and rollback

Removing the Custom Domain and adding routes leaves the hostname unbound for 1–3 minutes unless a proxied record already exists — `zone_name` routes never create one. Rollback is a deploy of the previous tag (whose config still carries `custom_domain: true`), but a hand-created A/AAAA record for the hostname must be deleted first: a Custom Domain cannot attach over an existing record.
