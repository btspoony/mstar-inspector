---
module: review-pipeline
date: 2026-11-04
last_updated: 2026-11-04
problem_type: runtime_error
category: runtime-errors
severity: high
applies_when:
  - "Any per-round payload (diff, runner input, prompt, catalog) is passed to container.exec"
  - "A review round grows after findings are recorded and the next round dies in the sandbox stage"
resolution_type: code_fix
root_cause: "The base64 runner-input document was embedded in the single argv string that runCommand hands to /bin/sh, so a recheck round crossed Linux's 128 KiB per-argument limit and execve returned E2BIG before timeout started"
symptoms:
  - "Command `timeout` could not be started because its arguments or environment variables are too large (E2BIG)"
  - "review_failures rows with stage = 'sandbox' repeating every retry at the same head"
  - "First review round succeeds; every round after the one that records findings fails"
tags:
  - cloudflare-containers
  - sandbox-exec
  - e2big
  - argv-limit
  - review-pipeline
---

# Runner input in exec argv: a recheck round fails with E2BIG

## Problem

A review round dies in the sandbox stage with `Command 'timeout' could not be started because its arguments or environment variables are too large (E2BIG)`. Nothing else in the run is at fault: the clone, the diff capture and the numstat step all completed, and the same PR reviewed cleanly one round earlier.

## Symptoms

- `review_failures.stage = 'sandbox'`, identical error on every retry, same head sha.
- The failure starts only after a round that recorded findings — a first round on a PR never shows it.
- The message names `timeout`, the outermost wrapper, not the step that actually carries the payload.

## Root Cause

`src/pipeline/sandbox.ts` runs every step as `["timeout", "--kill-after=5", "<s>", "/bin/sh", "-lc", command]`. Each array item is one `execve` argument, so the whole shell command — including the base64 body of the runner input — was **one** argument.

Linux caps a single argument at `MAX_ARG_STRLEN = 131,072` bytes. `writeJsonCommand` used to build `printf '%s' '<base64>' | base64 -d > '<path>'`, and the recheck input is capped at 512 KiB (`RECHECK_INPUT_MAX_BYTES`). Base64 is `4 × ceil(n / 3)`, so any runner-input JSON above 98,304 bytes produced a command argument above 128 KiB and `execve` refused to start `timeout`.

A first round carries only `reconFacts` (a few KiB). A round with open findings adds `recheck` — targets plus evidence slices plus discussion — and that is what takes the document across the limit. The defect therefore looks like "this PR broke", when it is "this PR has enough findings".

## Solution

- `writeJsonCommand(path)` now emits only `base64 -d > '<path>'`; the base64 document arrives on the exec **stdin** pipe (`runCommand(..., { stdin })`), which already existed as the credential channel with a 2 MiB bound and a write-then-close EOF discipline.
- `runCommand` measures the command in UTF-8 bytes and refuses above `MAX_EXEC_COMMAND_BYTES = 96 KiB`, and each env value above 8 KiB, **before** `ensureRunning()`/`exec`. The message reports sizes only, never the payload.
- The in-image path guard stays (absolute, no `..`, no shell metacharacter); the base64-charset guard is gone with the argument it validated.

## Why This Works

`exec()` takes an argument array and starts the executable directly; large payloads belong on stdin (or in a file the container already owns). Keeping argv to flags and paths means the per-argument limit never sees user-scale content, and the stdin bound (2 MiB) is the only ceiling that needs tuning.

## Prevention

- Any per-round variable content goes on stdin or a file — never interpolated into a command string, even base64-encoded.
- Keep a fail-closed bound at the sandbox sink: a payload that approaches the platform limit should fail as a named step bug with a readable size, not as a platform `E2BIG`.
- A 98 KiB argv payload is already a defect even though the API accepts it; the ceiling is the kernel's, not the SDK's.
