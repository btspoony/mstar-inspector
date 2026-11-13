---
category: Fixed
---

- **Addressed findings now close their GitHub conversations again**: the app's own published finding report no longer counts against the review model's discussion budget, so a thread whose root comment is that report is not marked truncated just for containing it — a thread with one human reply stays eligible to resolve. A human comment still counts in full, and a reply that spoofs the bot marker stays visible.
- **Comments survive GitHub re-anchoring**: when code above a review comment moves and GitHub keeps the thread valid at a shifted line, the thread is still recognised as ours through the line it was originally published on. Threads that are outdated, point at another file, or carry a different original line stay unrecognised.

<!-- CN -->
- **已处理的问题重新能够关闭对应的 GitHub 讨论**：本应用自己发布的发现报告不再占用复核模型的讨论预算，因此根评论就是该报告的讨论不会仅因包含它就标记为截断——只有一条人类回复的讨论仍然可以解析。人类评论照常计入，伪装成机器人标记的回复也照旧可见。
- **评论在 GitHub 重新定位后仍可识别**：当评论上方的代码移动、GitHub 在偏移后的行上保持该讨论有效时，仍可通过最初发布所在的行把它识别为我们自己的讨论。已过期的讨论、指向其他文件的讨论，以及原始行不一致的讨论仍然无法识别。
