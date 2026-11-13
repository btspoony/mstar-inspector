---
category: Changed
---

- **Production is served through Workers Routes.** The production Worker no longer holds a Custom Domain on `inspector.mstar.page`; it answers five specific patterns on the `mstar.page` zone (`inspector.mstar.page/dashboard*`, `inspector.mstar.page/_internal_admin*`, `inspector.mstar.page/webhook/*`, `inspector.mstar.page/healthz`, `inspector.mstar.page/app-assets/*`), which leaves the hostname root to the marketing site. The hostname now needs a proxied DNS record of its own — routes never create one.
- **The SPA bundle moved to `/app-assets/`.** The build emits `dist/spa/app-assets/`, and `/assets/*` and `/index.html` now belong to the marketing site on this hostname.

<!-- CN -->
- **生产改为通过 Workers Routes 提供服务。** 生产 Worker 不再持有 `inspector.mstar.page` 的 Custom Domain，改为在 `mstar.page` zone 上回答五条 pattern（`inspector.mstar.page/dashboard*`、`inspector.mstar.page/_internal_admin*`、`inspector.mstar.page/webhook/*`、`inspector.mstar.page/healthz`、`inspector.mstar.page/app-assets/*`），把 hostname 根路径让给营销站。该 hostname 现在需要一条自己的 proxied DNS 记录——routes 不会创建它。
- **SPA 打包产物移到 `/app-assets/`。** 构建输出到 `dist/spa/app-assets/`，`/assets/*` 与 `/index.html` 在本 hostname 上归营销站。
