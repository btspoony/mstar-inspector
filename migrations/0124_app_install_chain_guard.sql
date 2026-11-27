-- 0124_app_install_chain_guard.sql — a chain rewrite is all-or-nothing.
--
-- `replaceInstallChain` clears an install's chain and re-inserts it in one
-- batch. Its mountability predicate lives INSIDE the batch, so an owner
-- unsharing a bot between the request and the write cannot slip it in — but a
-- skipped insert must then FAIL the batch, or the DELETE commits alone and leaves
-- the install with no chain at all.
--
-- SQLite has no `RAISE` outside a trigger, and D1 cannot express a conditional
-- ROLLBACK, so this is the repo's existing guard-table recipe (0057, 0115): a
-- table whose CHECK accepts only 0, INSERT-ed from a SELECT that compares the
-- requested id count with the rows the batch just wrote.
--
-- It is a MIGRATION, not a CREATE inside the batch: a statement list is prepared
-- before the batch runs, so a table created by statement 3 does not exist yet when
-- statement 4 is prepared. The table is therefore permanent and always empty; the
-- batch clears its own key first and the guard row only ever exists inside a
-- failing batch's doomed transaction.
--
-- Keyed by the install so two installs' batches never read each other's guard.
--
-- Must apply AFTER 0123.

CREATE TABLE app_install_chain_guard (
  github_app_id TEXT    NOT NULL,
  workspace_id  TEXT    NOT NULL,
  n             INTEGER NOT NULL CONSTRAINT app_install_chain_guard CHECK (n = 0),
  PRIMARY KEY (github_app_id, workspace_id)
);
