---
category: Fixed
---

- **A Check now carries its gate result.** `checks.update` sent the frozen title and summary as top-level fields; GitHub reads them only from `output`, so every run closed as a bare name plus conclusion and the frozen text (`Review gate met for <sha7> (round N): verdict "ship it", score 100 (floor 80; allowed: ship it).`) never reached the PR. The pair is nested under `output` now, and the adapter's own parameter type says so instead of inventing a shape the API drops.
- **A Check attempt records why it closed.** `review_checks` gains `terminalize_outcome` and `terminalize_elapsed_ms` (migration `0052`, documented in the review-lifecycle spec): `completed` only when the row proves a terminal send landed (`observed = desired` with a frozen, non-`in_progress` intent); `handed-off` when the hook returned without that proof, which covers a fence-refused freeze and a `completeCheck` that could not confirm — both release the attempt to recovery; `budget-exceeded`; `hook-failed`; `no-handle` (the begin budget expired, so the consumer never held a handle). Those exits previously reported through `log.warn` only, so a run that closed at the 900 s execution deadline left no evidence of which branch it took.

<!-- CN -->
- **Check 现在会带上门禁结论。** `checks.update` 把冻结的 title 与 summary 当顶层字段发送，而 GitHub 只从 `output` 读取，因此每次收口都只剩名字加结论，冻结文案（`Review gate met for <sha7> (round N): verdict "ship it", score 100 (floor 80; allowed: ship it).`）从未到达 PR。现已嵌套进 `output`，适配器自己的参数类型也改为该形状，不再自造 API 会丢弃的字段。
- **Check attempt 会记录收口原因。** `review_checks` 新增 `terminalize_outcome` 与 `terminalize_elapsed_ms`（迁移 `0052`，已在 review-lifecycle 规范中登记）：`completed` 仅当行内证明终态发送已落地（`observed = desired` 且意图已冻结、非 `in_progress`）；`handed-off` 表示 hook 返回但无此证明，涵盖 fence 拒绝的冻结与 `completeCheck` 无法确认两种情形——两者都会把 attempt 交回 recovery；另有 `budget-exceeded`、`hook-failed`、`no-handle`（begin 预算耗尽，consumer 从未拿到 handle）。此前这些出口只写 `log.warn`，导致撞到 900 秒执行期限才收口的行不留任何分支证据。
