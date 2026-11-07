# Degraded-read cause taxonomy

**Area:** dashboard reads · `src/dashboard/runtime-config-store.ts` · commit page

## Shape

A dashboard read that can fail for several reasons carries the cause instead of a boolean: `{ value, degraded, reason?: DegradedReason }` with `read-failed | malformed | untrusted`. The sibling budget read already did this; the floor read learned it later.

The commit page must branch its **repair imperative** on the cause, never its generic heading:

| cause | page | repair |
|---|---|---|
| `read-failed` | retryable | "resubmit" — no settings link |
| `malformed` | schema is older than the code | name the exact migration file |
| `untrusted` | a value nobody can act on | repair in settings, with a link |

## Two traps

1. **A boolean classifies nothing.** Three causes behind one `degraded` flag means a transient D1 failure sends the operator to the settings page. If a caller cannot distinguish, it will give the wrong instruction — the defect class, not a cosmetic one.
2. **A synthetic error is not a schema.** Classifying by message text is fine, but drive it with the *real* shape or prove the claim honestly: constructing `new Error("no such column: x")` tests the regex, not the driver. Say which one you proved.
3. **Narrow the classifier to the column you actually name.** Matching any `no such column|table` told a pre-0026 database (missing `deleted_at`) or one missing the table itself to apply the floor migration, which cannot fix it. Match the specific identifier the read selects; everything else is `read-failed` — the safe direction, because a less specific retry beats a wrong repair pointer.

## Configuration note

The rendered sentences live in both dictionaries; the key set is compile-bound (`satisfies Record<string, DictionaryKey>`), so a missing translation is a type error, not a runtime fallback to English inside a localized sentence.
