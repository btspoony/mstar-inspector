/**
 * Test preload: settle DOM availability before any test module loads.
 *
 * `react-dom/client` and `@radix-ui/primitive` each record `canUseDOM` once,
 * when they are first evaluated; React's event plugins never register and
 * Radix portals never open when that answer is captured without a document.
 * Bun caches a module for the whole process, so a single spa test that imports
 * either at module scope before installing a DOM would silently break every
 * mounted test after it — which file that is depends on runner discovery order,
 * not on the test.
 *
 * `warmDom` evaluates both under a throwaway window and then removes the
 * globals again, so each test still installs the DOM it uses itself and no test
 * sees a window it did not ask for. This file is not a DOM install.
 */
import { warmDom } from "./dom";

await warmDom();
