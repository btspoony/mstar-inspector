---
category: Added
---

- **The workspace settings card shows the month in credits, with the RP detail and the version that governs it.** The credit block sits above the published-review counts: credits primary (two decimals, divided by the profile's own `rp_per_credit`), the integer RP pair beneath it, the shared-bot / BYOK split under that, and the quota version that judged the month. At or past the ceiling the used/limit pair stays and one banner states the consequence — new reviews are refused until the next UTC month, or sooner if an operator moves the workspace to a larger plan — and that a review already started still finishes. `self-hosted` renders no credit block: it has no ceiling to report.
- **One sentence now says which counter each figure reads.** Credits weigh the same started reviews the members page counts as attempts; the review counts on the card are published reviews. The three counters differ by construction, and the card says so instead of leaving two look-alike numbers side by side.
- **Operators get a quota-versions screen.** Every version with its interval (derived from the next version's start), the one judging this month, and anything scheduled. A new version copies the current numbers, and publishing appends it — an existing version is never edited.
- **Publishing requires an impact preview.** Before a version can be created, the screen must show how many live workspaces today's usage would already put over the new ceilings, and the first 1st the version judges. Editing any number invalidates the preview, so a stale count cannot be published. The count is a tightness check, not a forecast: a version published mid-month judges from the next month's 1st.
- **The usage ledger records which source paid.** `usage_events.source` (`byok` or `shared`) is written in the same statement that records the RP price, so the card's split is a recorded fact rather than an inference. Rows written before the column keep a NULL source: they count in the month's total and in neither split.

<!-- CN -->
- **工作区设置卡片以额度显示当月用量，并给出 RP 明细与当月生效的版本。** 额度区块位于已发布审查计数之上：额度为主（保留两位小数，按该 profile 自己的 `rp_per_credit` 换算），下方是整数 RP 对照，再下方是共享机器人 / BYOK 的拆分，以及判定当月的额度版本。达到或超出上限时 used/limit 仍然保留，并由一条横幅说明后果——新审查会被拒绝直到下个 UTC 月，若运营者把工作区调到更大的套餐则会更早恢复——以及已经开始运行的审查仍会完成。`self-hosted` 不显示额度区块：该模式没有上限可报告。
- **现在用一句话说明每个数字读的是哪个计数。** 额度计的是与成员页「尝试次数」同一口径的已开始审查；卡片上的审查计数是已发布的审查。三个计数本质不同，卡片直接说明，而不是把两个外观相近的数字并排放着。
- **运营者获得额度版本页面。** 展示每个版本及其区间（区间终点由下一个版本的起点推导）、判定当月的版本，以及已排定的版本。新版本复制当前数值，发布即追加——既有版本永不被修改。
- **发布前必须先看影响预览。** 创建版本之前，界面必须显示按今日用量、新上限会让多少个在线工作区超出，以及该版本第一个判定的 1 日。任何数值改动都会使预览失效，因此过期的数字无法被发布。这个数字是紧度检查，不是预测：月中发布的版本从次月 1 日起判定。
- **用量账本记录付费来源。** `usage_events.source`（`byok` 或 `shared`）与 RP 价格在同一条语句中写入，卡片上的拆分因此是记录下来的事实，而不是推断。该列出现之前的行保持 NULL 来源：它们计入当月总量，但不计入任何一侧拆分。
