---
category: Fixed
---

- **A re-trigger on an unchanged head no longer turns a passing check red.** The consumer used to claim its Check attempt at admission and only then discover the head was already reviewed, leaving a second attempt with no handle that the reconciler could only close as `failure` — overwriting the head's own `success`. The delivery's own head (the payload sha, or the PR watermark a comment carries) is now read against the KV done claim and the stored review before the claim: a duplicate acks there, creating no Check attempt and no sandbox. A miss, or an unreadable answer, continues exactly as before, and the checkout-keyed dedup after the clone still catches a force-push.

<!-- CN -->
- **在未变化的 head 上重复触发不再把通过的检查变红。** 消费者原本在准入时就占用 Check，随后才发现该 head 已被审查，于是留下一个没有 handle 的第二次尝试，reconciler 只能以 `failure` 收尾，覆盖该 head 自己的 `success`。现在在占用之前，先用投递自身的 head（负载里的 sha，或评论所带的 PR head 水位）查询 KV 完成标记与已落库的审查：命中即在此 ack，不创建 Check 尝试、不启动沙箱。未命中或读到无法解析的答案时行为与之前一致；clone 之后按 checkout 键的去重仍会拦住 force-push。
