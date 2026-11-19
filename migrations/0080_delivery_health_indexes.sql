-- Reverse traversal orders verdict tier ascending, then timestamp and rowid
-- descending, so even same-second deliveries need no sort or history scan.
CREATE INDEX idx_webhook_deliveries_bot_health
ON webhook_deliveries (
  bot_id,
  (CASE WHEN outcome IN ('ok', 'paused', 'rejected') THEN 0 ELSE 1 END) DESC,
  created_at
);

-- Count only rejected deliveries inside the requested time range.
CREATE INDEX idx_webhook_deliveries_bot_outcome_created
ON webhook_deliveries (bot_id, outcome, created_at);
