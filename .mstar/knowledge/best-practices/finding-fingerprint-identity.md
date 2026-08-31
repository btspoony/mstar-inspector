---
module: review-store-fingerprint
date: 2026-08-31
last_updated: 2026-08-31
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Designing finding/fingerprint identity across PRs or review rounds"
  - "Any identity/hash field that consumes model-controlled text"
  - "Deduplicating LLM review output stored in D1"
plan_id: 21-fingerprint-dedup
tags:
  - fingerprint
  - dedup
  - fnv1a
  - redaction-interaction
  - review-store
  - m4-insights
---

# Finding fingerprint identity: normalization locks + redaction interaction

## Context (设计共识)

`findings.fingerprint`（migrations/0001）在 v0.8 前是「裸 hint 透传」列：唯一写入点落 `fingerprint_hint ?? null`（模型自报、optional → 多数 NULL），无索引消费。v0.8（plan 21）把它升级为跨 round/跨 PR 的稳定身份。四条 architect 锁（AL-21-1/21-2）+ 一个 QC 深审发现（REDACTED 塌缩）构成完整设计。

## Guidance（锁点清单）

1. **同步哈希，不用 WebCrypto**：persist 路径在同步 `.map()` 内构造 bind 值（`artifact-store.ts` put）；`crypto.subtle.digest` 仅 async，会迫使 put 前预计算 Promise.all 且组装层二次调用形状分叉。**FNV-1a 64-bit 两段乘 + 16 小写 hex**（纯 JS、Bun/workerd 通吃）。指纹域非对抗：10⁵ findings 生日碰撞 ~3×10⁻¹⁰，可接受。
2. **输入域固定**：`fnv1a64(normPath(file_path) + "\0" + bucket + "\0" + normTitle)`。行邻域桶 N=10（`Math.floor((line-1)/10)*10+1`）；`line_start <= 0` 与 `null` 同为 `noline`（QC：0/-5 落桶 "-9" 是 bug）。**mergeClass/category/line_end 不进 hash**——同位置不同级别 = 复现，不是新 finding。路径分隔符统一 `\`→`/`；title 尾标点剥离（含 CJK `。！…`，要有 pin）。
3. **hint-verbatim 优先 + REDACTED fallback（关键交互）**：非空白 hint 原样作指纹（兼容现网）。但 `redact.ts` SEC-01 会把 secret 形 hint 脱敏成同一 marker——所有被脱敏的 hint 塌缩成单例身份 → 跨 finding false-repeat。**规则：hint 空白或等于脱敏 marker（字面 `REDACTED`，与 redact.ts 常量双向锚点）→ 回退归一化路径**。marker 永不落 D1 指纹列。hint 还需在 B4 choke point 与 title/body 同受 clamp（索引列不能吃无界 TEXT）。
4. **era 语义**：v0.8 前历史行 fingerprint=NULL，不回填；聚合排除。`previousRoundFingerprints`（跨 round 对账）= 同 `(installation_id, owner, repo, pr_number)` 最新一条 **v1 行**（`envelope IS NOT NULL` era 判代）的非 NULL 指纹集；**无 head_sha 排除**（组装时点在 post 前、当前行不存在；same-sha 重审 = 全 repeat，可接受）。查询失败 = 首轮语义（结构化 warn + `dedup:"degraded"` 字段），绝不阻断审查。
5. **去重只在展示层**：repeat finding 照列、标 `*(repeat)*`、不计入新增 tally；verdict/unverified/scorePct 与 envelope 逐字一致。**发表面结构（marker/词表/line comments/D4 event 锁）零改动**。tally 重算基于 B4 截断后的数组（invariant 已 pin docstring）。
6. **索引面**：`idx_findings_fingerprint`（0001 既有）服务按指纹分组；`idx_findings_review_id`（0014）服务 latest-round 的 review_id 反查——SQLite 不自动索引 FK 列，`WHERE review_id = ?` 在热路径上没有它就是全表扫。`idx_reviews_reviewed_at`（0014）服务窗口聚合。

## Why This Matters

脱敏管线与身份管线的交互是静默失败：单测全绿（每个 case 单独看都对），但「两个不同 finding 共享一个身份」只在跨 round 数据流里显形。同类设计（任何消费模型文本的 identity/hash）都要过「脱敏后是否塌缩」这一问。

## When to Apply

- 改动 `fingerprint.ts` / persist 路径 / `redact.ts` SECRET_PATTERNS 时
- 新增任何「模型输出 → D1 身份列」的机制
- Health/Insights 类消费面扩展（recurrence 定义 count>=2、era NULL 排除不可回填）

## Examples

- 实现：`src/store/fingerprint.ts`（纯函数、零 import）+ `artifact-store.ts` put/previousRoundFingerpoints/recurrenceByFingerprint
- 测试 pin 形状：`tests/store/fingerprint.test.ts`（golden 向量 `c3f136c3fe89ebbb`、REDACTED 双 finding 不等、CJK 标点）
- QC 交互发现全文：v0.8 `{SDD_DIR}/21-fingerprint-dedup/review/qc2.md` F-001