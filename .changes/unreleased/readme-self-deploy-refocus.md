---
category: Changed
---

- **README refocused on self-deployment (English + 中文).** The Quick start is
  now the single self-host path; the repo's own staging path and the
  production / release-train detail moved out of both READMEs — both were
  already covered in `docs/deploy.md` / `docs/release.md`. The Architecture
  section reflects the Multi-App shape (dashboard registration, per-slug
  webhook routing, per-App encrypted credentials in D1) and the
  `DEPLOYMENT_MODE` deployment-shape switch (details linked, not inlined).
  The Chinese README additionally gains the review-behavior sections that had
  drifted out (credentials scoping, permissions, advisory Check runs, recovery
  semantics). Stale facts fixed in both: Bun `>= 1.4.0` (matches
  `package.json` engines) and review runner levels `quick|default|deep`
  (`deep` is alive per `packages/runner/src/runner.ts`).
