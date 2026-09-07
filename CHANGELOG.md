# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Version sections are assembled
from [`.changes/`](.changes/README.md) fragments at release time — see that README for the
fragment format and the per-change commit flow.

## [Unreleased]

## [1.0.0-alpha.1] - 2026-09-07

### Added

- Added a **GitHub Actions release chain**: the manually-triggered **Release prep** workflow assembles changelog fragments, bumps the version surface, validates, and opens a `release vX` PR; merging it triggers the **Release** workflow, which re-verifies on the merge commit and cuts an annotated tag plus a bilingual GitHub Release. Releasing is fully decoupled from deploying — staging automation is untouched.
- Established the **bilingual changelog fragment protocol** (`.changes/`): every change ships a fragment with paired English / Chinese bullets, assembled into `CHANGELOG.md` / `CHANGELOG_CN.md` at release time and archived per released version.
- **Version visibility**: `/healthz` now reports the deployed version and the dashboard displays it (single source `package.json#version`), with consistency pinned by `release:validate`.
- **Release ↔ deploy reconciliation**: release notes record the deployed Worker Version ID, sandbox image digest, and deploy run link from deploy evidence — never blocking the tag, and stating explicitly when evidence is missing.

### Baseline

- **Automated PR reviews as real agent sessions**: every review runs a multi-seat coding-agent session inside a one-shot Cloudflare Sandbox container (clone → review → destroy), with no secrets baked into the image.
- **Review pipeline**: GitHub webhooks land on a Hono Worker gateway (per-App routing + signature verification) → Cloudflare Queues → Sandbox execution → one upserted PR comment plus structured `mstar.review/v1` findings stored in D1.
- **Review engine**: `/amazing-pr-review` multi-tier reviews (quick / default / deep) with classified findings, line comments, model-chain fallback, and persisted review version records.
- **Operational hardening**: per-App sandbox image management, a fixed provider allowlist, rate limiting, Cron-based monitoring, and fail-closed review semantics — a misconfigured App fails loudly on its own credentials, never on someone else's.
- **Insights**: finding fingerprint deduplication and per-App Health reports turn stored findings into recurrence and quality signals.
- **Deploy automation**: a full GitHub Actions chain — CI on PRs, automated staging deploys with secrets injection, D1 migrations, post-deploy smoke, and image-digest records.
- **Dashboard platform**: register and operate any number of GitHub Apps from one deployment, each with its own access control, BYOK provider keys, model chain, and operations surface (pause/resume, settings, member management).
- **Dashboard experience**: a bilingual (en / zh-CN) Vite SPA with a shadcn-based visual system, redesigned information architecture, per-App sandbox image registry selection, and feedback-driven polish.

