---
module: ops-deploy
date: 2026-10-14
problem_type: best_practice
category: best-practices
severity: medium
topic: production deploy trigger and guard
tags:
  - github-actions
  - github-token
  - workflow-dispatch
  - environments
  - secrets
  - release
  - deploy-evidence
applies_when:
  - 由一个 GitHub Release / tag 触发持有生产 secrets 的部署 workflow
  - 把「只允许 tag」的信任门禁放进持有 environment secrets 的 job
  - 让部署证据（Actions run ↔ 实际部署内容）可按 commit/ref 反查
---

# GitHub Actions 生产部署：dispatch 触发、无 secrets 守卫 job 与证据身份

## Context

本仓的生产部署链与 staging 部署链形状不同（`docs/deploy.md` § Production environment）：

- **staging** = push-to-main 自动部署（`.github/workflows/deploy.yml`），一条 `push: branches: [main]` + 紧急 `workflow_dispatch` 通道；
- **production** = 定版驱动（`.github/workflows/deploy-prod.yml`），由 Release workflow（`.github/workflows/release.yml`）在打 tag / 建 Release 之后**显式 dispatch**，另保留 `release: published` 作为人工发 Release 的兜底触发器。

这条链上四个「非显而易见」的约束都在 review 中被抓出并固化成守卫测试（`tests/scripts/deploy-prod-workflow-guards.test.ts`），且不限于本仓：任何「Release/tag → 持生产 secrets 的部署」的仓库都会撞上同样的四处。四条事实各自给出可核对证据（行号为交付时对应文件的行号）。

## Guidance

### 1. `GITHUB_TOKEN` 事件抑制：workflow 造的 Release 不会触发 `release: published`

用仓库的 `GITHUB_TOKEN` 执行动作所引发的事件**不会创建新的 workflow run**；文档中「总是创建 run」的例外只有 `workflow_dispatch` 与 `repository_dispatch`（官方原文另列了 `pull_request` 的 `opened`/`synchronize`/`reopened` 会创建 **approval-required** 状态的 run，`closed` 等其它 activity type 不创建 —— 它与本链的 `release: published` 无关，但引用文档时不能把它省略成「只有两个例外」）。

**后果**：Release workflow 用 `GITHUB_TOKEN` 创建的 tag + Release **不会**产生 `release: published` run，因此生产链不能靠事件自然接上，必须由 Release workflow 自己 `gh workflow run deploy-prod.yml --ref "$TAG"`（`.github/workflows/release.yml:165-211`，需要 job 上的 `actions: write`：`release.yml:42-44`）。保留的 `release: published` 触发器只对**人工/非 `GITHUB_TOKEN` 主体**发布的 Release 生效 —— 文档必须描述「显式 dispatch」，绝不能声称事件会自己触发（`.github/workflows/deploy-prod.yml:48-51`、`docs/release.md` § Cutting a release 步骤 5、`docs/deploy.md` § Production environment 「Why the dispatch」）。`deploy-prod.yml` 两条触发器都要留：删 `release` 关掉人工兜底门，删 `workflow_dispatch` 关掉显式门（守卫测试 `triggers: release published + workflow_dispatch with NO inputs` 把两个键钉死）。

**证据**：官方 [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token) § When `GITHUB_TOKEN` triggers workflow runs（同文重复于 [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) § Triggering a workflow from a workflow）；本仓 `.github/workflows/release.yml:10-13,21-30,133-164`。

### 2. `gh workflow run <file> --ref <ref>` 运行的是**该 ref 上的** workflow 定义

`gh workflow run` 的 `-r/--ref` 语义是「**包含**你要运行的那份 workflow 文件的 branch 或 tag」——即 dispatch 执行的是该 ref 树里的文件，不是默认分支上的最新版。

**后果**：对一个**早于**该 workflow 存在的 tag 做 dispatch 会直接失败（那个 ref 的树里没有这个文件），不是「用旧 ref 跑新逻辑」。所以 bring-up / rollback 必须指名一个**包含**该 workflow 的 tag；本仓首次生产 bring-up 因此只能 dispatch 在本次改动 merge **之后**切出的 tag（`docs/deploy.md` § One-time bring-up 步骤 5；`deploy-prod.yml:8-17`）。同一段还决定了「运行 ref 即部署身份」：workflow **没有** `ref` 输入，dispatch 的 ref 就是部署的 ref；分支 ref 的 dispatch 在改动任何资源之前被标签断言拒绝，rollback 则在 rollback 目标 tag 上 dispatch。守卫测试把「零 inputs」钉住（`triggers: release published + workflow_dispatch with NO inputs`），因为一旦加回 `ref` 输入，就会出现「run 在 release tag 上、输入却指向旧 rollback tag」的错配。

**证据**：gh 手册 [`gh workflow run`](https://cli.github.com/manual/gh_workflow_run)（`-r, --ref <string>`：Branch or tag name which **contains the version of the workflow file** you'd like to run）；本仓 `docs/deploy.md` § One-time bring-up、`.github/workflows/deploy-prod.yml:8-17,19-29`、`tests/scripts/deploy-prod-workflow-guards.test.ts` 的 triggers 钉。

### 3. 无 secrets 守卫 job：`environment:` 的 secrets 从 job 启动那一刻就在场

一个声明了 `environment:` 的 job，其 environment secrets 属于**整个 job**（官方：environment secrets 只对引用该 environment 的 workflow job 可用）。因此 job 里**第一个** checkout / install / test 步骤，就已经在跑「这个 ref 的代码」，而该 job 的 secrets 已在环境变量里 —— 任何**放在 job 内部、且晚于这些步骤**的信任门禁，都已经把代码执行权让出去了。

**模式**：把信任门禁放进**独立 job**，该 job 不声明 `environment:`、不带 job 级 `env:`、**不 checkout**（也就没有任何 ref 的代码在其中执行），只做一件事：断言「本次 run 位于 tag 上」。持有生产 secrets 的部署 job 用 `needs:` 依赖它，于是非 tag ref 连启动都不会启动那个 job —— 既拿不到生产 secrets，也无法让自己的代码在 secrets 在场的环境里运行（`.github/workflows/deploy-prod.yml:66-80`）。本仓 deploy job 自身的 job 级 `if` **不能**替代它：那个 `if` 只表达「release 事件只放行非 prerelease tag」，dispatch 分支恒真，真正的标签断言落在部署 job 内部的 step 里（`deploy-prod.yml:181-196`），晚于 checkout / install / typecheck / test / build。

environment 上「只允许 `v*` tag」的部署策略是**纵深防御，不是替代品**：它由设置页/API 维护，改它不需要过代码 review；而 workflow 自身的结构门禁是随 PR 一起被审的逻辑（`docs/deploy.md` § One-time bring-up 步骤 2 明确写了这层关系）。

**证据**：官方 [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) § Environment secrets / § Deployment branches and tags（规则按 run 的 `GITHUB_REF` 匹配）；本仓 `deploy-prod.yml:66-80`，守卫测试 `guard-tag-ref: secrets-free (no environment/env), checkout-free, asserts the run is on a tag`、`deploy job is gated on the guard (needs)`、以及 `mutation: removing needs from deploy must fail the suite`（结构断言 + 变异证明，门禁是「载重」的）。对照面：staging 的 `deploy.yml` 里守门是 job 级 `if: github.ref == 'refs/heads/main'`（`deploy.yml:37`，在 job 启动前求值），且它的 `test` job 本来就无 secrets（`deploy.yml:14-33`）—— 所以同样的隐患在 push-to-main 形状上不出现，这也是该形状不会暴露本事实的原因。

### 4. 证据身份：让 run 的 ref **就是**部署的 checkout

当一份部署证据（run summary / artifact / Release 里的「Deploy evidence」节）日后要按 commit 或 ref 反查时，最便宜的正确做法是**删掉冗余输入**，而不是事后加匹配启发式：

- production workflow **没有** `ref` 输入，因此「run 的 ref」只**命名** release；真正部署的树由第二半钉死：checkout 固定 **`github.sha`**（run 创建时的 commit，即 tag 当时指向的提交，而不是 tag 名），并要求完整历史（`deploy-prod.yml:104-112`）。`actions/checkout` 对 ref **名**是在 fetch 时解析的——一个在 owner approval 等待期间被移动的 tag 会改变「已批准 run」实际执行的树，SHA 则不会。
- 只有 SHA checkout 还不够：紧接其后、**在任何仓库代码（install / test / build）之前**有一个断言 step，要求 `git rev-parse HEAD` 等于 `github.sha`，不等则打印 `::error::` 并非零退出（`deploy-prod.yml:117-126`）。两半合起来才使「run 的 ref」与「部署的 checkout」在结构上恒等：一条 dispatch 不可能部署到自己运行的那个 tag 之外的版本，被批准的那次执行也不可能被换成别的树。
- 守卫测试把两半都钉死：`checkout pins the run's immutable SHA (github.sha) with full history`（同时断言 `fetch-depth: 0`，且 `ref` 表达式中不出现 `inputs.`）、`HEAD is asserted equal to the run SHA before any repository code runs`（并断言该 step 位于 install / test / build 之前），以及变异证明 `mutation: a checkout that does NOT pin the run SHA fails the pin (immutability is load-bearing)`（`tests/scripts/deploy-prod-workflow-guards.test.ts`）。
- 反查侧（`scripts/collect-deploy-evidence.ts`）先按**期望 ref** 匹配：`gh run list` 结果里取最新的、`headBranch === ref` 的那条（同 commit 上可能存在人工 rollback 的另一个 ref 的 run）。匹配到即视为身份证明；**匹配不到**时回退到该 commit 的最新 run，但**显式披露**这一回退（`pickRun()` 返回 `refFallback`，`refFallbackLine()` 输出「no run on ref `…` for commit `…` — the newest run for the commit is reported instead, which is not that ref's deploy」），绝不静默改报另一条 run。Release workflow 调用时正是 `--ref "$TAG"`，并把这条回退语义写在注释里（`release.yml:266-270`）。

**证据**：`.github/workflows/deploy-prod.yml:8-17,104-112,117-126`；`tests/scripts/deploy-prod-workflow-guards.test.ts`（triggers 零 inputs + checkout ref 钉 + HEAD 断言钉）；`scripts/collect-deploy-evidence.ts` 的 `pickRun` / `refFallbackLine`；`docs/deploy.md` § The run's ref is the deployed checkout。

## Why This Matters

- 这四条都**不是**读一遍 GitHub Actions 文档就能直觉得到的：事件抑制让「天然的事件链」根本不成立；dispatch 的 ref 语义决定 bring-up 能不能启动；`environment:` 的作用域把「step 级门禁」变成纸门；证据反查的可信度取决于是否删掉了冗余输入而非加了多少启发式。
- 每条都有可核对的落点（workflow 行号 / 守卫测试断言 / 官方文档 URL），因此复用它不需要重新做一遍 review 轮次：直接抄结构，让守卫测试在格式化或重构后仍然拦得住。

## When to Apply

- 任何「GitHub Release / tag 触发生成环境部署」的仓库：Release 由 workflow 创建时**必须**显式 dispatch，且文档只描述 dispatch。
- 任何持有 environment secrets 的部署 job：把「ref 类型 / 分支 / tag」这类信任断言移到独立的无 secrets、无 checkout 的守卫 job，用 `needs:` 关门；environment 策略只当纵深防御。
- 任何需要按 commit/ref 反查部署证据的场景：优先让 run 的 ref 与部署内容恒等（删掉 `ref` 输入），其次按期望 ref 匹配并显式披露回退。
- 换 tag 做 bring-up / rollback 之前：先确认目标 tag 的树里存在该 workflow 文件。

## Examples

- 生产链本体：`.github/workflows/deploy-prod.yml`（守卫 job + 部署 job 的双 job 结构、无 inputs、run-ref checkout、标签断言、evidence artifact/run summary）与其守卫测试 `tests/scripts/deploy-prod-workflow-guards.test.ts`（YAML 结构化 parse + 变异证明）。
- 事件抑制侧：`.github/workflows/release.yml` 的 dispatch 步骤与 evidence append 步骤；人工操作面文档 `docs/release.md`、`docs/deploy.md`。
- 相邻知识：[`github-actions-release-pr-chain.md`](github-actions-release-pr-chain.md)（Release PR 链本体、`GITHUB_TOKEN` 事件抑制在该链上的另一处后果）、[`github-actions-deploy-automation.md`](github-actions-deploy-automation.md)（staging push-to-main 部署链：secrets bulk、D1 迁移失败 STOP、pipefail、digest 记录）。
