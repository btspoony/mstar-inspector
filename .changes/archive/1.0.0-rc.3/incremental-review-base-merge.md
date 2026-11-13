---
category: Fixed
---

- **Incremental reviews no longer absorb the base branch's merged commits**: a round uses the previous reviewed head as its delta only when the compare gate answers `ahead`, the range carries no merge commit, and the commit list is complete. A PR branch that merged its base into itself ("update branch") previously handed the base branch's whole changeset to the review seats as this PR's "work since the last review" and reported findings about code the PR never touched (observed on PR #268: `fb75d4d...1352814` answered `ahead` with one merge and 62 files, all from a separately merged PR, while #268 changed 9). Such a round now reviews the full PR diff and logs one `increment_status: "ahead-merge"` line; an exit-0 answer that is not the gate's JSON logs `increment_status: "unusable"`.

<!-- CN -->
- **增量审查不再吸收基线分支合入的提交**：仅当 compare 闸门回答 `ahead`、区间内没有 merge commit 且提交列表完整时，本轮才以先前已审查的 head 作为增量基线。此前，把基线分支合入自身的 PR 分支（"update branch"）会把基线分支的整批改动当作本 PR 的"上次审查以来的工作"交给审查席位，从而报告本 PR 从未改动的代码（PR #268 的实际观测：`fb75d4d...1352814` 回答 `ahead`、含 1 个 merge、62 个文件，全部来自另一个已单独合并的 PR，而 #268 只改了 9 个文件）。现在这类轮次改为审查完整 PR diff，并记录一条 `increment_status: "ahead-merge"`；exit 0 但回答不是闸门 JSON 时记录 `increment_status: "unusable"`。
