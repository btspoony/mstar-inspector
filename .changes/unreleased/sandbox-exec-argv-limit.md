---
category: Fixed
---

- **The runner input travels on the exec stdin pipe**: the `--input` document is now base64-encoded into the container step's stdin (`base64 -d > '<path>'`) instead of being embedded in the shell string. A recheck round with enough findings pushed the encoded document past Linux's 128 KiB per-argument limit, so `execve` returned `E2BIG` and every later round died at `stage=sandbox` before `timeout` started. The write step still fails the round on a non-zero exit.
- **Commands that approach the per-argument limit fail closed with a readable error**: `runCommand` measures the command (and each env value) in UTF-8 bytes before starting a container or a process, and refuses above 96 KiB (8 KiB per env value). The error names the size and the bound and never echoes the command, so an over-large step is diagnosed as a step problem instead of a platform `E2BIG`.

<!-- CN -->
- **runner 输入改走 exec 的 stdin 管道**：`--input` 文档不再拼进 shell 字符串，而是以 base64 写入容器步骤的 stdin（`base64 -d > '<路径>'`）。当评审轮次的发现足够多时，编码后的文档会超过 Linux 单参数 128 KiB 上限，`execve` 返回 `E2BIG`，此后每一轮都在 `stage=sandbox`、`timeout` 尚未启动时失败。写文件步骤非零退出仍会判定该轮失败。
- **接近单参数上限的命令直接拒绝，并给出可读错误**：`runCommand` 在启动容器或任何进程之前，按 UTF-8 字节测量命令与各 env 值，命令超过 96 KiB（env 单值 8 KiB）即拒绝。错误信息只给出实际大小与上限，不回显命令内容，因此超限步骤可以定位到功能本身，而不再是平台的 `E2BIG`。
