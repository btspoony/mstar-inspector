/**
 * The top-bar workspace control (moved out of the sidebar header into the
 * navbar's left cluster). URL-only: picking a workspace rewrites
 * the workspace segment of the CURRENT path and lets the router re-render from
 * the pathname — no fetch, no reload, no cookie. A workspace the current path
 * has no resource for stays a 404 on that URL (the unknown-path stub), which is
 * the honest answer; nothing redirects back.
 *
 * The menu ends with "New workspace": enabled when the boot allows it, and at
 * the free-slot cap a DISABLED row carrying the stated reason — a user needs to
 * know why they cannot create one, and the rule itself. The enabled row opens
 * the shell's creation dialog (`CreateWorkspaceDialog`); the disabled one opens
 * nothing.
 */
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SpaBoot } from "../boot";
import { t, type DictionaryKey } from "../../i18n";
import { navigate } from "../router";
import { replaceWorkspaceRef } from "../routes";
import type { WorkspaceSwitcherModel } from "../shell";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";

type BlockedReason = NonNullable<SpaBoot["createWorkspaceBlockedReason"]>;

/** One stated reason per boot block reason — never a generic "disabled". */
const BLOCKED_REASON_KEY: Record<BlockedReason, DictionaryKey> = {
  free_slot: "nav.newWorkspaceBlockedFreeSlot",
  flag: "nav.newWorkspaceBlockedFlag",
};

/**
 * Point the page at another workspace and hand the router the new path: either
 * rewrite the current path's workspace segment, or — on a path that names no
 * workspace — open that workspace's Apps page. False when a rewrite was asked
 * for and the pathname names no workspace to rewrite.
 */
export function switchWorkspace(
  nextRef: string,
  target: WorkspaceSwitcherModel["target"] = "replace",
  pathname: string = window.location.pathname,
  search: string = window.location.search,
  hash: string = window.location.hash,
): boolean {
  if (target === "apps") {
    navigate(`/dashboard/${nextRef}/apps`);
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
  // The creation dialog lives here because this menu is its only entry: an
  // existing member creates from the switcher (Task 6), while a
  // no-workspace login still gets the routed setup page.
  const [creating, setCreating] = useState(false);
  // No membership at all is not a choice: the shell renders no control.
  if (model === null) return null;
  const locale = boot.locale;
  // Never a stand-in name: when the path names a workspace this login does not
  // list (a slug renamed away, a revoked membership) — or names none at all —
  // NO row is current, so the trigger shows the control's own label.
  const current = model.options.find((option) => option.ref === model.currentRef);
  // The plan chip is a `saas` surface only (D15/D20): self-hosted has no tier
  // to display. It rides the CURRENT workspace's name, so a path that names no
  // workspace (the navigator) shows no chip. The value comes from that
  // membership row, never from the boot's addressed workspace: a switch only
  // rewrites the URL, so a boot-keyed plan would keep naming the workspace the
  // document loaded with.
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
          {/* A radio group: "the current workspace" is a chosen row, not a click
              target — each row reports `aria-checked`. An empty value marks none. */}
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
