-- 0007_reviews_app_id_index.sql — index the review→App attribution column
-- (plan 15 Task 1, spec dashboard-ops-and-role-models § Data model + § 硬化项 2).
--
-- reviews.app_id (added by 0005) is the per-App attribution column: the
-- consumer's store.put writes it on every per-App review (plan 13), and the
-- table only grows. No per-App reader queries it yet — the index exists so
-- per-App lookups (dashboard review filtering and the like) never scan the
-- table when they arrive. NULL (legacy rows — the Worker-secrets global
-- App) indexes fine in SQLite and simply never matches an equality probe.
--
-- Metadata-only: CREATE INDEX builds the secondary structure without
-- rewriting the table, so it is safe to apply over a live production DB with
-- existing rows (the seeded-0001–0006 wrangler order). Must apply AFTER 0005
-- (the indexed column must exist).

CREATE INDEX idx_reviews_app_id ON reviews(app_id);
