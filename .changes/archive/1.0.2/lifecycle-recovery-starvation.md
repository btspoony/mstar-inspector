---
category: Fixed
---

- Rotate suspended lifecycle recovery scans with a durable exact-App pair cursor so unavailable Apps cannot starve repaired Apps. Apply the batch limit to pairs across both lanes without dropping suspension reasons needed for identity verification.

<!-- CN -->
- 为挂起的生命周期恢复扫描增加持久化精确 App pair 游标，避免不可用 App 阻塞已修复 App 的恢复；跨两条恢复通道按 pair 限制批次，保留身份验证所需的全部挂起原因。
