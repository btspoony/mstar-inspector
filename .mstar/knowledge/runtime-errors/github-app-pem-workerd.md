---
title: GitHub App PEM 在 workerd 上铸 JWT 的 PKCS#1→PKCS#8 陷阱
category: runtime-errors
problem_type: runtime_error
symptoms:
  - "Bun 本地测试全绿，部署到 workerd 后 installation-tokens 调用失败"
  - "crypto.subtle.importKey(pkcs8) 对 PKCS#1 PEM 抛 DataError"
root_cause: "universal-github-app-jwt 的 #crypto 条件导出在 workerd 解析到 crypto-native.js（no-op），Bun 解析到 crypto-node.js（内部转换）——同一依赖两运行时行为不同，Bun 测试无法暴露"
resolution_type: code_fix
module: app-gateway
severity: high
date: 2026-08-26
status: active
created_at: 2026-08-26
last_updated: 2026-08-26
source_plan: 04-gateway-worker
iteration: v0.2
verified: true
---

# GitHub App PEM 在 workerd 上铸 JWT 的 PKCS#1→PKCS#8 陷阱

## Problem

GitHub App 下载的私钥是 **PKCS#1** PEM（`-----BEGIN RSA PRIVATE KEY-----`）。在 Cloudflare Workers（workerd）上用 WebCrypto 铸 RS256 JWT 时，`crypto.subtle.importKey("pkcs8", ...)` 对 PKCS#1 抛 `DataError`——部署环境 JWT 铸造直接失败。

## Symptoms

- 本地 Bun 测试全绿，部署后 installation-tokens 调用 500/失败。
- 根因：`universal-github-app-jwt` 的 `#crypto` 条件导出在 workerd 解析到 `crypto-native.js`（no-op），Bun 解析到 `crypto-node.js`（内部转换）——**同一依赖两个运行时行为不同**，Bun 测试无法暴露。

## What Didn't Work

- 依赖库自动转换（workerd 条件解析绕过了它）。
- 仅文档提示「用 PKCS#8」——用户真实凭据是 GitHub 默认下载的 PKCS#1，零配置要求。

## Solution

纯 JS DER 包装：PKCS#1 `RSAPrivateKey` → PKCS#8 `PrivateKeyInfo`（15 字节序列头 + 版本 + 算法 OID + 原 DER），与 `openssl pkcs8 -topk8 -nocrypt` 输出**字节一致**（fixture 双证）。`normalizePrivateKey` 三分支：PKCS#1 → 转换；PKCS#8 → 透传；OpenSSH → 硬失败 + 转换命令提示。无新依赖。

## Why This Works

PKCS#8 是 WebCrypto `importKey("pkcs8")` 的规范输入；DER 包装是纯结构操作，不涉及密码学运算，可在 workerd 上安全执行。

## Prevention

- 私钥加载路径统一走 `normalizePrivateKey`（内联 PEM 与文件路径两形态）。
- 部署形态：`wrangler secret put PRIVATE_KEY` 用**内联 PEM**（workerd 无文件系统；path 形态仅本地 dev）。
- 升级 `universal-github-app-jwt` / 换 auth 库后重跑 workerd 冒烟（`wrangler dev` + 真实 PKCS#1 fixture + stub GitHub API）。
