# mstar-inspector

A GitHub App that self-deploys for automated PR reviews and bug detection, utilizing omp.

The Worker verifies GitHub webhooks, enqueues review jobs, runs each review in a
Cloudflare Sandbox container (real omp session with the mstar-harness plugin),
and posts the result as a single upserted comment on the PR.

## Architecture (one line)

`GitHub webhook → Worker (verify + classify) → Queue → Consumer → Sandbox (clone + omp review) → Issues comment upsert + D1 store`

## Environment variables

### Worker secrets (`wrangler secret put`)

| Var | Required | Purpose |
|---|---|---|
| `APP_ID` | yes | GitHub App ID (numeric) |
| `PRIVATE_KEY` | yes | GitHub App private key PEM (PKCS#1 or PKCS#8; OpenSSH rejected) |
| `WEBHOOK_SECRET` | yes | GitHub webhook secret (fail-closed: missing/empty/`"development"` → 500) |

### Worker settings (plain vars / `wrangler.jsonc` `vars`)

| Var | Default | Purpose |
|---|---|---|
| `REVIEW_ENABLED` | **off** | Fail-closed kill-switch. Reviews run **only** when this is exactly `"true"`. Unset or any other value → every webhook is ignored with HTTP 2xx and nothing is enqueued. Ship it unset until you are ready to go live. |

### Review runtime (injected into the sandbox container)

| Var | Purpose |
|---|---|
| `HARNESS_PLUGIN_ROOT` | Absolute path of the mstar-harness plugin root inside the review container (image default `/opt/mstar-harness`; the Dockerfile `ENV` and the consumer's exec env both use this name). |
| `OMP_REVIEW_MODEL` | Comma-separated omp model selectors. The **first** selector is the primary review model; the full list is injected as the session's `retry.fallbackChains.default` with `retry.modelFallback: true`, so a failed turn falls back through the remaining selectors. Example: `ark-plan/deepseek-v4-flash,openrouter/anthropic/claude-sonnet-4`. Unset → `ark-plan/deepseek-v4-flash` with no fallback chain. |
| `OMP_MODEL_KEY` | omp model key for the primary provider; injected into the container as `ARK_API_KEY` (exec env only, never in the image). |

## Setting provider keys: `bun run keys`

`scripts/provider-keys.ts` maps omp built-in providers to the Worker env var
name and runs `wrangler secret put <ENV>` with the value piped on stdin — the
value never appears in argv, logs, or git.

```bash
# Interactive: numbered provider picker → masked value prompt
bun run keys

# List the provider → env-name table
bun run keys --list

# Non-interactive (CI-friendly): value from --value, the provider's env var,
# or piped stdin. Unknown provider / missing value → exit 1.
bun run keys --provider openrouter --value sk-or-...
ANTHROPIC_API_KEY=sk-ant-... bun run keys --provider anthropic
echo -n "sk-ant-..." | bun run keys --provider anthropic
```

Supported providers: `anthropic`, `openai`, `gemini`, `groq`, `cerebras`,
`xai`, `openrouter`, `kilo`, `mistral`, `zai`, `minimax`, `opencode`,
`cursor`, `ai-gateway`. (`ark-plan` is a custom baseUrl provider configured in
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
- The review runner CLI: `bun run review --diff <file>` (prints the ReviewOutput JSON on stdout).
- Sandbox smoke: `bun run scripts/sandbox-smoke.ts` (see the file header).

## Deploy

```bash
wrangler deploy
```

See `.mstar/iterations/v0.2/guides/github-app-runbook.md` for the full GitHub
App setup, secret, and rollback runbook.
