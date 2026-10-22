import { useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { postForm } from "../api";
import type { SpaBoot } from "../boot";
import { PageNotice, type NoticeKind } from "./PageNotice";

/** Server-side cap (src/dashboard/index.ts WORKSPACE_NAME_MAX_LENGTH). */
const NAME_MAX_LENGTH = 80;

/**
 * Workspace creation — the signed-in landing for a login that belongs to no
 * workspace yet (plan 97 T3). Sign-in never joins a workspace, so this page is
 * the only way into a first one; the creator becomes its `owner` and the POST
 * answers the workspace ref the shell then navigates to.
 *
 * Creation is NOT an invitation: no auto-join, and no "first user becomes
 * admin of the only workspace" fallback.
 */
export function WorkspaceSetupPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNotice({ kind: "error", message: t(locale, "workspace.nameRequired") });
      return;
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      setNotice({
        kind: "error",
        message: t(locale, "workspace.nameTooLong", { max: NAME_MAX_LENGTH }),
      });
      return;
    }
    setBusy(true);
    try {
      const { status } = await postForm("/dashboard/api/workspaces", { name: trimmed });
      if (status === 201) {
        // The new workspace's ref IS its id — reload so the shell (and the
        // boot-injected workspace slug) pick the new membership up.
        window.location.replace("/dashboard");
        return;
      }
      setNotice({ kind: "error", message: t(locale, "workspace.createFailed") });
    } catch {
      setNotice({ kind: "error", message: t(locale, "workspace.createFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "workspace.setupHeading")}
        </h1>
      </div>
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
            {t(locale, "workspace.setupHeading")}
          </CardTitle>
          <CardDescription>{t(locale, "workspace.setupDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void onCreate(event)}>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="workspace-name">
                {t(locale, "workspace.nameLabel")}
              </label>
              <Input
                id="workspace-name"
                className="w-64"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t(locale, "workspace.namePlaceholder")}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {t(locale, "workspace.create")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
