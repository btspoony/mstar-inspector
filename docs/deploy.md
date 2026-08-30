# Deploy runbook — mstar-inspector

> Skeleton (plan 19 Task 1): the ops-config section below is the SSOT for the
> plan-19 surfaces that landed in T1. The full runbook — prerequisites
> (queues incl. `review-dlq`, D1 + migrations 0001–0010, containers, secrets
> inventory), ordered deploy steps, post-deploy smoke, rollback, and the
> image digest + in-image default model selector record — lands in plan 19
> Task 2; the executed digest + deploy date in Task 3.

## Ops config (plan 19 T1)

### Queue consumer concurrency (architect verdict AL-5)

- `wrangler.jsonc → queues.consumers[review-queue].max_concurrency: 1` —
  protective fix: UNSET means the platform auto-scales consumer concurrency
  by backlog. With a unique sandbox id per attempt against
  `containers[].max_instances: 1`, >1 concurrency only blocks on container
  acquisition (timeout → retry storm → DLQ). Pinned, NOT env-configurable;
  raising it requires raising `max_instances` first.

### Cron failure sweep (architect verdict AL-6)

- `wrangler.jsonc → triggers.crons: ["*/15 * * * *"]` — every 15 min the
  `scheduled` handler (src/worker/index.ts) runs the sweep
  (src/worker/sweep.ts): counts `review_failures` rows over the trailing 24h
  across ALL stages (parse + runner/sandbox/pipeline; the per-attempt rows
  written by plan 18 T2 make this table the sufficient failure signal).
- Threshold: `failures_24h > 5` (per-attempt semantics — a DLQ'd message
  leaves up to 3 rows). Constants pinned in src/worker/sweep.ts
  (`SWEEP_FAILURE_THRESHOLD`, `SWEEP_WINDOW_HOURS`,
  `SWEEP_WEBHOOK_TIMEOUT_MS`).
- Alert transport: structured `ops_sweep_alert` log event
  (`{failures_24h, dlq_check: "skipped", thresholds}`) + optional POST to
  `ALERT_WEBHOOK_URL` (JSON body, 3s timeout; a POST failure degrades to a
  warn log, never throws). Absent `ALERT_WEBHOOK_URL` = log-only alerting.
- DLQ depth is NOT read (no CF API token surface — `dlq_check: "skipped"`);
  guard-leak cleanup stays out of cron (KV guard TTL is the leak upper
  bound).
- The sweep is read-only: D1 query + log/webhook only — no queue/KV/D1
  mutation.

### Secrets inventory delta

- `ALERT_WEBHOOK_URL` (NEW, optional, secret class): generic alert webhook
  for the sweep — set via `wrangler secret put ALERT_WEBHOOK_URL`
  (`.dev.vars` locally). Unset = log-only alerting.
