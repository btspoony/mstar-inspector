---
category: Fixed
---

- **A save in flight is announced, not just spun**: while a settings or operator card's save button is working, a live region tells a screen-reader user that the save is in progress. Success and failure announcements are unchanged.
- **The consumer test suites no longer share one mutable harness**: each test file owns its own recorders, so one suite's cleanup can no longer clear another suite's evidence and a slow module load can no longer turn every assertion into `undefined is not a function`. Test-only change; no runtime behaviour moves.

<!-- CN -->
- **进行中的保存在读屏下会播报，而不只是一个转圈图标**：设置页与运营卡片保存时，live region 会告知读屏用户「保存中」。成功与失败的播报保持不变。
- **consumer 测试套件不再共用一个可变 harness**：每个测试文件持有自己的记录器，一个套件的清理不会再抹掉另一个套件的证据，模块加载变慢也不会再把断言变成 `undefined is not a function`。仅测试改动，运行时行为不变。
