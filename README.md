<div align="center">

<img src="assets/logo.svg" alt="Morning Star Inspector" width="96">

# [Morning Star Inspector](https://github.com/btspoony/mstar-inspector)

Self-hosted GitHub App for automated PR reviews

English / [中文](README_CN.md)

[![CI](https://img.shields.io/github/actions/workflow/status/btspoony/mstar-inspector/ci.yml?branch=main&style=flat-square&label=CI&labelColor=black)](https://github.com/btspoony/mstar-inspector/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/btspoony/mstar-inspector?color=c4f042&labelColor=black&style=flat-square)](https://github.com/btspoony/mstar-inspector/commits/main)

</div>

**mstar-inspector** is a self-hosted GitHub App that reviews pull requests the
moment they open or update. Each review runs as a real multi-seat coding-agent
session inside an isolated Cloudflare Sandbox container, posts its result as a
single upserted comment on the PR, and stores structured findings in D1 for
later analysis.

- **Multi-App from one deployment** — register any number of GitHub Apps through the dashboard; each gets its own slug, encrypted credentials, BYOK provider keys, and model chain
- **Isolated execution** — every review runs in a one-shot Cloudflare Sandbox container (clone → review → destroy), with no secrets baked into the image
- **Structured results** — reviews emit a `mstar.review/v1` envelope (verdict + classified findings) stored in D1, so dedup, recurrence, and health analytics are possible later
- **Fail-closed by design** — a global kill-switch gates everything, and every App must bring its own provider keys and model chain: a misconfigured App's reviews fail loudly, never on someone else's credentials

## Architecture (one line)

```
GitHub webhook → POST /webhook/:appSlug (verify + classify) → Queue → Consumer → Sandbox (clone + agent review) → Issues comment upsert + D1 store
```

## Quick start

> Prerequisites: a [Cloudflare](https://developers.cloudflare.com/workers/) account (Workers + D1 + Queues), a GitHub account, and [Bun](https://bun.sh) ≥ 1.3.14 locally. The full runbook — including Cloudflare resource setup and D1 migrations — lives in [`docs/deploy.md`](docs/deploy.md).

1. **Deploy the Worker**

   ```bash
   bun install
   wrangler deploy        # apply D1 migrations and deploy; details in docs/deploy.md
   ```

2. **Set the dashboard secrets** (three; no review credentials live at Worker level):

   ```bash
   wrangler secret put DASHBOARD_ENCRYPTION_KEY     # openssl rand -base64 32 — encrypts per-App credentials in D1
   wrangler secret put DASHBOARD_SESSION_SECRET     # openssl rand -base64 32 — session-cookie HMAC key
   wrangler secret put GITHUB_OAUTH_CLIENT_ID       # a GitHub OAuth App whose callback is {origin}/dashboard/oauth/callback
   wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   ```

3. **Sign in and register a GitHub App** — visit `https://<your-worker>/dashboard`, sign in with GitHub, and follow the **Register App** manifest flow. It creates the GitHub App on your account with a per-App webhook URL of the form `{origin}/webhook/<slug>`, stores the PEM and webhook secret encrypted in D1, and shows you the exact webhook URL to set.

4. **Configure the App** — on the dashboard Settings page for the App, add the provider API key(s) the review model needs (BYOK, encrypted in D1) and a model chain. An App without these fails its reviews closed — see [Per-App configuration](#per-app-configuration).

5. **Enable reviews and open a PR** — flip the kill-switch, then open or update a PR in a repo where the App is installed:

   ```bash
   wrangler secret put REVIEW_ENABLED   # set to exactly "true"
   ```

   The review runs in a sandbox container and its result appears as one comment on the PR (upserted — no comment spam across force-pushes).

## How reviews work

- **Per-App routing**: GitHub delivers webhooks to `POST /webhook/:appSlug`. The Worker resolves the slug, verifies the signature with that App's own decrypted secret, and enqueues a review job tagged with the App's identity. There is no other review entry point.
- **Queue → Sandbox**: a Cloudflare Queue consumer clones the PR inside a one-shot Sandbox container and runs a multi-seat agent session — see [Agent runtimes](#agent-runtimes).


## Agent runtimes

The review runtime is a small port (`AgentRuntime.runReview()` — one method,
in / `mstar.review/v1` out). The review command, seat plan, and structured
findings all come from the [mstar-harness](https://github.com/btspoony/mstar-harness)
plugin; which coding agent executes them is pluggable:

| Runtime | Status |
|---------|--------|
| [omp](https://github.com/oh-my-pi/omp) | **Shipped** — the current adapter (`src/review/runtime-omp.ts`), all review levels (quick / default / deep) |
| dsh and others | Not yet — the port is the extension point; a new adapter plugs in without touching the webhook / queue / store pipeline |

## Per-App configuration

Everything a review needs is configured **per App** on the dashboard Settings page (`/dashboard/apps/<slug>/settings`) — there are no deployment-level provider keys or model-chain knobs to leak between Apps.

- **Provider keys (BYOK)** — encrypted in D1, injected into the review container only from the App's own config, through a fixed provider allowlist (Anthropic, OpenAI, Gemini, Ark, OpenRouter, Groq, and more — the dashboard shows the full list). Custom providers can be declared on the same page.
- **Model chain** — comma-separated model selectors, first = primary, rest = fallback. This is the only chain source.
- **Fail-closed** — a chain-less App, or one whose chain references a provider without a configured key, fails its reviews closed with a structured error (visible on the settings page + `review_failures` table) before any sandbox or token work happens. Configure every App before enabling reviews for it.

## Operations

- **Kill-switch**: reviews run only when the Worker var `REVIEW_ENABLED` is exactly `"true"`. Unset or any other value → every webhook is acknowledged and ignored, nothing is enqueued. Ship unset until you are ready.
- **Secrets inventory, deploy steps, rollback, and the full Multi-App go-live checklist** → [`docs/deploy.md`](docs/deploy.md).

## Local development

```bash
bun install
bun run typecheck
bun test
```

- Local `wrangler dev` secrets go in `.dev.vars` (gitignored) — see `.env.example`.
- Review runner CLI (the in-image entry): `bun run review --level <quick|default> --input <json-file>` — prints the `mstar.review/v1` envelope JSON on stdout.
- Sandbox smoke: `bun run scripts/sandbox-smoke.ts` (requires `SMOKE_APP_ID` / `SMOKE_PRIVATE_KEY`; see the file header).

## Documentation

| Document | What it covers |
|----------|----------------|
| [`docs/deploy.md`](docs/deploy.md) | Full deploy runbook: Cloudflare resources, D1 migrations, secrets inventory, deploy steps, Multi-App go-live checklist, rollback |

## License

[MIT](LICENSE)
