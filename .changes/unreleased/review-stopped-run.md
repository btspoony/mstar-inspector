---
category: Changed
---

- **A stopped review seat no longer fails the run**: when a quick/default review has any seat stopped by its wall-clock cap, the run now publishes an `incomplete` verdict stating the cause and the assigned scope it did not fully cover — one entry per stopped seat, each naming that seat's assigned scope — instead of throwing the whole review away; findings collected from the seats that did return are retained, so the run is reported as not settled rather than lost.
- **The posted body states the cause/scope pair exactly once and bounded**: the cause and unscanned lines the renderer emits are capped per line with an ellipsis, and machine-written duplicates of those lines are stripped from the rendered summary only — the stored envelope keeps the validated values — while a run with no stopped seat stays byte-identical to before.
- **A deep review that ends without a yield is published as `incomplete` too**: when the deep parent turn ends without producing a structured yield, the run no longer fails — it publishes an `incomplete` verdict carrying the summary that turn had already gathered, the cause it states and the deep scope it never completed (the whole diff, one entry); a prompt error with no terminal end, and a yield the contract rejects, remain fatal. The rendered scope line is bounded before it is assembled — a list that fits is printed verbatim, and only an overflowing one stops at the budget and ends with an omitted-count marker — while the stored fact keeps its validated values.

<!-- CN -->
- **停止的审查席位不再导致整轮失败**：quick/default 审查只要有席位被墙钟上限停止，就会发布 `incomplete` 结论，声明原因与未完整覆盖的范围——每个被停止的席位一条，各自标明该席位被分配的范围——而不再丢弃整轮审查；已返回席位收集到的发现会被保留，因此该轮被如实报告为「未定论」而不是丢失。
- **发布正文中的原因/范围对只出现一次且有界**：渲染器输出的 cause 与 unscanned 行按行截断并加省略号，摘要中由模型写入的重复行仅在渲染时剔除（存储的 envelope 仍保留已验证的取值）；没有席位被停止的轮次与之前逐字节一致。
- **未产出 yield 的 deep 审查同样以 `incomplete` 发布**：当 deep 父回合结束时没有产出结构化 yield，该轮不再失败——而是发布 `incomplete` 结论，携带该回合已收集的摘要、它声明的原因以及未完成的 deep 范围（整个 diff，一条）；没有终态结束的 prompt 报错、以及被契约拒绝的 yield 仍然致命。渲染的范围行在拼装之前先做上界判定——放得下的列表原样输出，只有溢出的列表才停在预算处并以省略条数标记结尾——而存储的 fact 仍保留已验证的取值。
