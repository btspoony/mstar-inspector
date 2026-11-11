---
category: Fixed
---

- **A deferred Check wait never outlives the attempt's own deadline**: while a Check attempt waits for its publication's proof, the reconciler gives the claim back due at the first backoff rung — now clamped to the attempt's execution deadline. When that deadline fell inside the rung, the row stayed unselected until the rung elapsed, so the PR's check sat on `in_progress` past the hard stop it was supposed to conclude at. The row is now due at the deadline itself and concludes on the next pass after it.

<!-- CN -->
- **等待发布证明的检查不再越过该次尝试自身的截止时间**：检查尝试在等待发布证明期间会把认领（claim）交还，并把到期时间设为首个退避档位——现在这一到期时间被钳制在该次尝试的执行截止时间上。此前若截止时间落在该档位之内，该行在档位走完前都不会被选中，PR 的检查会停在 `in_progress` 超过本应结束的最后期限。现在该行在截止时刻即到期，并在之后的第一趟对账中得出结论。
