---
category: Changed
---

- **Pull request detail:** every Review row now names its round (`Round N`), the findings that round reported and how long the run took, so the reviews tab carries information without opening an empty summary fold — that fold is gone. Findings rows name the round that first reported them.
- **Store:** added the nullable `reviews.duration_ms` column; rows written before the measurement keep NULL and the UI omits their run time.

<!-- CN -->
- **拉取请求详情：**每条审查行现在显示轮次（`第 N 轮`）、该轮报告的发现数与运行耗时；审查页不再依赖空白的摘要折叠区（该折叠已移除）。发现行会标出首次报告它的轮次。
- **存储：**新增可空的 `reviews.duration_ms` 列；此前写入的行保持 NULL，界面不显示其耗时。
