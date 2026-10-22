import { useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { postForm } from "../api";
import type { SpaBoot } from "../boot";
import { parseCreatedWorkspace } from "./data";
import { PageNotice, type NoticeKind } from "./PageNotice";

/** Server-side cap (src/dashboard/index.ts WORKSPACE_NAME_MAX_LENGTH). */
const NAME_MAX_LENGTH = 80;

/**
 * Where a creation POST sends the browser: the landing the 201 named, or null
 * when the response carries none (the caller surfaces the failure notice). The
 * page never derives the target itself — only the Worker knows whether the
 * deployment serves workspace routes, and `strict`'s sole-workspace resolver
 * cannot name a workspace once a second one exists.
 */
export function creationLanding(status: number, body: string): string | null {
  if (status !== 201) return null;
  return parseCreatedWorkspace(body)?.appsPath ?? null;
}

/**
 * Workspace creation — the signed-in landing for a login that belongs to no
 * workspace yet. Sign-in never joins a workspace, so this page is
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
      const { status, body } = await postForm("/dashboard/api/workspaces", { name: trimmed });
      const landing = creationLanding(status, body);
      if (landing !== null) {
        window.location.replace(landing);
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
