# 审查输出 Schema（findings-schema）

> **状态：** 已升格 `{SPECS_DIR}`（2026-08-25，自 `iterations/iter-001-20260825/specs/findings-schema.md` 快照升格；源文件保留并标注）。  
> **v0.3 起写入退役：** 本文件仍是 **M1 已落库行** 的历史契约（`ReviewOutput`）。新审查 persist / GitHub 发表的权威 = harness `mstar.review/v1` + [github-review-comment-mapping.md](github-review-comment-mapping.md)。实现不得再把本节枚举当 `ArtifactStore.put` 或评论渲染的 SSOT。  
> **SSOT（历史）：** 本文件（类型 + 校验规则）；语义源头 `projects/_default/references/mstar-inspector-solution.md` v0.2 §5.2。  
> **用途（历史）：** `parseReviewOutput` / zod / D1 findings 列 / Review Comment 渲染必须与本文件逐字段一致。  
> **非目标：** 这不是 `{PROJECT_DIR}/residuals.json` 行。禁止 residual 独有值 `high` / `medium` / `low` / `nit`。`critical` 在本 schema 的 findings 中**合法**（与 residual 的 `critical` 同名不同登记处）。

## ReviewOutput（§5.2）

审查结束必须能解析出：

```json
{
  "verdict": "comment | request_changes | approve",
  "summary_md": "给人类看的完整报告 Markdown",
  "findings": [
    {
      "severity": "critical | warning | suggestion | info",
      "category": "security | logic | style | perf | test | other",
      "file_path": "string | null",
      "line_start": "number | null",
      "line_end": "number | null",
      "title": "string",
      "body": "string",
      "fingerprint_hint": "可选，用于后续归一化"
    }
  ]
}
```

合法实例（非文档枚举串）：

```json
{
  "verdict": "comment",
  "summary_md": "No blocking issues.",
  "findings": []
}
```

## TypeScript（与实现 Module contracts 一致）

```ts
export type ReviewVerdict = "comment" | "request_changes" | "approve"
export type FindingSeverity = "critical" | "warning" | "suggestion" | "info"
export type FindingCategory =
  | "security"
  | "logic"
  | "style"
  | "perf"
  | "test"
  | "other"

export type ReviewFinding = {
  severity: FindingSeverity
  category: FindingCategory
  file_path: string | null
  line_start: number | null
  line_end: number | null
  title: string
  body: string
  fingerprint_hint?: string
}

export type ReviewOutput = {
  verdict: ReviewVerdict
  summary_md: string
  findings: ReviewFinding[]
}

/** envelope，不属于 §5.2。仅编排层内部使用。 */
export type ReviewRunResult = {
  mode: "structured" | "summary"
  result: ReviewOutput
}
```

## 枚举

| 字段 | 合法值 |
|------|--------|
| `verdict` | `comment` \| `request_changes` \| `approve` |
| `findings[].severity` | `critical` \| `warning` \| `suggestion` \| `info` |
| `findings[].category` | `security` \| `logic` \| `style` \| `perf` \| `test` \| `other` |

## 校验规则

键的出现：

| 键 | 根 / finding | 规则 |
|----|----------------|------|
| `verdict` | 根，必有 | 上表枚举 |
| `summary_md` | 根，必有 | string；structured 模式长度 ≥ 1 |
| `findings` | 根，必有 | 数组，允许 `[]` |
| `severity` / `category` / `title` / `body` | finding，必有 | 枚举或非空约束见下 |
| `file_path` | finding，**键必有** | `string` 或 `null`（不得省略键） |
| `line_start` / `line_end` | finding，**键必有** | JSON 有限整数或 `null`（不得省略键；拒绝 `1.5`） |
| `fingerprint_hint` | finding，可选 | 出现则为 string；空串可在 parse 时剥掉当缺省 |

其它：

- 根必须是 JSON object。
- `title`、`body` 为 string；允许空 `title`/`body` 仍 parse 成功（模型波动），但 structured 的 `summary_md` 不得空。
- 未知键：**剥离**（不 fail），以便模型多写字段。
- 非法 `severity`（含 `high` / `medium` / `low` / `nit`）→ **整单** `{ ok: false }`。
- 无文件定位时用 `file_path: null` 与行号 `null`，不要用 `""` / `0` 当「无」——`0` 仍算合法整数（不 fail），实现不必改写。

## `parseReviewOutput(raw)`

返回 `{ ok: true, output: ReviewOutput } | { ok: false, error: string }`。

1. Trim。
2. `JSON.parse` 整段。
3. 失败则取 ` ```json ` / ` ``` ` 围栏内文本再 parse。
4. 再失败则取第一个 `{` 到最后一个 `}` 再 parse。
5. zod 校验（上表）。任一步失败 → `ok: false`，不 throw。

## 降级路径

容器内 runner 解析失败：`reviewDiff` 返回 `{ mode: "summary", result: { verdict: "comment", summary_md: <非空>, findings: [] } }`。`summary_md` 优先使用原始模型文本（建议 ≤ 8000 UTF-16 code units，必须非空）；raw 为空用固定句 `Review output could not be parsed.`。

GitHub 上「解析失败则只发 summary」的发表策略属 roadmap **M3**（2026-08-26 里程碑重排：原 M2 生产级 → M3；**不是** v0.3 的 M2 review-engine）。M1 e2e 主路径要求 structured；v0.3 仍是解析失败不发、不 insert。

## 与 residual 的关系

本 schema 对齐 **QC 章节语义**（`critical` / `warning` / `suggestion` / `info`），不是 `{PROJECT_DIR}/residuals.json` 的机器字段 `severity`（`critical/high/medium/low/nit`）。映射表如需，单开 spec，不在本文件发明。
