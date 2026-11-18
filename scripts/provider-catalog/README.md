# scripts/provider-catalog — the provider catalog pipeline

The generated provider catalog (`src/contracts/provider-catalog.generated.ts` and
`provider-model-limits.generated.ts`) is what an App's model chain resolves
against. This directory holds every input and every step that produces it.

**A directory says who owns the file.** `inputs/` is the only place a human or an
external service writes. `generated/` is output of a step and can be rebuilt
from scratch. `lib/` holds pure functions and never touches the filesystem. The
root holds executable steps, one per verb.

## Files

The table is the contract: its first column is exactly what `git ls-files
scripts/provider-catalog` reports (a test asserts the equality, so a rename must
move the row in the same commit).

| File | Is | Produced by | Changes when | Consumed by |
| --- | --- | --- | --- | --- |
| `README.md` | This contract | — | The layout changes | Humans, and `tests/scripts/provider-catalog-layout.test.ts` |
| `inputs/models.dev-2026-11-13.json` | Trimmed snapshot of `models.dev/api.json` in `{ id, name, env, api, doc, model_ids, limits }` form. The dated name is its provenance: the date is when the data last moved | `fetch-models-dev.ts` (network) | models.dev's provider/model data changes | `generate-provider-catalog.ts`, `extract-omp-snapshot.ts` |
| `inputs/overrides.json` | Hand-measured, vendor-authoritative model vocabularies, one per protocol bucket | A human, after probing the vendor endpoint | A measurement is re-taken (`fetched` moves) | `lib/overrides.ts` → `extract-omp-snapshot.ts` |
| `generated/omp-api-key-providers.json` | The omp SDK's API-key provider vocabulary + the exclusion/alias rules | `extract-omp-snapshot.ts` (installed `@oh-my-pi/pi-catalog`) | The installed omp version changes, or an override moves | `generate-provider-catalog.ts` |
| `generated/omp-provider-verify.json` | The omp `validate "models-endpoint"` entries behind the built-in verify table | `extract-omp-snapshot.ts` (same package) | The installed omp version changes | **`src/dashboard/provider-verify.ts`** (product code), `tests/worker/provider-verify.test.ts` |
| `fetch-models-dev.ts` | Step: fetch → `inputs/` (the only network in the pipeline) | — | — | `refresh-catalog.yml` |
| `extract-omp-snapshot.ts` | Step: installed package → `generated/` | — | — | `provider:catalog` |
| `bump-pins.ts` | Step: move the SDK/engine/harness pins across all five surfaces, install, verify | — | — | `refresh-catalog.yml` |
| `catalog-changes.ts` | Report: which providers and model ids a regeneration removed | — | — | `refresh-catalog.yml` (PR body) |
| `pr-verdict.ts` | Pure verdict: step outcomes + the test log → the red/green marks | — | — | `refresh-catalog.yml` (PR title/body) |
| `lib/snapshot.ts` | Pure discovery of the current snapshot + the `inputs/` `generated/` path constants | — | — | the three scripts above |
| `lib/overrides.ts` | Pure application of `inputs/overrides.json` | — | — | `extract-omp-snapshot.ts` |
| `lib/base-url.ts` | Pure rule: which base URL a declaration may prefill | — | — | `extract-omp-snapshot.ts` |

`scripts/generate-provider-catalog.ts` is **not** here: it is a product-code
generator, not a catalog input. It reads `inputs/` + `generated/` and writes
`src/contracts/`.

## The pipeline

| # | Step | Command |
| --- | --- | --- |
| 1 | Fetch the trimmed snapshot | `bun run scripts/provider-catalog/fetch-models-dev.ts` |
| 2 | Extract the omp snapshots | `bun run scripts/provider-catalog/extract-omp-snapshot.ts` |
| 3 | Generate both contracts | `bun run scripts/generate-provider-catalog.ts` |
| 4 | Repair the image-input fingerprint | `bun scripts/check-image-inputs.ts --base origin/main --write` |

Steps 2 + 3 together are `bun run provider:catalog`; the daily
`refresh-catalog.yml` runs all four. Step 4 matters only when a pin bump moved an
image input (`packages/runner/package.json`).

## Rules

- **Regenerable ≠ ignorable.** Every file under `generated/` is committed, because
  either the generator or the Worker imports it (`omp-provider-verify.json` is
  imported by `src/dashboard/provider-verify.ts`). Deleting it without re-running
  step 2 breaks the build. Nothing here is gitignored; the only `.gitignore`
  entries matching this directory are guards against a raw upstream response or a
  scratch copy ever landing in it.
- **Exactly one dated snapshot.** `fetch-models-dev.ts` compares the rendered
  payload byte-for-byte with the committed snapshot and writes nothing when they
  match — so an unchanged upstream keeps the existing file *and its date*, and a
  changed one lands as the fetch date while every older dated file is deleted. The
  date therefore marks when the data last moved, not when it was last fetched.
- **The override beats the package.** `inputs/overrides.json` is a point-in-time
  measurement of what a vendor endpoint actually serves; it is applied last and
  replaces a protocol bucket's vocabulary wholesale (a union would publish ids the
  provider rejects). `bun run provider:catalog` reapplies it on every run, so a
  hand edit to a generated file is destroyed — put the correction here instead.
  Its `fetched` date is when someone must re-measure.
- **Safe to delete:** `generated/`, and `src/contracts/*.generated.ts` (both
  rebuild with `bun run provider:catalog`). **Not safe:** `inputs/` — losing
  `models.dev-<date>.json` means a network fetch, and losing `overrides.json` means
  re-probing vendor endpoints by hand.
- **The snapshot is trimmed, never the upstream body.** A raw `api.json` (~6.7 MB,
  every model's descriptions, costs and modalities) is not a build input; the
  payload carries only what the generator consumes.
