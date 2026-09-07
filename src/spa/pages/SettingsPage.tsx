import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { isDictionaryKey, t, type DictionaryKey } from "../../i18n";
import { APP_VERSION } from "../../version";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProviderCombobox } from "../components/provider-combobox";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { deliveryOutcomeLabel } from "../delivery-outcome";
import { formatRelativeTime } from "../relative-time";
import { spaClick } from "../spa-click";
import {
  activeChainTabId,
  DEFAULT_CHAIN_NAME,
  isPaused,
  modelChainTabs,
  parseModels,
  parseSettings,
  providerFormKind,
  seatRoleValues,
  seatSelectValue,
  selectedCatalogProvider,
  splitModelChain,
  type CatalogProvider,
  type ChainTab,
  type ConfiguredProvider,
  type ModelOptionGroup,
  type SettingsAppMeta,
  type SettingsManagePayload,
  type SettingsPayload,
} from "./data";
import { StatusBadge } from "./AppsPage";
import { GitHubMark } from "./LoginPage";
import { LoadFailedNotice, LoadingNotice, PageNotice, type NoticeKind } from "./PageNotice";

type PendingAction =
  | { kind: "pause" | "resume" | "disable" | "enable" | "delete" }
  | { kind: "remove-chain"; name: string }
  | { kind: "remove-key"; provider: string }
  | { kind: "remove-custom"; providerId: string };

/**
 * Plan 44 T3: one op's outcome, resolved back to the card (or form cluster)
 * that produced it. Op feedback never rides the page-level notice channel —
 * that stays reserved for background-reload failures (plan 38). `warn` never
 * applies to op outcomes, so the kind narrows to success/error.
 */
type OpNotice = { kind: "success" | "error"; message: string };

/**
 * A card's inline op-feedback region (plan 44 T3): the page banner's markup,
 * roles (alert/status) and notice tokens rendered INSIDE the card next to the
 * actions that produced the outcome. Regions are per action cluster, so the
 * feedback sits where the user is looking. Plan 45 T6: a cluster's region may
 * also sit inside the card's row list — the providers remove outcome renders
 * at the removed row's position. Clear rule (pinned): a region's content is
 * replaced wholesale by the next op targeting that same region — no manual
 * clears, no cross-card resets.
 */
function NoticeRegion({ notice }: { notice: OpNotice | null }) {
  if (!notice) return null;
  return <PageNotice kind={notice.kind} message={notice.message} />;
}

export function SettingsPage({ boot, slug }: { boot: SpaBoot; slug: string }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);

  // Background reloads (op-triggered refreshes) keep the loaded card tree
  // mounted: they must not flip state back to "loading" — that unmount would
  // destroy Add Provider's open/selection state and every form's typed input
  // (plan 38 QC fix wave 1, F-001). A failed background refresh surfaces the
  // error through the notice channel instead of the page-level error state.
  // Resolves whether a fresh payload landed, so callers can tell a completed
  // refresh from a failed one (the draft create must not close on failure).
  async function load({ background = false }: { background?: boolean } = {}): Promise<boolean> {
    if (!background) setState("loading");
    try {
      const settingsRaw = await fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/settings`);
      if (cancelledRef.current) return false;
      const parsed = parseSettings(settingsRaw);
      if (!parsed) {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
        return false;
      }
      let nextGroups: ModelOptionGroup[] = [];
      if (parsed.can_manage) {
        try {
          const modelsRaw = await fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/models`);
          nextGroups = parseModels(modelsRaw)?.groups ?? [];
        } catch {
          nextGroups = [];
        }
      }
      if (cancelledRef.current) return false;
      setPayload(parsed);
      setGroups(nextGroups);
      setState("ok");
      // A healthy page has no page-level failure: any successful load —
      // foreground or background — clears the banner a failed background
      // reload left behind (plan 44 bugbot fix).
      setNotice(null);
      return true;
    } catch {
      if (!cancelledRef.current) {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
      }
      return false;
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="flex flex-col gap-6">
      {/* Wayfinding (plan 40 T2): the App settings page reads as one workflow
          with the Apps list — a visible path back to the list it came from. */}
      <div className="flex flex-col gap-1">
        <a
          className="text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
          href="/dashboard/apps"
          onClick={(event) => spaClick("/dashboard/apps", event)}
        >
          {t(locale, "settings.backToApps")}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "settings.title")}</h1>
      </div>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {state === "ok" && payload ? (
        <SettingsView locale={locale} payload={payload} groups={groups} onReload={load} />
      ) : null}
      {/* Version footer (plan 51): the deployment's current release from the
          generated src/version.ts surface — the same `vX.Y.Z` form as the
          /healthz field and release tags, so dashboard, health endpoint and
          tag reconcile by eye. Static build-time value: it renders in every
          page state, independent of the settings payload. */}
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.footer.version", { version: `v${APP_VERSION}` })}
      </p>
    </div>
  );
}

function verifyReasonMessage(locale: SpaBoot["locale"], reason: string): string {
  if (reason === "invalid_key") return t(locale, "settings.verify.invalid_key");
  if (reason === "unreachable") return t(locale, "settings.verify.unreachable");
  if (reason === "unsupported_provider") return t(locale, "settings.verify.unsupported_provider");
  return t(locale, "settings.verify.unexpected");
}

function settingsErrorMessage(locale: SpaBoot["locale"], body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      key?: unknown;
      params?: unknown;
      code?: unknown;
      message?: unknown;
      selector?: unknown;
    };
    // Plan 45 T4: mapped 400s carry a machine-readable key plus the
    // interpolation params — resolve it in the operator's locale. An unknown
    // key (newer server, stale client) falls through to the English face
    // below — fail-visible, never blank.
    if (typeof parsed.key === "string" && isDictionaryKey(parsed.key)) {
      const params =
        typeof parsed.params === "object" && parsed.params !== null
          ? (parsed.params as Record<string, string | number>)
          : undefined;
      return t(locale, parsed.key, params);
    }
    if (parsed.code === "not_in_verified_models" && typeof parsed.selector === "string") {
      return t(locale, "settings.membership.not_in_verified_models", { selector: parsed.selector });
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    /* plaintext 400 */
  }
  return body.trim() || t(locale, "common.loadFailed");
}

function SettingsView({
  locale,
  payload,
  groups,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  groups: ModelOptionGroup[];
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const { app } = payload;
  const base = `/dashboard/apps/${app.slug}/settings`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  // Plan 44 T3: dialog-confirmed ops report into the card that owns the
  // action (one notice state per card region). Form-submit outcomes render
  // through their own form-local regions instead and never pass through here.
  // Plan 45 T6: the providers card's state keeps only the add-flow (verify /
  // template) outcomes — the dialog-confirmed removes moved to the row-local
  // outcome below.
  const [opsNotice, setOpsNotice] = useState<OpNotice | null>(null);
  const [providersNotice, setProvidersNotice] = useState<OpNotice | null>(null);
  const [chainsNotice, setChainsNotice] = useState<OpNotice | null>(null);
  // Plan 45 T6 (audit UI-45-05): remove-key / remove-custom outcome plus the
  // removed row's position. The slot is captured from the pre-POST payload in
  // onConfirm — the awaited background reload (plan 38) drops the row from
  // the payload before the outcome resolves, so the position must be
  // remembered for the card to render the feedback where the row was.
  const [providersRemoveOutcome, setProvidersRemoveOutcome] = useState<{
    notice: OpNotice;
    slot: number;
  } | null>(null);

  /**
   * Resolve the op's outcome to the caller (plan 44 T3): the card/cluster that
   * submitted the fields renders it in its own region. A network-level POST
   * failure (postForm throws before an outcome exists) resolves the
   * save-failed copy (plan 45 T3: a failed save must not claim the page
   * couldn't load) so no op stays silent; a redirect hop navigates away
   * before this resolves. The outcome also carries `reloaded` — whether the
   * awaited background refresh actually landed — which only the draft create
   * reads (POST success alone is not completion there); every other caller
   * renders the plain OpNotice and ignores it.
   */
  async function submitSettings(fields: Record<string, string>): Promise<OpNotice & { reloaded: boolean }> {
    let status: number;
    let body: string;
    // The catch guards only the POST — a background reload never rejects:
    // load() catches its own failures into the page notice (plan 38).
    try {
      ({ status, body } = await postForm(base, fields));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed"), reloaded: false };
    }
    const outcome: OpNotice =
      status >= 400
        ? { kind: "error", message: settingsErrorMessage(locale, body) }
        : { kind: "success", message: t(locale, "settings.changesSaved") };
    const reloaded = await onReload({ background: true });
    return { ...outcome, reloaded };
  }

  /**
   * The draft create's completion check (plan 44 bugbot fix): POST success
   * alone is not done — the chain is only usable once the awaited background
   * reload lands it in the payload. A successful POST whose reload failed
   * resolves the load-failed error instead of success, so the draft panel
   * stays open with the typed content. Retry is safe: op=add-chain is
   * create-or-update-in-place, so re-saving the same name converges.
   */
  async function createDraftChain(fields: Record<string, string>): Promise<OpNotice> {
    const outcome = await submitSettings(fields);
    if (outcome.kind === "success" && !outcome.reloaded) {
      return { kind: "error", message: t(locale, "common.loadFailed") };
    }
    return outcome;
  }

  // Plan 38: resolves whether the key was verified AND stored. The refresh
  // after the POST is a background reload (the card tree stays mounted), so a
  // failed verify keeps the add panel open with the typed key for correction
  // while the provider stays unconfigured; only success resets/closes the
  // form via onDone. The structured reason rides the providers card's region.
  async function submitVerify(fields: Record<string, string>): Promise<OpNotice> {
    let status: number;
    let body: string;
    // The catch guards only the verify POST — a background reload never
    // rejects: load() catches its own failures into the page notice (plan 38).
    try {
      ({ status, body } = await postForm(
        `/dashboard/api/apps/${encodeURIComponent(app.slug)}/keys/verify`,
        fields,
      ));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed") };
    }
    if (status >= 400) {
      let reason = "unexpected";
      // Plan 45 T4 (CARRY-2): the eligibility rejection additionally carries
      // the keyed face — prefer the mapped key so the runtime-image cause
      // renders in the operator's locale; reason-only 400s keep the
      // existing verify copy.
      let keyed: DictionaryKey | undefined;
      let keyedParams: Record<string, string | number> | undefined;
      try {
        const parsed = JSON.parse(body) as { reason?: string; key?: unknown; params?: unknown };
        if (typeof parsed.reason === "string") reason = parsed.reason;
        if (typeof parsed.key === "string" && isDictionaryKey(parsed.key)) {
          keyed = parsed.key;
          if (typeof parsed.params === "object" && parsed.params !== null) {
            keyedParams = parsed.params as Record<string, string | number>;
          }
        }
      } catch {
        /* body is not JSON */
      }
      const outcome: OpNotice = {
        kind: "error",
        message: keyed !== undefined ? t(locale, keyed, keyedParams) : verifyReasonMessage(locale, reason),
      };
      await onReload({ background: true });
      return outcome;
    }
    const outcome: OpNotice = { kind: "success", message: t(locale, "settings.keyVerified") };
    await onReload({ background: true });
    return outcome;
  }

  async function runPinned(path: string): Promise<OpNotice> {
    return runPinnedWithBody(path, {});
  }

  /**
   * POST a pinned ops path and resolve the outcome to the calling card.
   * Options: `successMessage` differentiates an outcome the generic
   * "Changes saved." would misrepresent; `reload: false` skips the background
   * refetch when the follow-up settings GET is guaranteed to fail — a
   * soft-deleted App is invisible to that route, so a delete's refetch would
   * 404 and overwrite the outcome with "Load failed."
   */
  async function runPinnedWithBody(
    path: string,
    fields: Record<string, string>,
    { successMessage, reload = true }: { successMessage?: string; reload?: boolean } = {},
  ): Promise<OpNotice> {
    let status: number;
    let body: string;
    // The catch guards only the POST — a background reload never rejects:
    // load() catches its own failures into the page notice (plan 38).
    try {
      ({ status, body } = await postForm(path, fields));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed") };
    }
    const outcome: OpNotice =
      status >= 400
        ? // Plan 45 T4: the pinned path resolves through the same resolver as
          // the settings POST family — keyed JSON renders localized; raw
          // text still displays (fail-visible, never blank).
          { kind: "error", message: settingsErrorMessage(locale, body) }
        : { kind: "success", message: successMessage ?? t(locale, "settings.changesSaved") };
    if (reload) await onReload({ background: true });
    return outcome;
  }

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    // The remove actions originate solely from the manage face's
    // ProvidersCard; the read-only face can never reach a confirm, so the
    // empty fallback here is unreachable in practice.
    const configured = payload.can_manage ? payload.configured_providers : [];
    setBusy(true);
    try {
      if (action.kind === "remove-chain") {
        setChainsNotice(await submitSettings({ op: "remove-chain", name: action.name }));
      } else if (action.kind === "remove-custom") {
        // Plan 45 T6 (audit UI-45-05): the remove outcome renders row-locally,
        // so it carries the row's position — captured from the pre-POST
        // payload, because the awaited background reload (plan 38) drops the
        // row before the outcome resolves. A dialog-confirmed row is always
        // found; the length fallback keeps the outcome visible at the list's
        // end instead of dropping it.
        const slot = configured.findIndex((row) => row.kind === "custom" && row.provider_id === action.providerId);
        setProvidersRemoveOutcome({
          notice: await submitSettings({ op: "remove-custom-provider", provider_id: action.providerId }),
          slot: slot >= 0 ? slot : configured.length,
        });
      } else if (action.kind === "remove-key") {
        // Same position capture as remove-custom (see above).
        const slot = configured.findIndex((row) => row.kind === "key" && row.provider === action.provider);
        setProvidersRemoveOutcome({
          notice: await runPinnedWithBody(`/dashboard/apps/${app.slug}/settings/key/delete`, {
            provider: action.provider,
          }),
          slot: slot >= 0 ? slot : configured.length,
        });
      } else if (action.kind === "delete") {
        // Irreversible outcome with its own copy: "Changes saved." reads wrong
        // after a delete, and the user stays on the deleted App's page.
        // reload: false — the deleted App's settings GET is a guaranteed 404.
        setOpsNotice(
          await runPinnedWithBody(
            `/dashboard/apps/${app.slug}/delete`,
            {},
            { successMessage: t(locale, "settings.deleteSuccess"), reload: false },
          ),
        );
      } else {
        setOpsNotice(await runPinned(`/dashboard/apps/${app.slug}/${action.kind}`));
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, app.slug, pending);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{app.slug}</h2>
        <StatusBadge locale={locale} status={app.status} reviewEnabled={app.review_enabled} />
        <span className="text-sm text-muted-foreground">{t(locale, "apps.by", { login: app.created_by })}</span>
      </div>

      {/* Plan 53 A5: the GitHub identity card sits between the slug row and
          the manage conditional, so BOTH faces (OpsCard managers and
          HealthCard members) see it (AC3). */}
      <AppInfoCard locale={locale} app={app} />

      {payload.can_manage ? (
        <OpsCard locale={locale} payload={payload} onPending={setPending} notice={opsNotice} />
      ) : (
        <HealthCard locale={locale} payload={payload} />
      )}

      <RuntimeImageCard locale={locale} payload={payload} onSettings={submitSettings} />

      {payload.can_manage ? (
        <>
          <ProvidersCard
            locale={locale}
            payload={payload}
            onVerify={submitVerify}
            onSettings={submitSettings}
            onPending={setPending}
            notice={providersNotice}
            removeOutcome={providersRemoveOutcome}
            onOutcome={setProvidersNotice}
          />
          <ChainsCard
            locale={locale}
            payload={payload}
            groups={groups}
            onSettings={submitSettings}
            onCreateDraft={createDraftChain}
            onRemoveChain={(name) => setPending({ kind: "remove-chain", name })}
            notice={chainsNotice}
            onOutcome={setChainsNotice}
          />
          <SeatsCard locale={locale} payload={payload} onSettings={submitSettings} />
        </>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent>
          {pending && confirmCopy ? (
            <>
              <DialogHeader>
                <DialogTitle>{confirmCopy.title}</DialogTitle>
                <DialogDescription>{confirmCopy.body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={busy}>
                    {t(locale, "common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  variant={confirmCopy.destructive ? "destructive" : "default"}
                  disabled={busy}
                  onClick={() => void onConfirm()}
                >
                  {confirmCopy.action}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function pendingConfirmCopy(
  locale: SpaBoot["locale"],
  slug: string,
  pending: PendingAction | null,
): { title: string; body: string; action: string; destructive: boolean } | null {
  if (!pending) return null;
  if (pending.kind === "remove-chain") {
    return {
      title: t(locale, "settings.confirmRemoveChainTitle", { name: pending.name }),
      body: t(locale, "settings.confirmRemoveChainBody", { name: pending.name }),
      action: t(locale, "settings.remove"),
      destructive: true,
    };
  }
  if (pending.kind === "remove-key") {
    return {
      title: t(locale, "settings.confirmRemoveKeyTitle", { provider: pending.provider }),
      body: t(locale, "settings.confirmRemoveKeyBody", { provider: pending.provider }),
      action: t(locale, "settings.remove"),
      destructive: true,
    };
  }
  if (pending.kind === "remove-custom") {
    return {
      title: t(locale, "settings.confirmRemoveCustomTitle", { provider: pending.providerId }),
      body: t(locale, "settings.confirmRemoveCustomBody", { provider: pending.providerId }),
      action: t(locale, "settings.remove"),
      destructive: true,
    };
  }
  const map = {
    pause: {
      title: t(locale, "settings.confirmPauseTitle", { slug }),
      body: t(locale, "settings.confirmPauseBody"),
      action: t(locale, "apps.actions.pause"),
      destructive: false,
    },
    resume: {
      title: t(locale, "settings.confirmResumeTitle", { slug }),
      body: t(locale, "settings.confirmResumeBody"),
      action: t(locale, "apps.actions.resume"),
      destructive: false,
    },
    disable: {
      title: t(locale, "settings.confirmDisableTitle", { slug }),
      body: t(locale, "settings.confirmDisableBody"),
      action: t(locale, "settings.confirmDisableAction"),
      destructive: true,
    },
    enable: {
      title: t(locale, "settings.confirmEnableTitle", { slug }),
      body: t(locale, "settings.confirmEnableBody"),
      action: t(locale, "apps.actions.enable"),
      destructive: false,
    },
    delete: {
      title: t(locale, "settings.confirmDeleteTitle", { slug }),
      body: t(locale, "settings.confirmDeleteBody"),
      action: t(locale, "settings.confirmDeleteButton"),
      destructive: true,
    },
  } as const;
  return map[pending.kind];
}

/**
 * Plan 53 A5: the GitHub identity card — avatar, hyperlinked name,
 * description, and the numeric App id, fed by the cached GitHub profile the
 * settings route serves (migration 0019 columns). Rendered outside the
 * can_manage conditional, so managers and members alike see it (AC3).
 * Degradation is strictly per-field (plan Global Constraints): a null field
 * simply does not render — a never-synced App shows the placeholder mark and
 * its local App id with no link, no error state, no layout collapse
 * (the fail-open UI face of the AD-531 read path).
 */
export function AppInfoCard({ locale, app }: { locale: SpaBoot["locale"]; app: SettingsAppMeta }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.appInfo")}</CardTitle>
        <CardDescription>{t(locale, "settings.appInfoCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-4">
          {app.github_avatar_url ? (
            <img
              src={app.github_avatar_url}
              alt=""
              className="h-12 w-12 shrink-0 rounded-full border object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
              <GitHubMark className="h-6 w-6" />
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            {app.github_name ? (
              app.github_html_url ? (
                <a
                  href={app.github_html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
                  aria-label={t(locale, "settings.appInfoViewOnGithub", { name: app.github_name })}
                >
                  {app.github_name}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </a>
              ) : (
                <span className="font-semibold">{app.github_name}</span>
              )
            ) : null}
            {app.github_description ? <p className="text-sm">{app.github_description}</p> : null}
            <p className="text-sm text-muted-foreground">
              {t(locale, "settings.appInfoAppId", { id: app.github_app_id })}
            </p>
            {app.github_metadata_synced_at ? (
              <p className="text-xs text-muted-foreground">
                {t(locale, "settings.appInfoSynced", {
                  time: formatRelativeTime(app.github_metadata_synced_at, locale),
                })}
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HealthBody({ locale, payload }: { locale: SpaBoot["locale"]; payload: SettingsPayload }) {
  const { app } = payload;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.lastWebhook", { time: formatRelativeTime(app.last_webhook_at, locale) })}
        {payload.delivery_summary && payload.delivery_summary.rejected24h > 0
          ? ` · ${t(locale, "apps.health.rejected24h", { count: payload.delivery_summary.rejected24h })}`
          : ""}
      </p>
      {payload.installations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {payload.installations.map((inst) => (
            <li key={inst.installation_id} className="text-sm">
              <span className="font-medium">{inst.account_login ?? t(locale, "common.time.unknown")}</span>
              <span className="text-muted-foreground">
                {" "}
                · {t(locale, "settings.installation", { id: inst.installation_id })} ·{" "}
                {t(locale, "settings.lastSeen", { time: formatRelativeTime(inst.seen_at, locale) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <h3 className="text-sm font-medium">{t(locale, "settings.recentDeliveries")}</h3>
        <p className="text-sm text-muted-foreground">{t(locale, "settings.recentDeliveriesCopy")}</p>
        {payload.deliveries.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t(locale, "settings.noDeliveries")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {payload.deliveries.map((delivery, index) => (
              <li key={`${delivery.created_at}-${index}`} className="text-sm">
                <span className="font-medium">{delivery.event_name ?? t(locale, "settings.unknownEvent")}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {formatRelativeTime(delivery.created_at, locale)} ·{" "}
                  {deliveryOutcomeLabel(delivery.outcome, locale)} ·{" "}
                  {t(locale, "settings.status", {
                    code: delivery.status_code === null ? "—" : String(delivery.status_code),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HealthCard({ locale, payload }: { locale: SpaBoot["locale"]; payload: SettingsPayload }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.installHealth")}</CardTitle>
        <CardDescription>{t(locale, "settings.installHealthCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        <HealthBody locale={locale} payload={payload} />
      </CardContent>
    </Card>
  );
}

/**
 * Runtime image (plan 37): the App's sandbox runtime-image selection.
 * Managers get the shadcn selector over the enabled registry entries (one
 * `omp` option this iteration) and save through op=save-sandbox-image;
 * other members get the read-only selected id. The payload carries registry
 * ids only — never image-local configuration or secrets.
 */
function RuntimeImageCard({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.runtimeImage")}</CardTitle>
        <CardDescription>{t(locale, "settings.runtimeImageCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        {payload.can_manage ? (
          <RuntimeImageEditor locale={locale} payload={payload} onSettings={onSettings} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.runtimeImageValue", { id: payload.app.sandbox_image_id })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeImageEditor({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const [selected, setSelected] = useState(payload.app.sandbox_image_id);
  // Plan 44 T3: the save outcome renders in this card, next to the trigger —
  // the busy guard keeps the save button disabled while its POST is in flight.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelected(payload.app.sandbox_image_id);
  }, [payload.app.sandbox_image_id]);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      setNotice(await onSettings({ op: "save-sandbox-image", sandbox_image_id: selected }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Plan 55 A1: content-adaptive shell — no reserved min width, so the
            trigger sits immediately next to the save button; flex-wrap keeps
            the button wrapping below cleanly on narrow screens. */}
        <div className="w-fit max-w-xs">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger aria-label={t(locale, "settings.runtimeImage")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {payload.sandbox_images.map((image) => (
                <SelectItem key={image.id} value={image.id}>
                  {image.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {t(locale, "settings.saveRuntimeImage")}
        </Button>
      </div>
      <NoticeRegion notice={notice} />
    </div>
  );
}

function OpsCard({
  locale,
  payload,
  onPending,
  notice,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  onPending: (action: PendingAction) => void;
  /** Plan 44 T3: the confirmed ops outcome (pause/resume/disable/enable/delete — delete carries its own copy). */
  notice: OpNotice | null;
}) {
  const { app } = payload;
  const paused = isPaused(app);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.ops")}</CardTitle>
        <CardDescription>{t(locale, "settings.opsCopy")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {app.status === "active" ? (
              paused ? (
                <Button type="button" onClick={() => onPending({ kind: "resume" })}>
                  {t(locale, "settings.resumeReviews")}
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => onPending({ kind: "pause" })}>
                  {t(locale, "settings.pauseReviews")}
                </Button>
              )
            ) : (
              <p className="text-sm text-muted-foreground">{t(locale, "settings.disconnected")}</p>
            )}
            {app.status === "active" ? (
              <Button type="button" variant="destructive-outline" onClick={() => onPending({ kind: "disable" })}>
                {t(locale, "apps.actions.disable")}
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={() => onPending({ kind: "enable" })}>
                {t(locale, "apps.actions.enable")}
              </Button>
            )}
            <Button type="button" variant="destructive" onClick={() => onPending({ kind: "delete" })}>
              {t(locale, "apps.actions.delete")}
            </Button>
          </div>
          <NoticeRegion notice={notice} />
        </div>
        <HealthBody locale={locale} payload={payload} />
      </CardContent>
    </Card>
  );
}

/**
 * Providers (plan 38): this card lists ONLY the App's configured providers —
 * a stored key (masked tail) or a saved custom-provider declaration. Catalog
 * entries are discovery metadata and appear solely inside the Add Provider
 * picker, whose selection determines the configuration form; the non-catalog
 * custom declaration path (CustomExpand) stays for ids outside the catalog.
 *
 * Plan 42: the Add Provider entry is a labeled, bordered button in the card
 * header (CardAction slot) — the catalog breadth made discoverability the
 * point, so the flow opens from a control that reads as a control. The open
 * panel is the card content's first row.
 */
function ProvidersCard({
  locale,
  payload,
  onVerify,
  onSettings,
  onPending,
  notice,
  removeOutcome,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onPending: (action: PendingAction) => void;
  /** Plan 44 T3 / 45 T6: the add-flow (verify / template) outcomes — removes render row-local (below). */
  notice: OpNotice | null;
  /** Plan 45 T6 (audit UI-45-05): the remove-key / remove-custom outcome, rendered at the removed row's position. */
  removeOutcome: { notice: OpNotice; slot: number } | null;
  /** Plan 44 T3: where the add-flow forms (verify / template) report their outcome. */
  onOutcome: (notice: OpNotice) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const catalogById: Record<string, CatalogProvider> = {};
  for (const provider of payload.provider_catalog) catalogById[provider.id] = provider;
  // Plan 45 T6 (audit UI-45-05): where the remove outcome renders inside the
  // rows list. Success takes the row's former slot — the awaited reload has
  // already dropped the row; a failure leaves the row in place, so the
  // region renders directly below it (the field-error position). Clamped so
  // a removed last row lands at the list's end, never out of bounds.
  const removeSlot =
    removeOutcome === null
      ? -1
      : Math.min(
          removeOutcome.notice.kind === "error" ? removeOutcome.slot + 1 : removeOutcome.slot,
          payload.configured_providers.length,
        );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.providers")}</CardTitle>
        <CardDescription>{t(locale, "settings.providersCopy")}</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)}>
            <Plus aria-hidden="true" />
            {t(locale, "settings.addProvider")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AddProviderSection
          locale={locale}
          payload={payload}
          onVerify={onVerify}
          onSettings={onSettings}
          onOutcome={onOutcome}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
        {/* The card's region sits directly under the add panel: verify /
            template outcomes stay next to their submit button while the panel
            is open, and survive its success-close (unlike panel-local state).
            Plan 45 T6: the dialog-confirmed removes render row-locally below
            instead — this region keeps only the add-flow outcomes. */}
        <NoticeRegion notice={notice} />
        {payload.configured_providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noConfiguredProviders")}</p>
        ) : (
          payload.configured_providers.map((row, index) => (
            <Fragment key={row.kind === "key" ? row.provider : row.provider_id}>
              {/* Plan 45 T6 (audit UI-45-05): the remove outcome renders in
                  the removed row's position — at catalog scale the feedback
                  is visible without scrolling away from the Remove control
                  that produced it. The shared NoticeRegion inherits the
                  plan-44 roles (alert/status) and notice tokens. */}
              {index === removeSlot && removeOutcome ? <NoticeRegion notice={removeOutcome.notice} /> : null}
              {row.kind === "key" ? (
                <ConfiguredKeyRow
                  locale={locale}
                  row={row}
                  label={catalogById[row.provider]?.label ?? row.provider}
                  onPending={onPending}
                />
              ) : (
                <ConfiguredCustomRow
                  locale={locale}
                  row={row}
                  label={catalogById[row.provider_id]?.label ?? row.provider_id}
                  onPending={onPending}
                />
              )}
            </Fragment>
          ))
        )}
        {/* Trailing clamp: a removed last row's slot equals the list length. */}
        {removeOutcome && removeSlot >= payload.configured_providers.length ? (
          <NoticeRegion notice={removeOutcome.notice} />
        ) : null}
        <CustomExpand
          locale={locale}
          payload={payload}
          expanded={customOpen}
          onToggle={() => setCustomOpen(!customOpen)}
          onSettings={onSettings}
        />
      </CardContent>
    </Card>
  );
}

function ConfiguredKeyRow({
  locale,
  row,
  label,
  onPending,
}: {
  locale: SpaBoot["locale"];
  row: Extract<ConfiguredProvider, { kind: "key" }>;
  label: string;
  onPending: (action: PendingAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {row.provider} ·{" "}
          {row.last4 ? t(locale, "settings.keyEnding", { last4: row.last4 }) : t(locale, "settings.keyTooShort")}
          {row.updated_at
            ? ` · ${t(locale, "settings.updated", { time: formatRelativeTime(row.updated_at, locale) })}`
            : ""}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => onPending({ kind: "remove-key", provider: row.provider })}
      >
        {t(locale, "settings.remove")}
      </Button>
    </div>
  );
}

function ConfiguredCustomRow({
  locale,
  row,
  label,
  onPending,
}: {
  locale: SpaBoot["locale"];
  row: Extract<ConfiguredProvider, { kind: "custom" }>;
  label: string;
  onPending: (action: PendingAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-sm text-muted-foreground">
          {row.provider_id} · {row.base_url} · {row.api} · {row.model_ids.join(", ")}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => onPending({ kind: "remove-custom", providerId: row.provider_id })}
      >
        {t(locale, "settings.remove")}
      </Button>
    </div>
  );
}

/**
 * Add Provider (plan 38): the open panel beneath the card header's labeled
 * disclosure button (plan 42 moved the button to the CardAction slot; the
 * panel renders as the content's first row). The selected entry's id
 * determines the configuration form rendered beneath the picker. Catalog
 * provenance (the committed models.dev snapshot, static code) and per-entry
 * runtime eligibility (builtin / template / unavailable vs the App's selected
 * image) are disclosed in copy; an unavailable entry renders its explanation
 * with no submit path. Plan 54: the picker is the filterable combobox
 * (provider-combobox.tsx) showing the common tier first, then the catalog
 * tier (display-only grouping inside the combobox: the form below keeps
 * branching on tier/eligibility, AD-547) — with the list height-capped to an
 * internal scroll so the snapshot breadth stays usable. Only a successful
 * submit closes the flow — a failed verify/add keeps the selection and typed
 * input while the provider stays unconfigured.
 */
function AddProviderSection({
  locale,
  payload,
  onVerify,
  onSettings,
  onOutcome,
  open,
  onOpenChange,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = selectedCatalogProvider(payload.provider_catalog, selectedId);
  const imageId = payload.app.sandbox_image_id;
  const keyByProvider: Record<string, SettingsManagePayload["keys"][number]> = {};
  for (const key of payload.keys) keyByProvider[key.provider] = key;
  const customById: Record<string, SettingsManagePayload["custom_providers"][number]> = {};
  for (const row of payload.custom_providers) customById[row.provider_id] = row;

  if (!open) return null;
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">{t(locale, "settings.addProviderCopy")}</p>
      <p className="text-xs text-muted-foreground">
        {t(locale, "settings.catalogProvenance", { count: payload.provider_catalog.length })}
      </p>
      <div className="flex max-w-xs flex-col gap-1.5">
        <span className="text-sm font-medium" id="settings-catalog-provider-label">
          {t(locale, "settings.provider")}
        </span>
        <ProviderCombobox
          locale={locale}
          labelledby="settings-catalog-provider-label"
          providers={payload.provider_catalog}
          value={selectedId}
          onValueChange={setSelectedId}
          imageId={imageId}
        />
      </div>
      {selected ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-medium">
            {t(locale, "settings.configureProvider", { label: selected.label })}
          </h4>
          {selected.eligibility === "unavailable" ? (
            // Runtime-ineligible rows stay selectable for discovery but get
            // an explanation instead of a form — no submit path, so an
            // unusable provider can never be saved silently (plan 38 T3).
            <p className="text-sm text-muted-foreground">
              {t(locale, "settings.eligibilityUnavailable", { image: imageId })}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {selected.eligibility === "template"
                  ? t(locale, "settings.eligibilityTemplate", { image: imageId })
                  : t(locale, "settings.eligibilityBuiltin", { image: imageId })}
              </p>
              <ProviderConfigForm
                key={selected.id}
                locale={locale}
                provider={selected}
                storedKey={keyByProvider[selected.id]}
                custom={customById[selected.id]}
                onVerify={onVerify}
                onSettings={onSettings}
                onOutcome={onOutcome}
                onDone={() => {
                  setSelectedId(undefined);
                  onOpenChange(false);
                }}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The selected catalog entry's configuration requirements (plan 38): template
 * entries materialize through op=add-template-provider, verifiable builtins
 * use the verify-first /keys/verify path, and console-only providers have no
 * in-app form. Every form clears and closes only on success — a rejected
 * submit surfaces the structured error and keeps the typed input.
 *
 * Plan 42: the template form carries the base URL explicitly — prefilled from
 * the catalog entry, editable as an override (required only when the entry's
 * catalog base URL is null) — and the account-id field appears only when the
 * effective base URL carries the {account_id} placeholder, mirroring the
 * save flow's conditional demand (breadth rows are not all Workers-AI-shaped).
 */
function ProviderConfigForm({
  locale,
  provider,
  storedKey,
  custom,
  onVerify,
  onSettings,
  onOutcome,
  onDone,
}: {
  locale: SpaBoot["locale"];
  provider: CatalogProvider;
  storedKey: SettingsManagePayload["keys"][number] | undefined;
  custom: SettingsManagePayload["custom_providers"][number] | undefined;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [busy, setBusy] = useState(false);
  const formKind = providerFormKind(provider);

  // Plan 44 T3: both add-flow forms report through the providers card's
  // region (directly beneath this panel), so the outcome survives the
  // success-close; a rejected submit keeps the typed input for correction.
  async function submitTemplate(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onSettings({
        op: "add-template-provider",
        template_id: provider.id,
        base_url: baseUrl,
        account_id: accountId,
        key,
      });
      onOutcome(outcome);
      if (outcome.kind === "success") {
        setKey("");
        setAccountId("");
        setBaseUrl("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitKey(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onVerify({ provider: provider.id, key });
      onOutcome(outcome);
      if (outcome.kind === "success") {
        setKey("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  if (formKind === "template") {
    // The effective base URL mirrors the save flow: the typed override when
    // present, else the catalog prefill. The account-id field tracks its
    // {account_id} placeholder, so an override can add or remove the demand.
    const effectiveBaseUrl = baseUrl.trim() !== "" ? baseUrl.trim() : provider.base_url;
    const needsAccountId = effectiveBaseUrl !== null && effectiveBaseUrl.includes("{account_id}");
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTemplate();
        }}
      >
        {custom ? (
          <p className="text-sm text-muted-foreground">
            {custom.base_url} · {custom.api} · {custom.model_ids.join(", ")}
          </p>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t(locale, "settings.baseUrl")}
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            required={provider.base_url === null}
          />
        </label>
        {needsAccountId ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.accountId")}
            <Input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder={t(locale, "settings.accountIdPlaceholder")}
              autoComplete="off"
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t(locale, "settings.apiKey")}
          <Input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="new-password"
            placeholder={t(locale, "settings.apiKeyPlaceholder")}
          />
        </label>
        <Button type="submit" disabled={busy}>{t(locale, "settings.addTemplate", { label: provider.label })}</Button>
      </form>
    );
  }

  if (formKind === "console") {
    return <p className="text-sm text-muted-foreground">{t(locale, "settings.consoleOnly")}</p>;
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submitKey();
      }}
    >
      {storedKey ? (
        <p className="text-sm text-muted-foreground">
          {t(locale, "settings.keyEnding", { last4: storedKey.last4 })}
        </p>
      ) : null}
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t(locale, "settings.apiKey")}
        <Input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="new-password"
          placeholder={t(locale, "settings.apiKeyPlaceholder")}
        />
      </label>
      <Button type="submit" disabled={busy}>{t(locale, "settings.addKey")}</Button>
    </form>
  );
}

function CustomExpand({
  locale,
  payload,
  expanded,
  onToggle,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  expanded: boolean;
  onToggle: () => void;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState(payload.custom_provider_api_ids[0] ?? "");
  const [modelIds, setModelIds] = useState("");
  const [key, setKey] = useState("");
  // Plan 44 T3: the custom declaration's outcome renders inside its own form
  // (this container stays mounted, unlike the add panel) — the card's region
  // above the configured rows is too far from this form's submit button.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onSettings({
        op: "add-custom-provider",
        provider_id: providerId,
        base_url: baseUrl,
        api,
        model_ids: modelIds,
        key,
      });
      setNotice(outcome);
      // QC wave (seat3): a rejected save keeps the typed input for
      // correction — only a successful save clears the form.
      if (outcome.kind === "success") {
        setProviderId("");
        setBaseUrl("");
        setModelIds("");
        setKey("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-3">
      <button type="button" className="flex w-full flex-col items-start text-left" onClick={onToggle} aria-expanded={expanded}>
        <span className="font-medium">{t(locale, "settings.customEntry")}</span>
        <span className="text-xs text-muted-foreground">{t(locale, "settings.customEntryCopy")}</span>
      </button>
      {expanded ? (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.providerId")}
            <Input value={providerId} onChange={(event) => setProviderId(event.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.baseUrl")}
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.api")}
            <Select value={api} onValueChange={setApi}>
              <SelectTrigger>
                <SelectValue placeholder={t(locale, "settings.selectApi")} />
              </SelectTrigger>
              <SelectContent>
                {payload.custom_provider_api_ids.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.modelIds")}
            <Input value={modelIds} onChange={(event) => setModelIds(event.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.apiKey")}
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="new-password"
              placeholder={t(locale, "settings.apiKeyPlaceholder")}
            />
          </label>
          <Button type="submit" disabled={busy}>{t(locale, "settings.addCustomProvider")}</Button>
          <NoticeRegion notice={notice} />
        </form>
      ) : null}
    </div>
  );
}

/**
 * The draft tab's client-side id (plan 44 T2). A colon can never appear in a
 * stored chain name (MODEL_CHAIN_NAME_PATTERN allows only lowercase letters,
 * digits and hyphens), so the sentinel is collision-free with real tab ids.
 * It never reaches the server — the draft saves under the ENTERED name
 * through op=add-chain.
 */
const DRAFT_CHAIN_TAB_ID = ":draft";

const DRAFT_CHAIN_TAB: ChainTab = { id: DRAFT_CHAIN_TAB_ID, isDefault: false, chain: null };

/**
 * Plan 55 (AD-551): the draft tab's label mirrors the lifted draft name live
 * — a non-blank input shows as-is (trim only gates the fallback), an
 * empty/whitespace name falls back to the static 新链 copy. Pure render: the
 * Radix Tabs controlled value derives from tabs/selectedTab alone, so a
 * label change never touches tab selection.
 */
export function draftChainTabLabel(draftName: string, locale: SpaBoot["locale"]): string {
  return draftName.trim() ? draftName : t(locale, "settings.draftChain");
}

function ChainsCard({
  locale,
  payload,
  groups,
  onSettings,
  onCreateDraft,
  onRemoveChain,
  notice,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  groups: ModelOptionGroup[];
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  /** Plan 44 bugbot fix: the draft create — resolves an error when the awaited reload fails, so the panel keeps the draft open. */
  onCreateDraft: (fields: Record<string, string>) => Promise<OpNotice>;
  onRemoveChain: (name: string) => void;
  /** Plan 44 T3: the dialog-confirmed remove-chain outcome. */
  notice: OpNotice | null;
  /** Plan 44 T3: where the draft panel reports its success (the draft closes, so its panel cannot render it). */
  onOutcome: (notice: OpNotice) => void;
}) {
  // Plan 39: Default and named chains are peer tabs. The selection coerces
  // through activeChainTabId so a delete or a stale payload lands on the
  // non-removable Default tab instead of pointing at a removed chain.
  const [selectedTab, setSelectedTab] = useState<string>(DEFAULT_CHAIN_NAME);
  // Plan 44 T2: `+ 新建链` opens a DRAFT peer tab instead of a disclosure —
  // the create flow is itself a tab, edited in place like every other chain.
  // One boolean of state, so a second draft can never exist while one lives.
  const [draftOpen, setDraftOpen] = useState(false);
  // Plan 55 (AD-551): the draft name is owned HERE so the tab trigger can
  // mirror the name input live; the panel is controlled (name/onNameChange).
  // Lifting it retires the panel's unmount-clears-name reset — the two ways
  // a draft closes (discard + created) each reset it explicitly below.
  const [draftName, setDraftName] = useState("");
  const storedTabs = modelChainTabs(payload.model_chains);
  // The draft is a client-side UI element composed AFTER the last named tab
  // (never before Default) — the payload model itself is never mutated.
  // Composing it into `tabs` makes the draft selectable while it exists and
  // lets activeChainTabId coerce the selection once it is gone: a discard
  // lands on Default, and the post-save reload cannot resurrect the draft
  // (draft state is component state, never payload-derived).
  const draft = draftOpen ? DRAFT_CHAIN_TAB : null;
  const tabs = draft ? [...storedTabs, draft] : storedTabs;
  // Panels derive from the STORED tabs only — the draft panel renders
  // separately below, so the composed list must never leak into it.
  const namedTabs = storedTabs.filter((tab) => !tab.isDefault);

  // + 新建链: open (or re-focus) the draft and auto-select it — the editor
  // the click promises is the panel the user lands in.
  function openDraft(): void {
    setDraftOpen(true);
    setSelectedTab(DRAFT_CHAIN_TAB_ID);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.modelChains")}</CardTitle>
        <CardDescription>{t(locale, "settings.modelChainsCopy")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Tabs value={activeChainTabId(tabs, selectedTab)} onValueChange={setSelectedTab}>
          {/* The add-chain entry keeps its plan-43 strip placement: a TabsList
              SIBLING (never inside the role=tablist) — outline control, plus
              glyph, localized label. Plan 44: the click no longer toggles a
              disclosure form between strip and Default panel; it opens the
              draft peer tab. */}
          <div className="flex items-center gap-2">
            <TabsList aria-label={t(locale, "settings.modelChains")}>
              {storedTabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.isDefault ? t(locale, "settings.defaultChain") : tab.id}
                </TabsTrigger>
              ))}
              {draft ? (
                <TabsTrigger value={DRAFT_CHAIN_TAB_ID}>{draftChainTabLabel(draftName, locale)}</TabsTrigger>
              ) : null}
            </TabsList>
            <Button type="button" variant="outline" size="sm" onClick={openDraft}>
              <Plus aria-hidden="true" />
              {t(locale, "settings.addChain")}
            </Button>
          </div>
          {/* forceMount keeps every editor mounted (as the pre-tab list did),
              so switching tabs never silently drops in-progress edits. Radix
              itself hides nothing once forceMount pins every panel to
              present — inactive panels are hidden by the local TabsContent
              wrapper's data-[state=inactive]:hidden class. */}
          <TabsContent forceMount value={DEFAULT_CHAIN_NAME}>
            <ChainEditor
              locale={locale}
              groups={groups}
              stored={payload.model_chain}
              onSave={(chain) => onSettings({ op: "save-chain", model_chain: chain })}
            />
          </TabsContent>
          {namedTabs.map((tab) => (
            <TabsContent key={tab.id} forceMount value={tab.id}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">{tab.id}</span>
                <Button type="button" variant="destructive" size="sm" onClick={() => onRemoveChain(tab.id)}>
                  {t(locale, "settings.remove")}
                </Button>
              </div>
              <ChainEditor
                locale={locale}
                groups={groups}
                stored={tab.chain}
                onSave={(value) => onSettings({ op: "add-chain", name: tab.id, chain: value })}
              />
            </TabsContent>
          ))}
          {draft ? (
            <TabsContent forceMount value={DRAFT_CHAIN_TAB_ID}>
              <DraftChainPanel
                locale={locale}
                groups={groups}
                name={draftName}
                onNameChange={setDraftName}
                onCreate={onCreateDraft}
                onOutcome={onOutcome}
                onDiscard={() => {
                  // Plan 55 (AD-551): the lifted name no longer dies with the
                  // panel's unmount — discard resets it so a reopened draft
                  // starts blank (today's semantics, kept).
                  setDraftOpen(false);
                  setDraftName("");
                }}
                onCreated={(created) => {
                  // Success: the create handler awaited the reload and it
                  // landed (createDraftChain resolves an error outcome
                  // otherwise), so the stored-name tab exists — the draft is
                  // removed and the real tab is selected. The draft lives in
                  // component state, so no reload can resurrect it. The name
                  // resets with it (AD-551): the reopened draft starts blank.
                  setDraftOpen(false);
                  setDraftName("");
                  setSelectedTab(created);
                }}
              />
            </TabsContent>
          ) : null}
        </Tabs>
        {/* The card's region (plan 44 T3): the dialog-confirmed remove and the
            draft's forwarded save success render here, below every tabpanel —
            the editors themselves render their save outcomes in-panel. */}
        <NoticeRegion notice={notice} />
      </CardContent>
    </Card>
  );
}

/**
 * Seats (plan 39 T2): the role → chain mapping is its own card below chain
 * management, independent of the chain tabs. Every select offers Default
 * first, then the current named chains from the same plan-39 tab model; a
 * stored name that no longer resolves (deleted chain, stale payload) renders
 * and saves as Default, so op=save-roles never submits an invalid reference.
 * The save stays the route's full-map contract: one role_<role> field per
 * audit seat, always all seats.
 */
function SeatsCard({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const tabs = modelChainTabs(payload.model_chains);
  const namedTabs = tabs.filter((tab) => !tab.isDefault);
  const roleHint = (role: string) =>
    role === "mstar-review-seat" ? t(locale, "settings.roleHintReviewSeat") : t(locale, "settings.roleHintDeep");
  // Stable id-set key over the offered chain tabs: the re-derivation effect
  // below keys on it so payload object identity churn alone never fires it.
  const tabIdSetKey = tabs.map((tab) => tab.id).join();
  const [seats, setSeats] = useState<Record<string, string>>(() =>
    seatRoleValues(payload.model_role_ids, payload.model_roles, tabs),
  );

  // The seat state re-derives from the payload ONLY when the offered
  // chain-tab set changes (tabIdSetKey dep — a chain delete cascade or
  // create); unrelated-op background reloads keep unsaved seat picks. Stale
  // references the offered set no longer contains still coerce to the safe
  // Default value at render and save via seatSelectValue.
  useEffect(() => {
    setSeats(seatRoleValues(payload.model_role_ids, payload.model_roles, tabs));
  }, [tabIdSetKey]);

  // Plan 44 T3: the seat save reports in this card, under its own trigger.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const fields: Record<string, string> = { op: "save-roles" };
      for (const role of payload.model_role_ids) {
        fields[`role_${role}`] = seatSelectValue(tabs, seats[role]);
      }
      setNotice(await onSettings(fields));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.seats")}</CardTitle>
        <CardDescription>{t(locale, "settings.seatsCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {payload.model_role_ids.map((role) => (
            <label key={role} className="flex flex-col gap-1.5 text-sm font-medium">
              {role} — {roleHint(role)}
              <Select
                value={seatSelectValue(tabs, seats[role])}
                onValueChange={(value) => setSeats((current) => ({ ...current, [role]: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_CHAIN_NAME}>{t(locale, "settings.useDefaultChain")}</SelectItem>
                  {namedTabs.map((tab) => (
                    <SelectItem key={tab.id} value={tab.id}>
                      {tab.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ))}
          <Button type="submit" disabled={busy}>{t(locale, "settings.saveRoleModels")}</Button>
          <NoticeRegion notice={notice} />
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * The draft chain tab's panel (plan 44 T2, unified with the T3 pattern): the
 * full editor inside its own tabpanel — the name field first, then the model
 * builder (the components a named chain's panel uses verbatim). 保存 posts
 * the unchanged op=add-chain with the entered name + built chain; a rejected
 * create — or a create whose awaited background reload failed (plan 44 bugbot
 * fix) — renders its error INLINE through ChainEditor's own region (role=
 * alert, inside this panel) and keeps the draft + typed input; only success
 * (POST ok AND reload landed) hands the trimmed stored name back so the real
 * tab is selected, forwarding the saved outcome to the card's region (the
 * panel is about to unmount). 放弃 discards the draft without confirmation
 * (documented; matches the accepted disclosure-discard behavior) — the
 * selection coerces through activeChainTabId once the draft tab is gone. The
 * busy gate covers both triggers while the create POST is in flight, so a
 * discard can never race a resolving save into selecting the created tab.
 * Plan 55 (AD-551): the draft name is controlled — owned by ChainsCard so
 * the tab trigger can mirror it live; this panel only renders and edits it
 * through the name/onNameChange props. The input's maxLength=64 mirrors the
 * server's MODEL_CHAIN_NAME_PATTERN cap (stored ids ≤ 64 chars), so the
 * live tab-strip label can never grow unbounded.
 */
export function DraftChainPanel({
  locale,
  groups,
  name,
  onNameChange,
  onCreate,
  onOutcome,
  onDiscard,
  onCreated,
}: {
  locale: SpaBoot["locale"];
  groups: ModelOptionGroup[];
  /** Plan 55 (AD-551): the controlled draft name, owned by ChainsCard. */
  name: string;
  onNameChange: (name: string) => void;
  /** The draft create (op=add-chain); resolves an error when the awaited reload fails so the draft stays open. */
  onCreate: (fields: Record<string, string>) => Promise<OpNotice>;
  /** Forwards the SUCCESS outcome to the chains card's region. */
  onOutcome: (notice: OpNotice) => void;
  onDiscard: () => void;
  /** Fired after a successful create (the reload has landed) with the stored name. */
  onCreated: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t(locale, "settings.chainName")}
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={t(locale, "settings.chainNamePlaceholder")}
          autoComplete="off"
          maxLength={64}
        />
      </label>
      <ChainEditor
        locale={locale}
        groups={groups}
        stored={null}
        onSave={(value) => {
          setBusy(true);
          return onCreate({ op: "add-chain", name, chain: value })
            .then((outcome) => {
              // The trimmed name is what the server stored (it trims before
              // validating), so that is the real tab's id. Success here
              // already implies the awaited reload landed (onCreate resolves
              // an error outcome otherwise); errors — including a POST that
              // succeeded but whose reload failed — render through
              // ChainEditor's region below the save button, draft intact.
              if (outcome.kind === "success") {
                onOutcome(outcome);
                onCreated(name.trim());
              }
              return outcome;
            })
            .finally(() => {
              // Success closes the draft tab (onCreated) and unmounts this
              // panel, so on success this reset is a deliberate React 19
              // setState-after-unmount no-op (plan 44 QC fix round, F-001).
              setBusy(false);
            });
        }}
        saveLabel={t(locale, "settings.saveChain")}
        actions={
          // Plan 55 (AD-552): 放弃 joins the save row instead of the old
          // hover-only ghost row below it — outline + small fixed width so it
          // is visible without hover, save stays primary on the left. Still
          // no confirmation, and disabled under the same busy window as the
          // save (this panel's busy closure — the double-trigger coverage).
          <Button type="button" variant="outline" size="sm" className="w-20" disabled={busy} onClick={onDiscard}>
            {t(locale, "settings.discardChain")}
          </Button>
        }
      />
    </div>
  );
}

function ChainEditor({
  locale,
  groups,
  stored,
  onSave,
  saveLabel,
  actions,
}: {
  locale: SpaBoot["locale"];
  groups: ModelOptionGroup[];
  stored: string | null;
  /** Resolves the save outcome (plan 44 T3): rendered in this editor's region. */
  onSave: (chain: string) => Promise<OpNotice>;
  saveLabel?: string;
  /**
   * Plan 55 (AD-552): caller actions rendered in the save row, right of the
   * save button (pure render insertion — save semantics, the busy gate and
   * the outcome region are untouched). Absent, the save button renders bare:
   * byte-equivalent to the pre-actions tree (Default / named-chain editors).
   */
  actions?: ReactNode;
}) {
  const [chain, setChain] = useState(() => splitModelChain(stored));
  const [pick, setPick] = useState<string | undefined>(undefined);
  // Plan 44 T3: each editor instance owns its region — a chain save's outcome
  // renders inside its own tabpanel (the user-reported 400 case), never on
  // the page top. The next save replaces the content (replace-on-submit).
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const probeProviders = groups.filter((group) => group.source === "probe");

  useEffect(() => {
    setChain(splitModelChain(stored));
  }, [stored]);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      setNotice(await onSave(chain.join(", ")));
    } finally {
      setBusy(false);
    }
  }

  const saveButton = (
    <Button type="button" disabled={busy} onClick={() => void save()}>
      {saveLabel ?? t(locale, "settings.saveChain")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      {groups.length === 0 ? <p className="text-sm text-muted-foreground">{t(locale, "settings.noVerifiedModels")}</p> : null}
      {probeProviders.map((group) => (
        <p className="text-sm text-muted-foreground" key={group.provider}>
          {group.provider}: {t(locale, "settings.noAutoDiscovery")}
        </p>
      ))}
      {chain.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "settings.chainEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {chain.map((selector, index) => (
            <li key={`${selector}-${index}`} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <span className="font-mono text-sm">{selector}</span>
              <Button type="button" variant="destructive" size="sm" onClick={() => setChain(chain.filter((_, i) => i !== index))}>
                {t(locale, "settings.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <span className="text-sm font-medium">{t(locale, "settings.modelChainField")}</span>
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger aria-label={t(locale, "settings.modelChainField")}>
              <SelectValue placeholder={t(locale, "settings.pickModel")} />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) =>
                group.selectors.length === 0 ? null : (
                  <SelectGroup key={group.provider}>
                    <SelectLabel>{group.provider}</SelectLabel>
                    {group.selectors.map((selector) => (
                      <SelectItem key={selector} value={selector}>
                        {selector}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            if (!pick) return;
            setChain([...chain, pick]);
            setPick(undefined);
          }}
        >
          {t(locale, "settings.addToChain")}
        </Button>
      </div>
      {actions ? (
        <div className="flex items-center gap-2">
          {saveButton}
          {actions}
        </div>
      ) : (
        saveButton
      )}
      <NoticeRegion notice={notice} />
    </div>
  );
}
