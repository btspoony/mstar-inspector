---
category: Fixed
---

- **The PR diff now actually reaches the Worker.** The diff step redirected
  `gh pr diff` into `/workspace/pr.diff` and read the *exec's stdout*, which a
  redirect always leaves empty — so the trusted evidence catalog was built from
  an empty string, every selected prior finding was excluded as unprovable, and
  a round could only publish `unverifiable (no-evidence)` for rows the seat was
  never shown. The command now writes the file (still the numstat source) and
  reads it back through the same bounded transport as the recheck documents:
  the first 2 MiB, then a `wc -c` overflow flag. Over-size still yields no
  slices and keeps the base-filter fallback for line comments; the round is
  never dropped.
- **A diff capture that cannot prove a row is reported, not fabricated.** Exit
  0 with nothing to read means the capture failed (`gh pr diff` always emits a
  header for a real PR); an over-bound diff exists but cannot prove a row; a
  read with no flag line means the transport broke. All three now leave the
  round `context-incomplete` with a `diff_capture: "empty" | "overflow" |
  "unreadable"` warn, instead of publishing a confident `no-evidence` verdict
  per row.

<!-- CN -->
- **PR diff 现在真正到达 Worker。** diff 步骤把 `gh pr diff` 重定向到
  `/workspace/pr.diff`，读取的却是 *exec 的 stdout*——重定向后它必然为空，于是
  可信证据目录是用空字符串构建的，每个被选中的历史问题都被判为不可证明，整轮只能
  对从未展示给 seat 的行发布 `unverifiable (no-evidence)`。该命令现在既写文件
  （仍是 numstat 的来源），又通过与 recheck 文档相同的受限通道读回：前 2 MiB，
  随后是 `wc -c` 溢出标记。超限仍不产生切片、行内评论退回 base 过滤，整轮从不丢弃。
- **无法证明任何行的 diff 捕获如实上报，而非伪造结论。** 退出码 0 却读不到任何内容
  说明捕获失败（真实 PR 的 `gh pr diff` 至少会输出头部）；超限的 diff 存在却无法
  证明任何行；读回缺少标记行则说明通道损坏。这三种情况现在都让整轮标记为
  `context-incomplete`，并打出 `diff_capture: "empty" | "overflow" | "unreadable"`
  警告，而不是为每一行发布看似确定的 `no-evidence`。
