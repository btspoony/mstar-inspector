import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import { parseSupportGrants, type SupportGrantRow } from "../pages/data";
import { PageNotice } from "../pages/PageNotice";

/**
 * The tenant's always-on support notice (platform-operator support, 2026-10).
 *
 * Every member of the workspace sees who holds a live support grant, why, and
 * when it ends. It is deliberately UNDISMISSABLE and carries no control — the
 * tenant can neither end nor edit a grant; only the operator's own store action
 * can. The read is the same `/api/support/grants` face the operator's support
 * view uses, so a grant that lapses simply stops being listed.
 *
 * Keyed on the pathname, not just the base: the shell survives client-side
 * navigation, so re-reading on every route change is what lets a grant created
 * (or lapsed) mid-session reach a tab that is already open.
 *
 * Renders nothing for the operator's own support face (they already see their
 * grants there) and for a login with no workspace yet.
 */
export function SupportNotice({ boot, pathname }: { boot: SpaBoot; pathname: string }) {
  const [grants, setGrants] = useState<SupportGrantRow[]>([]);
  const skip = boot.login === null || boot.supportOnly === true || boot.needsWorkspace === true;

  useEffect(() => {
    if (skip) return;
    // Clear first: a workspace switch (or a refetch that fails and is
    // swallowed below) must not leave another workspace's notice on screen.
    setGrants([]);
    const base = apiBase(pathname);
    let live = true;
    void (async () => {
      try {
        const parsed = parseSupportGrants(await fetchJson(`${base}/api/support/grants`));
        if (live && parsed !== null) setGrants(parsed);
      } catch {
        // A caller who cannot read the notice (403/404/redirect) sees none: the
        // surface is informational, never a blocking gate.
      }
    })();
    return () => {
      live = false;
    };
  }, [pathname, skip]);

  if (skip || grants.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-1">
      <PageNotice kind="warn" message={t(boot.locale, "support.noticeHeading")} />
      {grants.map((grant) => (
        <PageNotice
          key={`${grant.operator_login}:${grant.expires_at}`}
          kind="warn"
          message={t(boot.locale, "support.noticeLine", {
            login: grant.operator_login,
            reason: grant.reason,
            expires: grant.expires_at,
          })}
        />
      ))}
    </div>
  );
}
