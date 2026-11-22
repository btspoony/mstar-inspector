import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import { parseSupportGrants, type SupportGrantRow } from "../pages/data";
import { ErrorState } from "./state/ErrorState";
import { PageNotice } from "../pages/PageNotice";


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
