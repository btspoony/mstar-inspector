---
category: Fixed
---

- **A large recheck round is asked within the seat's context budget.** The seat's
  assignment used to embed the whole `mstar.recheck-input/v1` document — up to the
  512 KiB input cap, ~131k–150k tokens of JSON — so a large round asked for far more
  prompt than a one-shot seat reliably holds and its `yield` never arrived
  (`failed / seat-failed`, status `unavailable`; I-000396). The ask is now fitted to a
  bounded budget: every target and the discussion always ride, and evidence slices ride
  unmodified until the budget is spent — one slice per row first, so the fit can only
  starve rows the budget never reached, never the rows that happen to sort last. The
  seat is told to answer a row whose proof was not retained as
  `unverifiable`/`context-incomplete`, never an unproven `addressed` — and the
  yield is validated against the catalog the seat actually received, so a row
  citing an omitted slice is dropped by name instead of being published as
  `addressed`. Document-level validation and the strict output schema are
  unchanged.
- **A round that cannot be asked is recorded, never dispatched.** When targets plus
  discussion alone exceed the budget, no seat is started: the round reports
  `skipped`/`budget` with a bounded error naming the required and available bytes, so
  the worker accounts every sent row `unverifiable/budget` instead of spending the
  180s window on a guaranteed empty yield.

<!-- CN -->
- **大型重审轮现在按席位的上下文预算来提问。** 此前席位的 assignment 会原样嵌入整份
  `mstar.recheck-input/v1` 文档——最高可达 512 KiB 输入上限、约 131k–150k token 的 JSON——
  于是大轮次索要的提示远超一次性席位可靠容纳的量，`yield` 永远不会到达
  （`failed / seat-failed`、状态 `unavailable`；I-000396）。现在提问被裁剪到有界预算内：
  所有 target 与 discussion 始终保留，证据切片在预算内原样保留——先保证每行一个切片，
  因此裁剪只会饿死预算从未覆盖到的行，绝不会因为排序而饿死后面的行。证明未被保留的行，
  席位被要求回答 `unverifiable`/`context-incomplete`，绝不允许没有保留证据的 `addressed`；
  并且校验以席位实际收到的目录为准，引用被裁剪切片的行会按行名丢弃，不会被当作
  `addressed` 发布。文档级校验与严格输出 schema 均不变。
- **无法提问的轮次会被记录，绝不照样派单。** 当仅 targets 加 discussion 就超出预算时，
  不会启动任何席位：该轮报 `skipped`/`budget`，附带点明所需与可用字节数的有界错误，
  worker 因此把每个已发送行记账为 `unverifiable/budget`，而不是把 180 秒窗口花在一次
  注定空手而归的调用上。
