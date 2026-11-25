---
category: Added
---

- **Check-run Re-run now reviews.** The Checks page's Re-run button
  (`check_run.rerequested`) performs a real review of the run's own head instead of being
  silently ignored: the delivery resolves its PR identity from the `review_checks` row the run
  id names (a fork PR's payload carries no `pull_requests`), attaches a fresh check run (GitHub
  cannot re-queue a concluded one), and enters the same pause / review-flag / entitlement
  gates as every other trigger. Apps with `checks: write` are already subscribed — no setting
  change needed.
- **A rerun now targets the PR's current head.** Re-running a superseded
  commit is pointless, so the rerun reviews the head the pull_requests
  watermark currently records; a rerun of a current head that already has a
  review settles its new check as skipped with the existing conclusion.
- **Deliveries dedup by run id.** KV claims gain an `:rerun:{check_run_id}` dimension, so a
  GitHub redelivery of the same rerequested event enqueues once, while ordinary triggers keep
  their byte-identical key and `reviews.id` stays the strict five-part key.

<!-- CN -->
- **Checks 页的 Re-run 现在会真正触发审查。** `check_run.rerequested` 按该 run 自己的 head
  走一次审查，而不是被静默忽略；投递的 PR 身份来自该 run id 对应的 `review_checks` 行（fork
  PR 的 payload 不带 `pull_requests`），并新建一个 check run（GitHub 不会重新排队已结束的
  run），同时受与其他触发相同的暂停 / 审查开关 / 权益门禁约束。持有 `checks: write` 的 App
  本已自动订阅，无需改设置。
- **rerun 现在针对 PR 的当前 head。** 重跑已被超越的提交没有意义，因此 rerun 审查的是
  pull_requests 水印当前记录的 head；已存在审查的当前 head 再次 rerun 时，新 check
  以既有结论收敛为跳过。
- **按 run id 去重。** KV 声明新增 `:rerun:{check_run_id}` 维度，同一 rerequested 事件的
  重复投递只入队一次；普通触发的键保持逐字节不变，`reviews.id` 仍是严格五段式。
