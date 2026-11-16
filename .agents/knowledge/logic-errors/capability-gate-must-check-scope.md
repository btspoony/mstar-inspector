---
module: capability gates on a shared resource
date: 2026-11-16
problem_type: logic_error
category: logic-errors
severity: high
applies_when:
  - A plan capability (a boolean on a plan row) gates use of a resource that is sometimes shared and sometimes owned
  - The gate is called from more than one seam (creation, enqueue, a settings action)
  - The resource row carries its own scope column
tags:
  - entitlement
  - authorization
---

# 共享能力的闸门必须在函数内部判 scope，不能由调用点信任

## 现象

新增"这个计划是否包含共享 bot"的能力位后，实现者在 webhook 的入队路径上无条件调用 `assertSharedBotAllowed(target.workspace_id)`。测试全绿，因为测试都在验证拒绝路径本身。

真实的后果是：SaaS 下一个 `free` 工作区用它**自己**的 GitHub App 发起 review，也会被当成共享 bot 使用而被跳过，并留下一条写着"计划不含共享 bot"的失败行。三席 QC 独立命中同一条：闸门没有判断 `bot.scope === "shared"`。

## 根因

能力位的名字（`shared_bot_allowed`）描述的是**资源的一种模式**，而调用点拿到的只是一个 workspace。把"我该不该检查"的负担推给每个调用点，就等于让每个调用点重复一遍范围判断——而其中一个忘了，或者按最省事的方式写成了无条件检查。

创建路径之所以没出同样的错，是因为它的入口名就叫 `createOnSharedBot`，范围写在函数名里；入队路径的入口是通用的 `handleReviewJob`，范围无处体现。

## 做法

1. 闸门函数自己判范围：`if (bot.scope !== "shared") return null;`，放在任何计划读取之前——自有 bot 路径连一次订阅查询都不该付。
2. 调用点只回答一个问题："这个请求打到的是哪个 bot 行"，不回答"要不要检查"。
3. 回归用例必须包含**共享能力关闭、但用自有 bot** 的正向路径。只测拒绝路径的套件无法发现这条 bug，因为它测的是函数行为，而 bug 在传播路径上。
4. 每条拒绝路径都问一次：这次拒绝花不花钱？入队拒绝若不先取消 KV 预检、claim 行与队列发送，就会"拒绝但仍然消耗"。

## 判据

闸门函数签名里如果只有 `workspaceId`，而它要保护的资源有 scope 列，那么范围判断一定漏在了某个调用点。签名应该是 `(workspaceId, botRow)`，或者调用点传进来的东西本身已经证明了范围。
