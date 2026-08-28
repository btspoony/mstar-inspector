-- 0002_mstar_review_v1.sql — mstar.review/v1 consumption (plan 07 Task 4).
-- Era model: reviews.envelope IS NOT NULL ⇔ 该行走 v0.3+ 路径（mstar.review/v1）。
-- M1 行保留 raw_output + M1 词表，只读历史（.mstar/specs/findings-schema.md），永不改写。
-- findings.severity 语义切换（architect 锁）：v1 行的 finding class 列 = severity，
-- 取值 harness merge-class 词表（must-fix | should-fix | nit）；M1 行保持
-- critical | warning | suggestion | info。判代 = join reviews.envelope IS NOT NULL。
-- 列名保留 → 现有 idx_findings_severity 直接服务 class 查询；不做表重建。
-- 新路径不写 raw_output（envelope 即权威，避免双权威/截断不可还原）。
-- 回滚姿势（qc3 F-305）：本迁移仅前向、不可撤销（SQLite ADD COLUMN 无 down）。
-- 回退 v1 路径 = 重新部署上一版 Worker，0002 保留不动：envelope IS NULL 行惰性、
-- M1 行不受影响（era 判代 = join reviews.envelope IS NOT NULL）。
ALTER TABLE reviews ADD COLUMN envelope TEXT
  CHECK (envelope IS NULL OR json_valid(envelope));
