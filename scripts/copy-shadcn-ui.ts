import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY = "/tmp/shadcn33";
const OUT_UI = path.resolve("src/spa/components/ui");
const OUT_HOOKS = path.resolve("src/spa/hooks");

const RADIX_MAP: Record<string, string> = {
  Slot: "@radix-ui/react-slot",
  Select: "@radix-ui/react-select",
  DropdownMenu: "@radix-ui/react-dropdown-menu",
  Tabs: "@radix-ui/react-tabs",
  Toggle: "@radix-ui/react-toggle",
  ToggleGroup: "@radix-ui/react-toggle-group",
  Dialog: "@radix-ui/react-dialog",
  Separator: "@radix-ui/react-separator",
  Tooltip: "@radix-ui/react-tooltip",
};

function transformSource(content: string): string {
  let out = content;
  out = out.replace(/^"use client"\n\n/, "");
  out = out.replaceAll("@/registry/new-york-v4/lib/utils", "@/lib/utils");
  out = out.replaceAll("@/registry/new-york-v4/hooks/use-mobile", "@/hooks/use-mobile");
  out = out.replaceAll("@/registry/new-york-v4/ui/", "@/components/ui/");

  for (const [exportName, pkg] of Object.entries(RADIX_MAP)) {
    const re = new RegExp(
      `import \\{ ${exportName}(?: as \\w+)? \\} from "radix-ui"`,
      "g",
    );
    if (exportName === "Slot") {
      out = out.replace(
        re,
        `import { Slot } from "${pkg}"`,
      );
      out = out.replaceAll("Slot.Root", "Slot");
      continue;
    }
    const alias = `${exportName}Primitive`;
    out = out.replace(
      re,
      `import * as ${alias} from "${pkg}"`,
    );
    out = out.replace(
      new RegExp(`import \\{ ${exportName} as ${alias} \\} from "radix-ui"`, "g"),
      `import * as ${alias} from "${pkg}"`,
    );
  }

  // Sheet uses Dialog from radix-ui
  out = out.replace(
    /import \{ Dialog as SheetPrimitive \} from "radix-ui"/,
    'import * as SheetPrimitive from "@radix-ui/react-dialog"',
  );

  return out;
}

async function writeFromRegistry(name: string, outName?: string) {
  const file = path.join(REGISTRY, `${name}.json`);
  const raw = JSON.parse(await readFile(file, "utf8")) as {
    files: { path: string; content: string }[];
  };
  const entry = raw.files[0];
  if (!entry) throw new Error(`no files in ${name}`);
  const destName = outName ?? `${name}.tsx`;
  const dest =
    name === "use-mobile"
      ? path.join(OUT_HOOKS, "use-mobile.ts")
      : path.join(OUT_UI, destName);
  const content = transformSource(entry.content);
  await writeFile(dest, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  console.log("wrote", dest);
}

await mkdir(OUT_UI, { recursive: true });
const items = [
  "button",
  "input",
  "card",
  "table",
  "separator",
  "skeleton",
  "tooltip",
  "toggle",
  "toggle-group",
  "tabs",
  "select",
  "dropdown-menu",
  "dialog",
  "sheet",
  "sidebar",
];
for (const item of items) {
  await writeFromRegistry(item);
}
