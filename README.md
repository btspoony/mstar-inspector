# mstar-inspector

A GitHub App that self-deploys for automated PR reviews and bug detection, utilizing omp.

The Worker verifies GitHub webhooks on the per-App route
(`POST /webhook/:appSlug` — the only review entry; each registered GitHub App
gets its own slug), enqueues review jobs, runs each review in a Cloudflare
Sandbox container (real omp session with the mstar-harness plugin), and posts
the result as a single upserted comment on the PR.

## Architecture (one line)

`GitHub webhook → POST /webhook/:appSlug (verify + classify) → Queue → Consumer → Sandbox (clone + omp review) → Issues comment upsert + D1 store`

## Environment variables

### Worker secrets (`wrangler secret put`)

There are no Worker-level GitHub App secrets: each App's credentials (private
key + webhook secret) are stored encrypted in D1 and resolved per slug at
request time. The full Worker-secrets inventory (dashboard OAuth, session, D1
encryption key, alert webhook) lives in `docs/deploy.md` § Secrets and vars
inventory — provider keys and the model chain are NOT Worker secrets (they
are per-App; see below).

### Worker settings (plain vars / `wrangler.jsonc` `vars`)

| Var | Default | Purpose |
|---|---|---|
| `REVIEW_ENABLED` | **off** | Fail-closed kill-switch. Reviews run **only** when this is exactly `"true"`. Unset or any other value → every webhook is ignored with HTTP 2xx and nothing is enqueued. Ship it unset until you are ready to go live. |

### Provider keys and the model chain: per App only (plan 24 / AL-24-5)

Provider API keys and the review model chain are configured **per App** on
the dashboard Settings page (`/dashboard/apps/<slug>/settings`) — keys are
stored encrypted in D1, the chain is plaintext configuration. Every key the
review container needs — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `AZURE_OPENAI_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`,
`KILO_API_KEY`, `MISTRAL_API_KEY`, `ZAI_API_KEY`,
`UMANS_AI_CODING_PLAN_API_KEY`, `MINIMAX_API_KEY`, `OPENCODE_API_KEY`,
`CURSOR_ACCESS_TOKEN`, `AI_GATEWAY_API_KEY`, `WAFER_SERVERLESS_API_KEY`,
and `ARK_API_KEY` (the `ark` entry — the in-image `ark-plan` base provider's
key, `sandbox-image/omp-models.yml`) — is injected into the review container
from the App's own config only, through the `PROVIDERS` allowlist in
`src/pipeline/providers.ts`; arbitrary Worker or shell env never reaches
reviews. Custom providers declared on the same page are injected under
`CUSTOM_<ID>_API_KEY`.

The **Model chain** field on the same page is the ONLY chain source — the
deployment-level `OMP_REVIEW_MODEL` / `OMP_MODEL_KEY` knobs were retired
(plan 24). An App with no chain — or a chain whose provider has no
configured key — fails its reviews closed: the message is rejected **after**
App resolution with a structured failure (`review failed` log + a
`review_failures` row with `stage=pipeline`), retried by the queue, then
DLQ'd. Configure every App's chain and keys before enabling reviews for it
(`REVIEW_ENABLED=true`); the App settings page is the operator's visibility
entry for the fail-closed state.

## Local development

```bash
bun install
bun run typecheck
bun test
```

- Local `wrangler dev` secrets go in `.dev.vars` (gitignored) — see `.env.example`.
- The review runner CLI (in-image entry): `bun run review --level <quick|default> --input <json-file>` (prints the mstar.review/v1 envelope JSON on stdout).
- Sandbox smoke: `bun run scripts/sandbox-smoke.ts` (see the file header).

## Deploy

```bash
wrangler deploy
```

See `.mstar/iterations/v0.2/guides/github-app-runbook.md` for the full GitHub
App setup, secret, and rollback runbook.
