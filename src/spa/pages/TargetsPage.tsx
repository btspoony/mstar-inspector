/**
 * The review-target surface (`/dashboard/<ref>/targets`): the list of the
 * workspace's targets, and at `…/targets/:appId` the target-owned review
 * policy that used to be the App detail's settings tab. Both faces read the
 * existing app-addressed endpoints (`GET /api/apps`,
 * `GET /api/apps/:appId/settings`), so the surface adds no data face — the
 * detail address is the numeric `github_app_id` the APIs already take.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import type { SpaBoot } from "../boot";
import { spaClick } from "../spa-click";
import { apiBase } from "../workspace-base";
import { AppsList, loadApps } from "./AppsPage";
import { loadAppDetail, TargetHeader } from "./AppDetailPage";
import { PageNotice, type NoticeKind } from "./PageNotice";
import { SettingsView } from "./SettingsPage";
import type { AppsPayload, SettingsPayload } from "./data";

/**
 * The page wayfinding link back to the list, derived from the page's own API
 * base so the rendered href is the real target under any workspace ref. A
 * separate component from the stateful page so the error and ok faces share
 * one exit.
 */
export function TargetDetailShell({
  locale,
  children,
}: {
  locale: SpaBoot["locale"];
  children: ReactNode;
}) {
  const href = `${apiBase()}/targets`;
  return (
    <div className="flex flex-col gap-6">
      <a
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
        href={href}
        onClick={(event) => spaClick(href, event)}
      >
        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
        {t(locale, "targets.backToList")}
      </a>
      {children}
    </div>
  );
}

/**
 * The loaded face of the list, split out of the stateful page so the rendered
 * markup — the empty state included — is assertable without a DOM runner (the
 * AppsView precedent).
 */
export function TargetsView({
  locale,
  state,
  payload,
  onRetry,
}: {
  locale: SpaBoot["locale"];
  state: "ok" | "error";
  payload: AppsPayload | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(locale, "targets.heading")} />
      {state === "error" ? <ErrorState locale={locale} onRetry={onRetry} /> : null}
      {state === "ok" && payload ? (
        payload.apps.length === 0 ? (
          // The description names the two creation paths (a workspace's own
          // App, and the shared bot when the plan grants it), so it names
          // neither as the default and offers no dead row.
          <EmptyState
            title={t(locale, "targets.emptyTitle")}
            description={t(locale, "targets.emptyDescription")}
          />
        ) : (
          <AppsList locale={locale} payload={payload} detailSegment="targets" />
        )
      ) : null}
    </div>
  );
}

export function TargetsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  // Read per render (the AppsPage precedent): the switcher navigates with
  // pushState + popstate, so the page base must track the URL it is on.
  const base = apiBase();
  const [payload, setPayload] = useState<AppsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  const load = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const parsed = await loadApps(base);
      if (!parsed) {
        setState("error");
        return;
      }
      setPayload(parsed);
      setState("ok");
    } catch {
      setState("error");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }
  return (
    <TargetsView
      locale={locale}
      state={state}
      payload={payload}
      onRetry={() => void load()}
    />
  );
}

export function TargetDetailPage({ boot, appId }: { boot: SpaBoot; appId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);

  // Background reloads (op-triggered refreshes) keep the loaded card tree
  // mounted — an unmount would destroy every typed input and open dialog.
  // A failed background refresh rides the page notice; the first load owns
  // the page-level error face.
  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      if (!background) setState("loading");
      try {
        const loaded = await loadAppDetail(base, appId);
        if (cancelledRef.current) return false;
        if (!loaded) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        setPayload(loaded);
        setState("ok");
        setNotice(null);
        return true;
      } catch {
        if (!cancelledRef.current) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
        }
        return false;
      }
    },
    [base, appId, locale],
  );

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  if (state === "loading") {
    return (
      <TargetDetailShell locale={locale}>
        <PageSkeleton locale={locale} kind="forms" />
      </TargetDetailShell>
    );
  }

  return (
    <TargetDetailShell locale={locale}>
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <div className="flex flex-col gap-6">
          <TargetHeader locale={locale} appId={appId} payload={payload} />
          {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
          <SettingsView locale={locale} payload={payload} onReload={load} />
        </div>
      ) : null}
    </TargetDetailShell>
  );
}
