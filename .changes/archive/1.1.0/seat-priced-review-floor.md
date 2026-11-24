---
category: Fixed
---

- **Default-tier reviews get more runner wall clock.** One review seat is now priced at 220 s instead of 150 s, so the size-derived request floor rises from 360 000 to 500 000 ms for `default` (210 000 → 280 000 for `quick`; `deep` stays clamped at its 646 000 ms ceiling). The old price put the two-seat default floor at 360 s — above the measured p50 of 305 s but below the p90 of 509 s, so it cut into the slowest tenth of ordinary rounds; the observed failure was sharper still, with one head stopped at 362 s and then passing inside the same budget. Tier ceilings, the round budget and the reserve ledger are unchanged.

<!-- CN -->
- **`default` 档 review 获得更多 runner 墙钟时间。** 单个 review 席位的计价从 150 s 提高到 220 s，因此按 diff 大小推导的请求下限在 `default` 档由 360 000 ms 升至 500 000 ms（`quick` 由 210 000 升至 280 000；`deep` 仍被 646 000 ms 上限钳制）。旧价格把两席 `default` 下限压在 360 s——高于实测 p50 的 305 s、但低于 p90 的 509 s，因此会切进普通轮次中最慢的十分之一；实际观测到的失败更极端：同一个 head 曾在 362 s 被停止、又在同一预算内通过。各档上限、整轮预算与预留账本均未改动。
