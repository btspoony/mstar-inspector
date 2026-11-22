import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@design-system";
import type { SpaBoot } from "../boot";
import { t, type DictionaryKey } from "../../i18n";
import { navigate } from "../router";
import { replaceWorkspaceRef } from "../routes";
import type { WorkspaceSwitcherModel } from "../shell";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";

type BlockedReason = NonNullable<SpaBoot["createWorkspaceBlockedReason"]>;

const BLOCKED_REASON_KEY: Record<BlockedReason, DictionaryKey> = {
  free_slot: "nav.newWorkspaceBlockedFreeSlot",
  flag: "nav.newWorkspaceBlockedFlag",
};

/**
 * Point the page at another workspace and hand the router the new path: either
 * rewrite the current path's workspace segment, or — on a path that names no
 * workspace — open that workspace's repository overview, the dashboard
 * default. False when a rewrite was asked for and the pathname names no
 * workspace to rewrite.
 */
export function switchWorkspace(
  nextRef: string,
  target: WorkspaceSwitcherModel["target"] = "replace",
  pathname: string = window.location.pathname,
  search: string = window.location.search,
  hash: string = window.location.hash,
): boolean {
  if (target === "repos") {
    navigate(`/dashboard/${nextRef}/repos`);
    return true;
  }
  const path = replaceWorkspaceRef(pathname, nextRef);
  if (path === null) return false;
  navigate(`${path}${search}${hash}`);
  return true;
}

export function WorkspaceSwitcher({
  model,
  boot,
}: {
  model: WorkspaceSwitcherModel | null;
  boot: SpaBoot;
}) {
  const [creating, setCreating] = useState(false);
  if (model === null) return null;
  const locale = boot.locale;
  const current = model.options.find((option) => option.ref === model.currentRef);
  const plan = boot.deploymentMode === "saas" ? model.currentPlan : undefined;
  const blockedReason: BlockedReason | null =
    boot.canCreateWorkspace === false ? (boot.createWorkspaceBlockedReason ?? null) : null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-64 justify-start" aria-label={model.label}>
            <span className="truncate">{current?.name ?? model.label}</span>
            {plan === undefined ? null : (
              <span className="rounded-full border border-primary/40 px-1.5 text-xs text-primary">{plan}</span>
            )}
            <ChevronDown aria-hidden="true" className="opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{model.label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={model.currentRef ?? ""}
            onValueChange={(ref) => void switchWorkspace(ref, model.target)}
          >
            {model.options.map((option) => (
              <DropdownMenuRadioItem key={option.ref} value={option.ref}>
                <span className="truncate">{option.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={boot.canCreateWorkspace === false} onSelect={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            <span className="flex flex-col">
              <span>{t(locale, "nav.newWorkspace")}</span>
              {blockedReason === null ? null : (
                <span className="text-xs text-muted-foreground">{t(locale, BLOCKED_REASON_KEY[blockedReason])}</span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog boot={boot} open={creating} onOpenChange={setCreating} />
    </>
  );
}
