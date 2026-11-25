-- 0113_delivery_health_index_refused.sql — the `refused` delivery outcome
-- (0111-era route-gate refusal) is a verdict, so the health index's tier
-- expression must name it or the ordered read falls back to a temp B-tree.
-- The CASE below is DELIVERY_VERDICT_TIER_SQL in src/dashboard/apps-store.ts
-- byte-for-byte: change both, never one.

DROP INDEX idx_webhook_deliveries_bot_health;

CREATE INDEX idx_webhook_deliveries_bot_health
ON webhook_deliveries (
  bot_id,
  (CASE WHEN outcome IN ('ok', 'paused', 'rejected', 'refused') THEN 0 ELSE 1 END) DESC,
  created_at
);
