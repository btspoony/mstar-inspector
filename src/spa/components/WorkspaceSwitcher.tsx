/**
 * Workspace switcher (the workspace-identifier work, 2026-10). URL-only:
 * picking a workspace rewrites the workspace segment of the CURRENT path and
 * lets the router re-render from the pathname — no fetch, no reload, no
 * cookie. A workspace the current path has no resource for stays a 404 on that
 * URL (the unknown-path stub), which is the honest answer; nothing redirects
 * back.
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
  hash: string = window.location.hash,
): boolean {
  const path = replaceWorkspaceRef(pathname, nextRef);
  if (path === null) return false;
  navigate(`${path}${search}${hash}`);
  return true;
}

export function WorkspaceSwitcher({ model }: { model: WorkspaceSwitcherModel | null }) {
  // One membership is not a choice: the shell renders no control at all.
  if (model === null) return null;
  return (
    <Select
      // Always controlled, and never a stand-in value: when the path names a
      // workspace this login does not list (a slug renamed away, a revoked
      // membership) NO row is current, so the trigger stays empty. Showing the
      // first membership there would claim a workspace the URL does not name.
      value={model.currentRef ?? ""}
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
