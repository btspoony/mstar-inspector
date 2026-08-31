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
request time. The full secrets inventory (dashboard OAuth, session, D1
encryption key, model key, alert webhook, provider keys) lives in
`docs/deploy.md` § Secrets and vars inventory.

### Worker settings (plain vars / `wrangler.jsonc` `vars`)

| Var | Default | Purpose |
|---|---|---|
| `REVIEW_ENABLED` | **off** | Fail-closed kill-switch. Reviews run **only** when this is exactly `"true"`. Unset or any other value → every webhook is ignored with HTTP 2xx and nothing is enqueued. Ship it unset until you are ready to go live. |

These vars are read from the **Worker environment** and forwarded by the
queue consumer into the review container's exec env (`OMP_REVIEW_MODEL` only
when set; `OMP_MODEL_KEY` always). Set them on the Worker (`wrangler secret
put` / `wrangler.jsonc` vars; `.dev.vars` for local `wrangler dev`) — values
set only in your shell never reach reviews.

### Provider API keys (bugbot PR-3 BB-2)

The review container authenticates fallback providers from their standard
API-key env names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`COPILOT_GITHUB_TOKEN`, `AZURE_OPENAI_API_KEY`, `GROQ_API_KEY`,
`CEREBRAS_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `KILO_API_KEY`,
`MISTRAL_API_KEY`, `ZAI_API_KEY`, `UMANS_AI_CODING_PLAN_API_KEY`,
`MINIMAX_API_KEY`, `OPENCODE_API_KEY`, `CURSOR_ACCESS_TOKEN`,
`AI_GATEWAY_API_KEY`, `WAFER_SERVERLESS_API_KEY`). The queue consumer
forwards **every known provider key that is present and non-empty on the
Worker** into the container's exec env — and only the known allowlist (the
`PROVIDERS` mapping in `src/pipeline/providers.ts`, shared with
`scripts/provider-keys.ts`), never arbitrary Worker env.

Keys therefore **must also be set on the Worker** to reach reviews —
`bun run keys` does exactly this (it runs `wrangler secret put <ENV>`). Keys
set only locally (`.dev.vars`, shell) never reach the container.

## Setting provider keys: `bun run keys`


The mapping is shared with the queue consumer
(`src/pipeline/providers.ts`) — the same env names the container reads, so a
key set here is automatically forwarded into reviews (see **Provider API
keys** above).

```bash
# Interactive: numbered provider picker → masked value prompt
bun run keys

# List the provider → env-name table
bun run keys --list

# Non-interactive (CI-friendly): value from the provider's env var or piped
# stdin — both keep the secret out of argv. `--value sk-or-...` works too but
# puts the key in the process table; use it only in a contained CI runner.
# Unknown provider / missing value → exit 1.
ANTHROPIC_API_KEY=sk-ant-... bun run keys --provider anthropic
echo -n "sk-ant-..." | bun run keys --provider anthropic
bun run keys --provider openrouter --value sk-or-...   # contained CI only
```

Supported providers: `anthropic`, `openai`, `gemini`, `copilot`,
`azure-openai`, `groq`, `cerebras`, `xai`, `openrouter`, `kilo`, `mistral`,
`zai`, `umans`, `minimax`, `opencode`, `cursor`, `ai-gateway`,
`wafer-serverless`. (`ark-plan` is a custom baseUrl provider configured in
`sandbox-image/omp-models.yml` — its key is `OMP_MODEL_KEY`, not a built-in.)

### GitHub Actions snippet

```yaml
- name: Set provider key on the deployed Worker
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  run: bun run keys --provider anthropic
```

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
