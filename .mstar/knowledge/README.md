# Knowledge Index

Implementation SSOT and reusable designs. Each document lives at `<category>/<slug>.md`; register new docs here. Maintained via `mstar-compound` / `mstar-compound-refresh`.

| Document | Source Plan | Description | Status |
|-----------|-------------|-------------|--------|
| [`best-practices/omp-review-session-isolation.md`](best-practices/omp-review-session-isolation.md) | 02-omp-review-spike | Verified pi-coding-agent SDK surface for one-shot read-only offline review sessions; Settings.isolated fetch gating; defensive parse rules | Active |
| [`best-practices/probot-bun-gateway.md`](best-practices/probot-bun-gateway.md) | 01-probot-gateway-spike | Probot 14.3.2 on Bun 1.4.0 gateway rules: no-listen factory, fail-closed webhook secret, Installation Token discipline, Workers-portability lens | Archived（2026-08-26：Probot 路线退役，见 Hono+Octokit 知识） |
| [`best-practices/cloudflare-sandbox-review-isolation.md`](best-practices/cloudflare-sandbox-review-isolation.md) | 06-sandbox-review-pipeline | Verified @cloudflare/sandbox 0.12.8 surface, binding triple, trusted-exec pattern, perf envelope | Active |
| [`runtime-errors/github-app-pem-workerd.md`](runtime-errors/github-app-pem-workerd.md) | 04-gateway-worker | PKCS#1→PKCS#8 pure-JS wrap for workerd WebCrypto JWT minting; universal-github-app-jwt #crypto divergence | Active |
| [`best-practices/d1-batch-atomicity.md`](best-practices/d1-batch-atomicity.md) | 05-review-store | D1 db.batch as transactional primitive; WHERE EXISTS guard for idempotent duplicate branch | Active |
| [`best-practices/github-app-headless-verification.md`](best-practices/github-app-headless-verification.md) | 04-gateway-worker | JWT→installations→tokens→fetchPrDiff headless live-verification pattern (no smee) | Active |
| [`best-practices/mstar-review-v1-artifact-store.md`](best-practices/mstar-review-v1-artifact-store.md) | 07-review-engine | Persist mstar.review/v1 via D1 ArtifactStore; engine validate on put | Active |
| [`best-practices/workers-dashboard-oauth-host-cookies.md`](best-practices/workers-dashboard-oauth-host-cookies.md) | 08-dev-dashboard-scaffold | GitHub OAuth + __Host- cookies on Workers; token Accept application/json | Active |
