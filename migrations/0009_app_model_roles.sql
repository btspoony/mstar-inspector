-- 0009_app_model_roles.sql — per-App per-role model overrides (plan 17
-- Task 1, spec dashboard-ops-and-role-models § Data model + § B6 语义锁).
--
-- app_model_roles: one row per (App, role) — the model selector chain that
-- seat reviews with. `role` is one of the 4 audit-seat agent names
-- (mstar-review-seat / code-reviewer / fullstack-dev / frontend-dev, spec
-- § B6 语义锁); the value domain is enforced producer-side by the dashboard
-- store (MODEL_ROLE_IDS mirror + parity test) — no CHECK constraint, the
-- runner side passes unknown names through lazily (architect lock L3).
--
-- selector is stored VERBATIM (a model selector is configuration, not a
-- secret — same rationale as 0006 app_model_config): a comma-separated chain
-- in the B2 parseModelChain grammar (≥1 selector, `:thinking` suffix passes
-- through). ABSENT row = the role is unmapped → the seat keeps today's chain
-- behavior byte-identically (empty map = current behavior, plan Global
-- Constraints).
--
-- Composite PK (app_id, role): exactly one selector per role per App. FK
-- references github_apps(id), NO ON DELETE clause (0006 precedent:
-- soft-delete is the only removal path; a hard DELETE of an app carrying
-- role rows is refused at the schema level).
--
-- Append-only: creates a new table only, touches no existing table. Must
-- apply AFTER 0004 (the FK parent must exist).

CREATE TABLE app_model_roles (
  app_id   TEXT NOT NULL REFERENCES github_apps(id),
  role     TEXT NOT NULL,
  selector TEXT NOT NULL,
  PRIMARY KEY (app_id, role)
);
