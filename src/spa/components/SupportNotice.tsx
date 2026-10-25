import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import { parseSupportGrants, type SupportGrantRow } from "../pages/data";
import { ErrorState } from "./state/ErrorState";
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
 * The read happens once per workspace, not once per route: the shell survives
 * client-side navigation, so a pathname-keyed effect re-read a notice that
 * cannot change between pages of the same workspace. A failed read renders an
 * inline error with a retry control instead of reading as "no active grants".
 *
 * Renders nothing for the operator's own support face (they already see their
 * grants there) and for a login with no workspace yet.
 */

/**
 * One read per workspace base (the workspace, not the page), shared by every
 * mount that lands on it. A rejection is evicted so retry reads again.
 */
const reads = new Map<string, Promise<SupportGrantRow[] | null>>();

function readGrants(base: string): Promise<SupportGrantRow[] | null> {
  const cached = reads.get(base);
  if (cached !== undefined) return cached;
  const read = fetchJson(`${base}/api/support/grants`).then(parseSupportGrants);
  reads.set(base, read);
  void read.catch(() => {
    if (reads.get(base) === read) reads.delete(base);
  });
  return read;
}

export function SupportNotice({ boot, pathname }: { boot: SpaBoot; pathname: string }) {
  const base = apiBase(pathname);
  const skip = boot.login === null || boot.supportOnly === true || boot.needsWorkspace === true;
  const [grants, setGrants] = useState<SupportGrantRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (skip) return;
    // Clear first: a workspace switch must not leave another workspace's
    // notice on screen.
    setGrants([]);
    setFailed(false);
    let live = true;
    readGrants(base).then(
      (parsed) => {
        if (live) setGrants(parsed ?? []);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [base, skip, attempt]);

  if (skip) return null;
  if (failed) {
    return (
      <div className="mb-4">
        <ErrorState
          locale={boot.locale}
          message={t(boot.locale, "support.noticeError")}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      </div>
    );
  }
  if (grants.length === 0) return null;
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
