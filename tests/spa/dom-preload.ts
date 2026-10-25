/**
 * Test preload: decide Radix's DOM availability before any test module loads.
 *
 * `@radix-ui/primitive` records `canUseDOM` once, when it is first evaluated,
 * and `getOwnerDocument`/`getOwnerWindow` throw when that answer is false.
 * Bun's runner caches the module for the whole process, so a test file that
 * imports the SPA component graph before any DOM exists poisons every later
 * mounted render — which file that is depends on the order the runner happens
 * to discover, not on the test. Warming the graph here makes the answer
 * order-independent; the globals are removed again so no test sees a DOM it
 * did not install itself.
 */
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const scope = globalThis as unknown as Record<string, unknown>;
Object.assign(scope, { window: win, document: win.document });

// The dialog module reaches `@radix-ui/primitive`, whose answer every Radix
// package reads; importing it here loads that module with a DOM in place.
await import("../../src/spa/components/ui/dialog");

// Drop only what this file installed: Bun's own `navigator` (and any other
// host global) stays untouched for the rest of the run.
delete scope.window;
delete scope.document;
win.close();
