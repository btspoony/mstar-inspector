---
category: Fixed
---

- **The daily Catalog refresh no longer fails on its own snapshot rotation.** The provider-catalog layout test pinned the README's stale-literal case to one real snapshot date, so the first refresh that replaced that snapshot turned the Test step red. The case now derives the date from the tracked snapshot and still proves a pinned README row rejects any other date.
- **An SDK release that installs but does not load is held instead of reaching Test.** `bump-pins.ts` now imports every SDK specifier the runner's source loads at runtime in the bumped tree; a release whose tarball omits a file it imports (seen with `@oh-my-pi/pi-coding-agent@19.1.0`) aborts the bump, the workflow restores the held pins, and the catalog refresh continues.

<!-- CN -->
- **每日 Catalog refresh 不再因自身的 snapshot 轮换而失败。** provider-catalog 布局测试把 README 的固定日期反例写死为某个真实 snapshot 日期，refresh 替换该 snapshot 后 Test step 即变红。现在该用例从 tracked snapshot 派生日期，并仍证明固定日期的 README 行会拒绝其他日期。
- **能安装但无法加载的 SDK 版本会被保留旧 pin，而不是进入 Test。** `bump-pins.ts` 现在会在 bump 后的依赖树中导入 runner 源码运行时加载的每个 SDK specifier；若某版本的 tarball 缺少其导入的文件（`@oh-my-pi/pi-coding-agent@19.1.0` 即如此），bump 中止，workflow 恢复原 pin 并继续 catalog refresh。
