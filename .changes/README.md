# Changelog fragments

This directory holds per-change **changelog fragments** that `scripts/prepare-release.ts`
assembles into `CHANGELOG.md` / `CHANGELOG_CN.md` at release time.

## Workflow

1. **During development**, add one fragment per logical change to `unreleased/`:
   `unreleased/<slug>.md` (e.g. `unreleased/release-pr-chain.md`). Commit it with the change.
   **Do not** paste the same bullets into `CHANGELOG.md` / `CHANGELOG_CN.md` (including under
   `## [Unreleased]`) — those files are assembled at release time.
2. **At release time**, `bun run release:prepare -- <version>` (or the **Release prep**
   GitHub Actions workflow) reads every `unreleased/*.md`, inserts a `## [<version>] - <date>`
   section into both changelogs, bumps every version surface (`package.json` and the
   generated `src/version.ts` — one `VERSION_SURFACES` list), and **moves**
   the consumed fragments into `archive/<version>/`.
3. The prepared changes ship as a `release vX.Y.Z` PR; merging it tags the verified merge
   commit and publishes a bilingual GitHub Release. The cut walkthrough (Actions steps,
   first-cut checklist, failure paths) lives in [`docs/release.md`](../docs/release.md) —
   not duplicated here.

## Fragment format

```markdown
---
category: Added        # optional; drives the `### <Category>` header. Default: Changed.
---

- English bullet (markdown). Use **bold** lead-ins like the real changelogs.
- Another English bullet.

<!-- CN -->
- 中文要点（markdown）。
- 另一条中文要点。
```

- **`category`** is the only frontmatter key. It drives the `### <Category>` section header
  under the version section (e.g. `Added` / `Changed` / `Fixed`). Default: `Changed`.
- **Inline `# comments`** in frontmatter values are stripped at parse time — the value ends at
  the first ` # …` (whitespace-preceded `#`). The `# optional` annotations in the example
  above are for humans and never reach the section header.
- The body before `<!-- CN -->` is English and lands in `CHANGELOG.md`; the body after it is
  Chinese and lands in `CHANGELOG_CN.md`. The two blocks are paired — write both.
- If a fragment omits the `<!-- CN -->` block, its English bullets are reused verbatim for
  the Chinese changelog section.
- Version sections are purely fragment-driven: there is no auto-generated version-alignment
  block (a version bump is visible in the release PR diff itself).
- Version shapes: changelog section headers and archive directories use the bare version
  (`## [X.Y.Z]`, `archive/X.Y.Z/`); tags, `release/vX.Y.Z` branches, and `release vX.Y.Z`
  PR titles use the `v`-prefixed form.

## Example

```markdown
---
category: Fixed
---

- Fixed webhook signature verification to use the App's own decrypted webhook secret.

<!-- CN -->
- 修复 webhook 签名验证改用该 App 自身解密后的 webhook secret。
```
