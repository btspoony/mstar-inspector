# Nullable entitlement limits (NULL = unlimited)

When a plan's quota column is nullable, `NULL` means **unlimited** and that must be
true at every enforcement point, not just in the display layer. This repo's
`plans` catalogue documents that contract; this note records what it costs to hold
it in code.

## The three places a limit is enforced

A workspace seat limit is checked by three independent surfaces, and all three must
agree:

1. **Route fast-fail** — an early read that returns a friendly 409.
2. **Write-time guard** — SQL carried by the insert itself, so a read-then-write
   race cannot slip past the route check.
3. **Acceptance path** — the invite-acceptance insert, which has its own copy of
   the rule.

If any one of them reads `null` as a number, the tier is silently wrong in one
direction: `?? 0` caps an unlimited plan at zero seats; treating `0` as unlimited
uncaps a real zero-seat plan.

## The SQL trap

`count < ?8` with a NULL bound evaluates to NULL, which is falsy in the guard's
`WHERE`. The insert then writes nothing and the caller reports a cap refusal — so
an unlimited plan refuses every invite. The null must **short-circuit before the
bind**: build a different statement (no seat condition, fewer bind parameters) for
the unlimited case rather than binding NULL into the comparison.

Corollary: when a guard has two shapes, assert the numeric shape's SQL text and
bind list stay byte-identical, or the branch will drift silently.

## Resolution order can outrank stored rows

A deployment-mode rule ("this whole deployment is unlimited") must be evaluated
**before** reading the subscription row, or workspaces created earlier under a
different rule keep their old cap forever. The stored row stays truthful to what
was last assigned; the mode decides what applies now. Putting mode second means
the requirement "every workspace in this deployment is unlimited" is false for
exactly the workspaces that already exist — the ones users notice.

## What this cost

- One migration had to relax `included_members` from `NOT NULL` (SQLite rebuild;
  a rename-form rebuild cannot preserve an inbound FK while child rows exist —
  copy through a staging table and re-create under the final name).
- The SPA wire type had to widen in the **same commit** as the resolver flip, or
  an intermediate commit emits a value the client parser rejects and the whole
  members summary silently disappears.
