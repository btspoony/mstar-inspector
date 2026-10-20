---
category: Changed
---

- **Review sandbox cohort moved to omp 18.12.3 / mstar-harness 4.0.4**: the image pin block (harness tag/ref and the preinstalled `@mstar-harness/cli`), the `@mstar-harness/engine` `^4.0.4` manifest range, the `@oh-my-pi/pi-coding-agent` pin, and the regenerated lock move together — the pin suite fails if the engine range, its lock resolution, the image CLI pin, or the derived skill version drift apart.
- **Review envelopes can now leave the Worker through the harness persist surface**: `scripts/mstar-export-review.ts` validates one `mstar.review/v1` envelope with the engine and writes it as a `review` artifact — `FsStore` under the resolved harness root by default, `--store <module>` to supply a custom store module. This is not a migration of the D1 review store: the publication journal, leases, recurrence queries, and dashboard reads stay in D1.
- **No operational change from this entry**: the change is pins, one CLI-side script with its test, and documentation — no image build, in-image replay, deployment, or smoke was run.

<!-- CN -->
- **审查沙箱的版本组合升至 omp 18.12.3 / mstar-harness 4.0.4**：镜像 pin 块（harness tag/ref 与预装的 `@mstar-harness/cli`）、`@mstar-harness/engine` `^4.0.4` 的 manifest 区间、`@oh-my-pi/pi-coding-agent` pin 与重新生成的 lock 一并移动——engine 区间、其 lock 解析、镜像 CLI pin 或派生的 skill 版本一旦不一致，pin 测试套件即失败。
- **审查 envelope 现在可通过 harness 的 persist 面离开 Worker**：`scripts/mstar-export-review.ts` 用 engine 校验单个 `mstar.review/v1` envelope，并以 `review` artifact 写入——默认使用解析出的 harness 根目录下的 `FsStore`，可用 `--store <module>` 注入自定义 store 模块。这不是 D1 审查存储的迁移：发布 journal、租约、复现查询与 dashboard 读取仍留在 D1。
- **本条目不涉及运维动作**：变更内容为 pin、一个 CLI 侧脚本及其测试、以及文档——未执行镜像构建、镜像内回放、部署或 smoke。
