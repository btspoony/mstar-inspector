---
category: Fixed
---

- **The sandbox image no longer fetches its toolchains from GitHub's release-asset CDN.** `github.com/…/releases/download/…` answered `504` for the Bun and gh CLI assets, which failed the image build and with it the staging deploy. Retrying does not recover it: eight attempts from the build network all returned `504` while `github.com`, `codeload` and `git` stayed healthy. Bun now comes from the official Docker Hub image copied at a pinned digest (same 1.4.0), and gh from GitHub's own apt pool as a checksum-verified `.deb`. The Docker Hub path is already a hard dependency of this Dockerfile — the base image and the sandbox shim are copied from it.

- **gh CLI moves from 2.98.0 to 2.103.3.** The apt pool carries only the current release, so the version is pinned in the filename and the payload is verified by sha256 in the Dockerfile. The contract constant `ghVersion` follows; nothing else reads it. The binary now installs at `/usr/bin/gh`, which is on `PATH` — no caller referenced the old `/usr/local/bin/gh` path.

<!-- CN -->
- **沙箱镜像不再从 GitHub 的 release 资产 CDN 获取工具链。** `github.com/…/releases/download/…` 对 Bun 与 gh CLI 资产返回 `504`，导致镜像构建失败，进而使 staging 部署失败。重试无法恢复：从构建网络发出的 8 次尝试全部返回 `504`，而 `github.com`、`codeload` 与 `git` 均正常。Bun 改从官方 Docker Hub 镜像按 digest 固定复制（仍为 1.4.0），gh 改从 GitHub 自己的 apt 源获取并校验 `.deb` 的 sha256。Docker Hub 本就是该 Dockerfile 的硬依赖——基础镜像与 sandbox shim 都从那里复制。

- **gh CLI 从 2.98.0 升级到 2.103.3。** 该 apt 源只保留当前发行版，因此版本固定在文件名中，并在 Dockerfile 内用 sha256 校验载荷。契约常量 `ghVersion` 随之更新；没有其他读取方。二进制现安装在 `/usr/bin/gh`，位于 `PATH` 上——没有任何调用方引用旧的 `/usr/local/bin/gh` 路径。
