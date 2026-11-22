import { useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@design-system";
import { t } from "../../i18n";
import { postForm } from "../api";
import type { SpaBoot } from "../boot";
import { parseCreatedWorkspace, createWorkspaceRefusalKey } from "../pages/data";
import { PageNotice } from "../pages/PageNotice";

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
    if (busy) return;
    setName("");
    setError(null);
    onOpenChange(next);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
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
      const homePath = status === 201 ? parseCreatedWorkspace(body)?.homePath ?? null : null;
      if (homePath !== null) {
        window.location.assign(homePath);
        return;
      }
      const key = createWorkspaceRefusalKey(status, body);
      if (key !== null) {
        setError(t(locale, key));
        return;
      }
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
