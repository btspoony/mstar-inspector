---
category: Fixed
---

- **The sandbox image no longer fetches its toolchains from GitHub's release-asset CDN.** `github.com/…/releases/download/…` answered `504` for the Bun and gh CLI assets, which failed the image build and with it the staging deploy. Retrying does not recover it: eight attempts from the build network all returned `504` while `github.com`, `codeload` and `git` stayed healthy. Bun now comes from the official Docker Hub image copied at a pinned digest (still 1.4.0, declared as `bunImageDigest` alongside `bunVersion`), and gh installs from GitHub's own apt pool. Docker Hub is already a hard dependency of this Dockerfile — the base image and the sandbox shim are copied from it.

- **gh CLI installs unpinned from GitHub's apt pool, on purpose.** That pool keeps only the current release and its predecessor (2.98.0 and 2.103.3 resolve; 2.90.0 and 2.80.0 are 404), so any filename-pinned URL becomes a build break within two gh releases — fixing today's outage only by scheduling the next one. The image therefore installs whatever the pool serves and prints `gh --version` into the build log. `gh` is the one build input not recorded in `OMP_SANDBOX_IMAGE_PINS`, and the type carries that trade-off in writing.

- **`unzip` is gone from the image.** It existed only to expand the Bun release zip, which no longer exists; nothing else in the file unpacks an archive.

<!-- CN -->
- **沙箱镜像不再从 GitHub 的 release 资产 CDN 获取工具链。** `github.com/…/releases/download/…` 对 Bun 与 gh CLI 资产返回 `504`，导致镜像构建失败，进而使 staging 部署失败。重试无法恢复：从构建网络发出的 8 次尝试全部返回 `504`，而 `github.com`、`codeload` 与 `git` 均正常。Bun 改从官方 Docker Hub 镜像按 digest 固定复制（仍为 1.4.0，以 `bunImageDigest` 与 `bunVersion` 一并声明），gh 改从 GitHub 自己的 apt 源安装。Docker Hub 本就是该 Dockerfile 的硬依赖——基础镜像与 sandbox shim 都从那里复制。

- **gh CLI 有意从 GitHub 的 apt 源非固定安装。** 该源只保留当前发行版与上一个版本（2.98.0 与 2.103.3 可解析；2.90.0、2.80.0 为 404），因此任何把版本写进文件名的 URL 都会在 gh 发两个版本后变成构建中断——那等于把今天的故障换成一次定时的故障。镜像因此安装该源当前提供的版本，并把 `gh --version` 打印进构建日志。`gh` 是唯一未记录在 `OMP_SANDBOX_IMAGE_PINS` 中的构建输入，该取舍写在类型注释里。

- **镜像中移除 `unzip`。** 它原本只用于解开 Bun 的 release zip，而该 zip 已不存在；文件中没有其他解包动作。
