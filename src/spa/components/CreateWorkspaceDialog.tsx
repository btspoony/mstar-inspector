/**
 * Workspace creation from the top-bar switcher (plan 115, Task 6). Before this
 * surface, the menu item sent an existing member to `/dashboard`, which serves
 * the creation form only for a `needsWorkspace` boot — so the click landed on
 * their own workspace. The dialog posts the same route with the same name
 * limits, then hands the browser a FULL navigation to the apps page the 201
 * names: the in-memory boot is pre-creation and lists no membership for the
 * new workspace, so an in-SPA `navigate()` would render a shell that cannot
 * name it.
 *
 * The free-slot rule stays the server's (compass D5): the client posts, and a
 * 409 renders the refusal body verbatim. Nothing here pre-judges the slot.
 */
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "../../i18n";
import { postForm } from "../api";
import type { SpaBoot } from "../boot";
import { parseCreatedWorkspace } from "../pages/data";
import { PageNotice } from "../pages/PageNotice";

/** Server-side cap (src/dashboard/index.ts WORKSPACE_NAME_MAX_LENGTH). */
const NAME_MAX_LENGTH = 80;

export function CreateWorkspaceDialog({
  boot,
  open,
  onOpenChange,
}: {
  boot: SpaBoot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const locale = boot.locale;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (busy) return; // a POST in flight cannot be dismissed under itself
    // A reopened dialog starts clean: the previous attempt's name and refusal
    // belong to that attempt. Every close path (ESC, overlay, Cancel) routes
    // through here.
    setName("");
    setError(null);
    onOpenChange(next);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError(t(locale, "workspace.nameRequired"));
      return;
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      setError(t(locale, "workspace.nameTooLong", { max: NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { status, body } = await postForm("/dashboard/api/workspaces", { name: trimmed });
      const appsPath = status === 201 ? parseCreatedWorkspace(body)?.appsPath ?? null : null;
      if (appsPath !== null) {
        window.location.assign(appsPath);
        return;
      }
      // 409 is the free-slot refusal: its body IS the copy the user must read
      // (the rule, and how to free the slot), so it renders verbatim.
      setError(status === 409 && body.trim() !== "" ? body : t(locale, "workspace.createFailed"));
    } catch {
      setError(t(locale, "workspace.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(locale, "workspace.setupHeading")}</DialogTitle>
          <DialogDescription>{t(locale, "workspace.createDialogDescription")}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void onCreate(event)}>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="create-workspace-name">
              {t(locale, "workspace.nameLabel")}
            </label>
            <Input
              id="create-workspace-name"
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t(locale, "workspace.namePlaceholder")}
            />
          </div>
          {error === null ? null : <PageNotice kind="error" message={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
              {t(locale, "common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(locale, "workspace.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
