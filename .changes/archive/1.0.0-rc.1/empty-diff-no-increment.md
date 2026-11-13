---
category: Fixed
---

- **An empty diff acks instead of failing the review.** `git apply --numstat`
  rejects an empty diff file as unusable input, so a round whose `base..head`
  (or whole PR) adds no changes failed at the sandbox stage and was retried.
  The same round's read of that file now classifies the exit: an empty file is
  the documented no-changes outcome and acks with no publication, no review row
  and no failure row — on a first round (`review_no_diff`) and on an empty
  increment (`review_no_increment`, which also keeps the Check on the last
  reviewed head). Every other non-zero exit still fails, naming git's stderr
  plus the diff-path state.

<!-- CN -->
- **空 diff 现在直接确认，而不是让评审失败。** 对空的 diff 文件，`git apply
  --numstat` 会把它当作无法解析的输入而拒绝，于是 `base..head`（或整个 PR）没有
  任何改动的轮次在 sandbox 阶段失败并被重试。现在由同一轮对该文件的读取来判定这个
  退出码：空文件按既有“无改动”结论确认——不发布、不写评审行、不写失败行，首轮
  （`review_no_diff`）与空增量（`review_no_increment`，并让 Check 继续继承上次已
  评审的 head）都是如此；其它非零退出仍然失败，并同时给出 git 的 stderr 与 diff
  文件状态。
