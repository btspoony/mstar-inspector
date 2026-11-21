---
category: Added
---

- **The operator console now shows the review duration distribution that justifies the attempt cap.** A new read-only report on the runtime page states its 30-day window and sample size, shows p50 / p90 / max for the end-to-end duration and for the three disjoint phases (queue wait, execution, publication or recovery), and lists what the percentiles exclude — unsettled attempts, skipped attempts, rows written before the queue stamp existed, missing phase boundaries and out-of-order intervals. An empty window reads as an empty sample, never as zero. Typing a candidate cap shows how many observed attempts it would exclude, their share, and which phase first passed it; the report states that a capped attempt is terminal and that billing for a cap-stopped paid review is still an open question. The queue send stamp is now copied onto the attempt's handoff row at admission, and a successful attempt records its publication settlement, so both ends of the third bucket come from the attempt's own durable facts.

<!-- CN -->
- **运营控制台新增审查时长分布报告，为时长上限的选择提供依据。** 运行时页面的只读报告会说明其 30 天窗口与样本量，给出端到端时长以及三个互不重叠阶段（队列等待、执行、发布或恢复）的 p50 / p90 / 最大值，并列出未计入百分位的部分——未结算、已跳过、早于队列时间戳写入的行、缺少阶段边界以及边界乱序的区间。空窗口显示为空样本，绝不显示为 0。输入候选上限后，报告会给出会被排除的已观测尝试数量、占比，以及首个越过上限的阶段；报告同时说明被上限终止的尝试即为最终状态，且被终止的付费审查是否计费仍无定论。队列发送时间戳现在会在准入时复制到尝试的交接行，成功尝试也会记录其发布结算，因此第三个阶段的起点与终点都来自尝试自身的持久事实。
