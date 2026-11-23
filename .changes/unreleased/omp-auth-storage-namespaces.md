---
category: Changed
---

- Moved the runner tests off omp's deprecated flat `AuthStorage.getApiKey` / `AuthStorage.reload` redirects onto `AuthStorage.keys.get` / `AuthStorage.credentials.reload`. Test only; no runner or image changes.

<!-- CN -->
- runner 测试不再使用 omp 已弃用的扁平 `AuthStorage.getApiKey` / `AuthStorage.reload` 转发方法，改用 `AuthStorage.keys.get` / `AuthStorage.credentials.reload`。仅涉及测试，runner 与镜像不变。
