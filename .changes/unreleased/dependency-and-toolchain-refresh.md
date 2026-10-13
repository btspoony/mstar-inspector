---
category: Changed
---

- **Runtime and toolchain pins refreshed** (Dependabot-driven): `wrangler` 4.125.0 → 4.147.0, `vite` 8.2.2 → 8.3.2, `@cloudflare/workers-types` 5.20260825.1 → 5.20261005.1, `@types/bun` 1.4.0 → 1.4.2, `@vitejs/plugin-react` 6.1.1 → 6.1.2, `lucide-react` 1.40.0 → 1.52.0, `tailwind-merge` 3.6.0 → 3.7.0, plus `react` / `react-dom` 19.2.7 → 19.3.0 (with `@types/react` 19.3.0) and `zod` 4.4.3 → 4.6.5. Every pin stays exact (no `^`).
- **TypeScript 5.9.3 → 7.0.2** with the configuration migration it requires: both `tsconfig.json` and `tsconfig.spa.json` drop the removed `baseUrl` and write their `paths` targets relative to their own file (`"@/*": ["./src/spa/*"]`) — TypeScript 7 rejects a bare target with `TS5090`.

<!-- CN -->
- **运行时与工具链 pin 刷新**（Dependabot 驱动）：`wrangler` 4.125.0 → 4.147.0、`vite` 8.2.2 → 8.3.2、`@cloudflare/workers-types` 5.20260825.1 → 5.20261005.1、`@types/bun` 1.4.0 → 1.4.2、`@vitejs/plugin-react` 6.1.1 → 6.1.2、`lucide-react` 1.40.0 → 1.52.0、`tailwind-merge` 3.6.0 → 3.7.0，另含 `react` / `react-dom` 19.2.7 → 19.3.0（配套 `@types/react` 19.3.0）与 `zod` 4.4.3 → 4.6.5。所有 pin 保持精确版本（无 `^`）。
- **TypeScript 5.9.3 → 7.0.2** 及其必需的配置迁移：`tsconfig.json` 与 `tsconfig.spa.json` 均删除已移除的 `baseUrl`，并将 `paths` 目标改写为相对自身文件的形式（`"@/*": ["./src/spa/*"]`）——TypeScript 7 对裸目标报 `TS5090`。
