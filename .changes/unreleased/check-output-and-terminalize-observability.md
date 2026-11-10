---
category: Fixed
---

- **A Check now carries its gate result.** `checks.update` sent the frozen title and summary as top-level fields; GitHub reads them only from `output`, so every run closed as a bare name plus conclusion and the frozen text (`Review gate met for <sha7> (round N): verdict "ship it", score 100 (floor 80; allowed: ship it).`) never reached the PR. The pair is nested under `output` now, and the adapter's own parameter type says so instead of inventing a shape the API drops.
- **A Check attempt records why it closed.** `review_checks` gains `terminalize_outcome` and `terminalize_elapsed_ms` (migration `0052`): `completed`, `budget-exceeded`, `hook-failed` or `no-handle`. Those four exits previously reported through `log.warn` only, so a run that closed at the 900 s execution deadline left no evidence of whether the consumer ran the hook, timed it out, or never held a handle. A NULL outcome on a terminal row is the record that the reconciler closed it.

<!-- CN -->
- **Check 现在会带上门禁结论。** `checks.update` 把冻结的 title 与 summary 当顶层字段发送，而 GitHub 只从 `output` 读取，因此每次收口都只剩名字加结论，冻结文案（`Review gate met for <sha7> (round N): verdict "ship it", score 100 (floor 80; allowed: ship it).`）从未到达 PR。现已嵌套进 `output`，适配器自己的参数类型也改为该形状，不再自造 API 会丢弃的字段。
- **Check attempt 会记录收口原因。** `review_checks` 新增 `terminalize_outcome` 与 `terminalize_elapsed_ms`（迁移 `0052`），取值 `completed`、`budget-exceeded`、`hook-failed`、`no-handle`。此前这四条出口只写 `log.warn`，导致撞到 900 秒执行期限才收口的行不留任何证据。终态行上 outcome 为 NULL 即表示由 reconciler 收口。
