/**
 * Workspace switcher (plan 98 T3). URL-only: picking a workspace rewrites the
 * workspace segment of the CURRENT path and lets the router re-render from the
 * pathname — no fetch, no reload, no cookie. A workspace the current path has
 * no resource for stays a 404 on that URL (the unknown-path stub), which is the
 * honest answer; nothing redirects back.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { navigate } from "../router";
import { replaceWorkspaceRef } from "../routes";
import type { WorkspaceSwitcherModel } from "../shell";

/**
 * Point the current page at another workspace and hand the router the new
 * path. False when the pathname names no workspace to rewrite (a
 * deployment-level page) — the control then has nothing to switch.
 */
export function switchWorkspace(
  nextRef: string,
  pathname: string = window.location.pathname,
  search: string = window.location.search,
): boolean {
  const path = replaceWorkspaceRef(pathname, nextRef);
  if (path === null) return false;
  navigate(`${path}${search}`);
  return true;
}

export function WorkspaceSwitcher({ model }: { model: WorkspaceSwitcherModel | null }) {
  // One membership is not a choice: the shell renders no control at all.
  if (model === null) return null;
  return (
    <Select
      value={model.currentRef ?? undefined}
      onValueChange={(ref) => void switchWorkspace(ref)}
    >
      <SelectTrigger size="sm" className="w-full" aria-label={model.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {model.options.map((option) => (
          <SelectItem key={option.ref} value={option.ref}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
