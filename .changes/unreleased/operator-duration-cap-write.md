---
category: Added
---

- **The operator console can now set the platform's one end-to-end review duration cap.** A new card on the runtime page saves `review.attempt.duration_cap_ms` through the existing `PATCH /api/runtime` (one system row and one audit entry per accepted save), states the accepted range of 900 000–3 600 000 ms (15–60 minutes), and refuses any value outside it with that range named. The card always shows the effective value and where it came from: a stored value reads as a saved value, and an absent row reads as the 20-minute platform default — never as something the store holds. Every attempt admitted afterwards freezes that number into its deadline, and a stored value that cannot be read admits no review instead of inventing a cap.

<!-- CN -->
- **运营控制台现在可以设置平台唯一的端到端审查时长上限。** 运行时页面新增卡片，通过既有的 `PATCH /api/runtime` 保存 `review.attempt.duration_cap_ms`（每次接受的保存写入一行系统设置与一条审计记录），说明接受范围 900000–3600000 毫秒（15–60 分钟），超出范围的值会被拒绝并在拒绝信息中点明该范围。卡片始终显示生效值及其来源：已存值显示为已保存值，行缺失则显示 20 分钟的平台默认值——绝不把默认值显示成存储中的值。之后准入的每次尝试都会把该数值冻结进自己的截止时间；已存值无法读取时不准入任何审查，而不是凭空发明一个上限。
