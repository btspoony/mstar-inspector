/**
 * Module import matrix guard (plan 07 Task 2 + spec § 模块 import 矩阵):
 * the workerd faces — src/worker, src/pipeline, src/store — must NEVER import
 * the omp SDK (container-only). This is the executable form of the plan
 * verification `grep -n 'from "@oh-my-pi/pi-coding-agent"' src/worker
 * src/pipeline src/store` → no matches; it additionally covers dynamic
 * imports and require() spellings.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Faces that run on workerd and are barred from the omp SDK. */
const WORKERD_FACES = ["src/worker", "src/pipeline", "src/store"] as const;

const OMP_SDK_RE = /@oh-my-pi\/pi-coding-agent/;

/** Collect every .ts/.js/.tsx file under a directory, recursively. */
function collectFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("module import matrix — omp SDK is container-only", () => {
  for (const face of WORKERD_FACES) {
    test(`${face} never references @oh-my-pi/pi-coding-agent`, () => {
      const offenders: string[] = [];
      for (const file of collectFiles(face)) {
        const source = readFileSync(file, "utf8");
        if (OMP_SDK_RE.test(source)) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
