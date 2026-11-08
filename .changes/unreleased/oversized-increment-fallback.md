---
category: Fixed
---

- **An oversized increment capture degrades to a full-diff round instead of
  failing the review.** A recheck round captures its increment through the
  compare API, which enforces the same 20,000-line ceiling `gh pr diff` answers,
  so a large `base...head` diff was refused and failed the sandbox stage on every
  attempt. The increment reply now lands in a scratch file that replaces the
  round's full diff only once it was delivered, and a refusal is classified:
  the round logs one structured warning naming the reason and the step it
  stopped at, drops the `since` fact — never keeping a claim the diff no longer
  supports — and reviews the full diff it already captured. Any other increment
  failure still fails with its own named cause (exit code, redacted stderr and
  the diff-file state).

<!-- CN -->
- **过大的增量抓取现在降级为整份 diff 的轮次，而不是让评审失败。** 复审轮次通过
  compare API 抓取增量，而它执行与 `gh pr diff` 相同的 20,000 行上限，因此较大的
  `base...head` diff 会被拒绝，并让 sandbox 阶段每次尝试都失败。现在增量的返回先落到
  临时文件，只有真正拿到结果才替换本轮已有的整份 diff；被拒绝的情况会被分类：本轮
  记录一条结构化警告，写明原因与停在哪一步，并丢弃 `since` 事实（不再保留该 diff
  已不支持的说法），改为评审本轮早就抓到的整份 diff。其它任何增量失败仍然失败，并
  保留各自独立的原因（退出码、脱敏后的 stderr 与 diff 文件状态）。
