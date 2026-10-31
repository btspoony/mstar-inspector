/**
 * Public entry point of the design system.
 *
 * Everything outside `src/design-system/` reaches this module one way only:
 * the `@design-system` alias, which every program maps onto this file.
 * `tokens/`, `baseline/`, `primitives/` and `patterns/` are module internals —
 * importing them directly, by alias subpath or by relative path, breaks the
 * boundary that `tests/design-system/boundary.test.ts` enforces.
 *
 * The re-export surface starts empty by design: the token sources land here in
 * plan 201 tasks 2-4, the primitives and patterns in plan 202.
 */
export {};
