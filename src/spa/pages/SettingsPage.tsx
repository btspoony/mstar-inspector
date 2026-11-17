import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { isDictionaryKey, t, type DictionaryKey } from "../../i18n";
import {
  Button,
  CardContent,
  CardDescription,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FlowSection,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from "@design-system";
import { AppAvatar } from "../components/AppAvatar";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { fetchJson, postForm, putJson } from "../api";
import type { SpaBoot } from "../boot";
import { workspaceRefOf } from "../routes";
import { apiBase, currentOrigin } from "../workspace-base";
import { deliveryOutcomeLabel } from "../delivery-outcome";
import { formatRelativeTime } from "../relative-time";
import { useRenameMembership } from "../workspace-memberships";
import {
  activeChainTabId,
  appDisplayName,
  checkGateSaveFields,
  configuredKeySlot,
  DEFAULT_CHAIN_NAME,
  DEFAULT_CHECK_GATE,
  isPaused,
  isReviewLevel,
  isReviewTriggerMode,
  concurrencySubmitBlocked,
  modelChainTabs,
  parseCheckMinScoreSettings,
  parseConcurrencySettings,
  parseInstallClaimResult,
  parseStoredCheckMinScore,
  parseStoredConcurrency,
  PR_VERDICTS,
  removeChanged,
  REVIEW_LEVELS,
  REVIEW_TRIGGER_MODES,
  seatRoleValues,
  seatSelectValue,
  splitModelChain,
  type ChainTab,
  type AllowlistSettings,
  type BotConfigSections,
  type CheckGateSettings,
  type ModelOptionGroup,
  type ReviewLevel,
  type ReviewTriggerMode,
  type AppIdentityCardApp,
  type AppInstallApp,
  hasTargetFacts,
  type BotSettingsAppMeta,
  type SettingsAppMeta,
  type SettingsIdentityAppMeta,
  type SettingsManagePayload,
  type SettingsPayload,
  type TargetReviewSlice,
} from "./data";
import { useSaveSignal } from "../components/save-signal";
import { LoadingNotice, LoadFailedNotice, NoticeRegion, PageNotice, SaveInFlight, type OpNotice } from "./PageNotice";
import { ProvidersSection } from "./settings-providers";

export type PendingAction =
  | { kind: "pause" | "resume" | "disable" | "enable" | "delete" | "park" }
  | { kind: "remove-chain"; name: string }
  | { kind: "remove-key"; provider: string; keyId: string; last4: string }
  | { kind: "remove-custom"; providerId: string };

/**
 * The 应用设置 tab body of the App detail page (App detail IA):
 * a pure-ish presentational component — the data load, the page notice
 * channel, and the loading/error faces live on the AppDetailPage shell,
 * which threads the parsed payload, the model groups, the reload
 * callback, and the banner notice down here. Page wayfinding (the back link)
 * moved to the AppDetailPage shell.
 */
function verifyReasonMessage(locale: SpaBoot["locale"], reason: string): string {
  if (reason === "invalid_key") return t(locale, "settings.verify.invalid_key");
  if (reason === "quota_exhausted") return t(locale, "settings.verify.quota_exhausted");
  if (reason === "rate_limited") return t(locale, "settings.verify.rate_limited");
  if (reason === "unreachable") return t(locale, "settings.verify.unreachable");
  if (reason === "unsupported_provider") return t(locale, "settings.verify.unsupported_provider");
  return t(locale, "settings.verify.unexpected");
}

/** A value `t()` can interpolate; anything else would render `[object Object]` or leave `{name}` bare. */
function isParamValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * True when `t()` can fill a refusal body's params in: absent, or a map whose
 * every value is a string or number. A malformed map (one object or array
 * value) refuses the keyed face, so the reader renders its generic copy
 * instead of `[object Object]` — the usage panel's `refusalOf` guard shape.
 */
function paramsInterpolable(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every(isParamValue))
  );
}

/** The refusal body's JSON object, or null when it is not one. */
function refusalBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The add-key refusal's face: STATUS first, body second. The status picks the
 * cause family, and inside that family a keyed JSON body wins, then a
 * recognised reason, then the family's own generic copy — so no status reaches
 * the operator as one undifferentiated "unexpected response" (I-000573).
 * `settings.verify.unexpected` survives only as the shared fallback for a
 * status no rule classifies, and never carries the body or the key material.
 */
export function verifyRefusalMessage(locale: SpaBoot["locale"], status: number, body: string): string {
  const parsed = refusalBody(body);
  const keyed =
    parsed !== null &&
    typeof parsed.key === "string" &&
    isDictionaryKey(parsed.key) &&
    paramsInterpolable(parsed.params)
      ? { key: parsed.key as DictionaryKey, params: parsed.params as Record<string, string | number> | undefined }
      : undefined;
  if (keyed !== undefined) return t(locale, keyed.key, keyed.params);
  switch (status) {
    case 400: {
      // The provider's own rejections keep their per-reason face; only a body
      // that states no reason this page knows falls back to the family copy.
      const reason = parsed?.reason;
      return typeof reason === "string"
        ? verifyReasonMessage(locale, reason)
        : t(locale, "settings.providers.addKeyRefused");
    }
    // A shared bot (the keyed body above) and a non-manager (the forbidden
    // HTML page) are different causes with different remedies.
    case 403:
      return t(locale, "settings.providers.addKeyForbidden");
    case 404:
      return t(locale, "settings.providers.addKeyUnknownApp");
    case 409:
      return t(locale, "settings.providers.addKeyConflict");
    case 429:
      return t(locale, "settings.providers.addKeyRateLimited");
    // The Worker already splits these: a missing master key answers plain
    // text, a rejected write answers JSON. Both reuse its own wording.
    case 500:
      return t(
        locale,
        parsed === null ? "settings.providers.addKeyNoMasterKey" : "settings.providers.addKeyStorageFailed",
      );
    default:
      return t(
        locale,
        parsed === null ? "settings.providers.addKeyUnreadable" : "settings.verify.unexpected",
      );
  }
}

export function settingsErrorMessage(locale: SpaBoot["locale"], body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      key?: unknown;
      params?: unknown;
      code?: unknown;
      message?: unknown;
      selector?: unknown;
    };
    // Mapped 400s carry a machine-readable key plus the
    // interpolation params — resolve it in the operator's locale. An unknown
    // key (newer server, stale client) falls through to the English face
    // below — fail-visible, never blank.
    if (typeof parsed.key === "string" && isDictionaryKey(parsed.key)) {
      // A params map `t()` cannot fill in would print `[object Object]` or a
      // bare `{name}`: the localized generic face renders instead of the raw
      // JSON refusal body.
      if (!paramsInterpolable(parsed.params)) return t(locale, "common.loadFailed");
      return t(locale, parsed.key, parsed.params as Record<string, string | number> | undefined);
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

/**
 * Resolve a settings/pinned POST response to its op outcome: a mapped 4xx
 * resolves through the keyed resolver; a 2xx whose body reports
 * `changed: false` — the remove routes' tolerant no-op, where the row was
 * already gone — is a WARNING carrying the localized no-change copy, never
 * "Changes saved."; every other 2xx is the caller's success copy.
 */
export function settingsOpOutcome(
  locale: SpaBoot["locale"],
  status: number,
  body: string,
  successMessage?: string,
): OpNotice {
  if (status >= 400) {
    return { kind: "error", message: settingsErrorMessage(locale, body) };
  }
  if (removeChanged(body) === false) {
    return { kind: "warn", message: t(locale, "settings.removeNoChange") };
  }
  return { kind: "success", message: successMessage ?? t(locale, "settings.changesSaved") };
}

/**
 * The target-owned body: the review policy (identity, trigger, depth, gate)
 * and the ops zone (pause/resume, park), rendered by the review-target
 * detail page (`/dashboard/<ref>/targets/:appId`). The bot-owned
 * configuration lives on the bot page; the App detail keeps the App's own
 * faces. Pure-ish: the data load, the page notice channel and the
 * loading/error faces live on the page shell, which threads the parsed
 * payload and the reload callback down here.
 */
export function SettingsView({
  locale,
  payload,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const { app } = payload;
  // Every pinned path of this page hangs off the page's workspace prefix
  // (`/dashboard` legacy, `/dashboard/<slug>` under strict) — the legacy App
  // route family answers 404 on a workspace-scoped deployment.
  const appPath = `${apiBase()}/apps/${app.github_app_id}`;
  const base = `${appPath}/settings`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  // Dialog-confirmed ops report into the card that owns the
  // action (one notice state per card region). The target-scoped ops
  // (pause/resume/disable/enable/delete) are the only ones left here: the
  // bot-scoped configuration moved to the bot page with its own regions.
  const [opsNotice, setOpsNotice] = useState<OpNotice | null>(null);

  async function runPinned(path: string, fields: Record<string, string> = {}): Promise<OpNotice> {
    return postPinnedOutcome(path, fields, locale, () => onReload({ background: true }));
  }

  /**
   * Resolve the op's outcome to the caller: the card/cluster that
   * submitted the fields renders it in its own region. A network-level POST
   * failure (postForm throws before an outcome exists) resolves the
   * save-failed copy (a failed save must not claim the page
   * couldn't load) so no op stays silent; a redirect hop navigates away
   * before this resolves. The outcome also carries `reloaded` — whether the
   * awaited background refresh actually landed — which only the draft create
   * reads (POST success alone is not completion there); every other caller
   * renders the plain OpNotice and ignores it.
   */
  async function submitSettings(
    fields: Record<string, string> | URLSearchParams,
  ): Promise<OpNotice & { reloaded: boolean }> {
    let status: number;
    let body: string;
    // The catch guards only the POST — a background reload never rejects:
    // load() catches its own failures into the page notice.
    try {
      ({ status, body } = await postForm(base, fields));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed"), reloaded: false };
    }
    const outcome: OpNotice = settingsOpOutcome(locale, status, body);
    const reloaded = await onReload({ background: true });
    return { ...outcome, reloaded };
  }

  /**
   * The review trigger mode save (spec review-trigger-policy §2): the
   * same pinned-ops POST family as pause/resume — `submitTriggerMode`
   * resolves the keyed 400 (`settings.error.triggerModeUnknown`) through
   * the shared settingsErrorMessage resolver and lands the stored value
   * via the awaited background reload.
   */
  async function runTriggerMode(mode: ReviewTriggerMode): Promise<OpNotice> {
    return submitTriggerMode(String(app.github_app_id), mode, locale, () => onReload({ background: true }));
  }

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      if (action.kind === "delete") {
        // Irreversible outcome with its own copy: "Changes saved." reads wrong
        // after a delete, and the user stays on the deleted App's page.
        // refetch: false — the deleted App's settings GET is a guaranteed 404,
        // so refetching would overwrite the outcome with "Load failed."
        setOpsNotice(
          await postPinnedOutcome(`${appPath}/delete`, {}, locale, () => onReload({ background: true }), {
            successMessage: t(locale, "settings.deleteSuccess"),
            refetch: false,
          }),
        );
      } else {
        setOpsNotice(await runPinned(`${appPath}/${action.kind}`));
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, appDisplayName(app), pending);

  // Identity-only non-manager face: the payload carries the D4 identity
  // set ONLY (no ops stores, no `installations[]`), so the tab renders the
  // GitHub identity section and nothing else — no slug row (the AppDetailPage
  // shell owns the identity header), no ops/health/configuration surfaces.
  // The installations count stays out for the same reason: `installations`
  // is the manager face's array, and nowhere else may a count appear.
  if (!payload.can_manage) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col">
          <AppInfoSection
            locale={locale}
            app={payload.app}
            workspaceId={payload.workspace_id}
            canManage={false}
          />
        </div>
      </div>
    );
  }

  // A manager read for an App the workspace has added no repository under yet
  // carries no review policy at all (the target-owned slice is absent, not
  // defaulted): the identity card is the whole face. The App detail's 应用设置
  // tab renders the bot configuration for that state — the review controls it
  // would otherwise offer are the repository surface's.
  if (!hasTargetFacts(payload)) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col">
          <AppInfoSection
            locale={locale}
            app={payload.app}
            workspaceId={payload.workspace_id}
            canManage={false}
          />
        </div>
      </div>
    );
  }

  // A Blocked target (its bot is `owned` by another workspace) keeps every
  // TARGET-owned control and loses the bot's: the identity card drops the
  // delivery URL and the refresh (both bot-scope writes this workspace cannot
  // make), and the ops zone keeps the pause and the park. The bot's own
  // sections never reached this tab — they live on the bot page, which answers
  // 404 for a Blocked target.
  const blocked = payload.blocked;

  return (
    <div className="flex flex-col gap-6">
      {/* Detail-page section flow (r3 baseline § 5): one content plane divided
          by hairlines instead of one framed card per section. Sections are
          direct siblings so FlowSection's first/last edge trimming applies.
          Order and membership are the owner split's: the target keeps its
          identity, its review trigger, its depth, its gate and the
          destructive ops zone — the bot-owned configuration (providers,
          chains, seats, sandbox image, installations) lives on the bot page. */}
      <div className="flex flex-col">
        <AppInfoSection
          locale={locale}
          app={app}
          workspaceId={payload.workspace_id}
          canManage={!blocked}
          onReload={blocked ? undefined : () => onReload({ background: true })}
        />

        <ReviewTriggerSection locale={locale} payload={payload} onTriggerMode={runTriggerMode} />

        <ReviewDepthSection locale={locale} payload={payload} onSettings={submitSettings} />

        <ReviewGateSection locale={locale} payload={payload} onSettings={submitSettings} />

        <OpsSection
          locale={locale}
          payload={payload}
          onPending={setPending}
          notice={opsNotice}
          botWritable={!blocked}
        />
      </div>

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

/** The dialog copy for a confirmed action — shared with the bot page's remove actions. */
export function pendingConfirmCopy(
  locale: SpaBoot["locale"],
  name: string,
  pending: PendingAction | null,
): { title: string; body: string; action: string; destructive: boolean } | null {
  if (!pending) return null;
  if (pending.kind === "park") {
    return {
      title: t(locale, "settings.confirmParkTitle", { name }),
      body: t(locale, "settings.confirmParkBody"),
      action: t(locale, "settings.confirmParkAction"),
      destructive: true,
    };
  }
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
      title: t(locale, "settings.confirmRemoveKeyTitle", {
        provider: pending.provider,
        last4: pending.last4 === "" ? t(locale, "settings.keyTooShort") : pending.last4,
      }),
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
      title: t(locale, "settings.confirmPauseTitle", { slug: name }),
      body: t(locale, "settings.confirmPauseBody"),
      action: t(locale, "apps.actions.pause"),
      destructive: false,
    },
    resume: {
      title: t(locale, "settings.confirmResumeTitle", { slug: name }),
      body: t(locale, "settings.confirmResumeBody"),
      action: t(locale, "apps.actions.resume"),
      destructive: false,
    },
    disable: {
      title: t(locale, "settings.confirmDisableTitle", { slug: name }),
      body: t(locale, "settings.confirmDisableBody"),
      action: t(locale, "settings.confirmDisableAction"),
      destructive: true,
    },
    enable: {
      title: t(locale, "settings.confirmEnableTitle", { slug: name }),
      body: t(locale, "settings.confirmEnableBody"),
      action: t(locale, "apps.actions.enable"),
      destructive: false,
    },
    delete: {
      title: t(locale, "settings.confirmDeleteTitle", { slug: name }),
      body: t(locale, "settings.confirmDeleteBody"),
      action: t(locale, "settings.confirmDeleteButton"),
      destructive: true,
    },
  } as const;
  return map[pending.kind];
}

/**
 * (AD-623): the manager-face link target — the GitHub App settings
 * page derived from the cached public html_url. The slug is the segment right
 * after an `apps` segment — the pathname's `apps/<slug>` tail, exactly one
 * segment after `apps` (trailing slash tolerated) — never a deeper sub-path:
 * `/apps/acme/settings` derives null, not slug "settings" (qc round 1,
 * qc2-F-001); an already settings-shaped url keeps deriving idempotently.
 * Deliberately never `github_name` (display name ≠ URL slug) and never the
 * local `SettingsAppMeta.id` (local App UID ≠ GitHub App slug).
 * The server
 * validates only the `https://` prefix (github-app-metadata.ts), so an
 * unusable shape — no `apps/<slug>` tail, or a value `new URL` cannot parse —
 * returns null and the caller keeps the public-page link (runtime
 * degradation, never a dead href).
 */
export function githubAppSettingsUrl(githubHtmlUrl: string): string | null {
  try {
    const segments = new URL(githubHtmlUrl).pathname.split("/").filter(Boolean);
    const slug =
      segments.length >= 2 && segments[segments.length - 2] === "apps"
        ? segments[segments.length - 1]
        : null;
    return slug ? `https://github.com/settings/apps/${slug}` : null;
  } catch {
    return null;
  }
}

/**
 * The GitHub identity card — avatar, hyperlinked name,
 * description, and the numeric App id, fed by the cached GitHub profile the
 * settings route serves (migration 0019 columns). Rendered outside the
 * can_manage conditional, so managers and members alike see it (AC3).
 * (AD-623): `canManage` switches the name link's destination —
 * managers reach the App's GitHub settings page (githubAppSettingsUrl over
 * the cached html_url), members keep the public page; the label names the
 * destination it actually carries.
 * Degradation is strictly per-field (global constraint): a null field
 * simply does not render — a never-synced App shows the placeholder mark and
 * its local App id with no link, no error state, no layout collapse
 * (the fail-open UI face of the AD-531 read path).
 */
export function AppInfoSection({
  locale,
  app,
  workspaceId,
  canManage,
  onReload,
}: {
  locale: SpaBoot["locale"];
  /** Every face — the identity, manage and Blocked app shapes share every field the card reads. */
  app: SettingsIdentityAppMeta | SettingsAppMeta | AppIdentityCardApp | BotSettingsAppMeta;
  /**
   * The App's stable workspace id from the payload — the delivery URL's first
   * segment. Deliberately NOT derived from the pathname: a route ref may be a
   * workspace slug, and the printed URL must carry the id GitHub is pointed at.
   */
  workspaceId: string;
  /** Threaded from payload.can_manage at the call site — presentation only. */
  canManage: boolean;
  /** The manager face's background reload — present iff canManage; the refresh button renders only when both hold. */
  onReload?: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  // Card-local op feedback (the NoticeRegion idiom): the refresh outcome
  // renders beside the button, never through a page-level channel.
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function refreshMetadata(): Promise<void> {
    setRefreshing(true);
    try {
      const res = await fetch(`${apiBase()}/api/apps/${app.github_app_id}/refresh-metadata`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = await res.text();
      // Keyed 400 (settings.error.githubMetadataRefreshFailed) or any other
      // failure: the resolved message lands in this region and RETURNS before
      // any reload — the cached face stays on screen.
      if (!res.ok) {
        const failure: OpNotice = { kind: "error", message: settingsErrorMessage(locale, body) };
        setNotice(failure);
        return;
      }
      // Success = the server re-cached the profile: a card-local notice plus a
      // background reload re-renders the card from the fresh payload without
      // a page banner.
      const outcome: OpNotice = { kind: "success", message: t(locale, "settings.appInfoRefreshDone") };
      setNotice(outcome);
      await onReload?.();
    } catch {
      // Transport failure (offline, a restarting Worker, DNS): the fetch
      // REJECTS, so there is no HTTP status to resolve a key from. Same
      // card-local error region, the shared save-failure copy, and no reload —
      // the cached face stays (the sibling op channels' `common.saveFailed`).
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setRefreshing(false);
    }
  }
  // Derived BEFORE the per-field JSX so the href and the aria-label key off
  // the same resolved destination; a member viewer or a non-derivable url
  // leaves settingsHref null and every face below is today's.
  const settingsHref =
    canManage && app.github_html_url ? githubAppSettingsUrl(app.github_html_url) : null;
  return (
    <FlowSection title={t(locale, "settings.appInfo")} subtitle={t(locale, "settings.appInfoCopy")}>
      <div className="flex items-start gap-4">
        <AppAvatar
          src={app.github_avatar_url}
          appId={app.github_app_id}
          className="h-12 w-12 shrink-0 rounded-full border border-(--border-default) object-cover"
        />
        <div className="flex min-w-0 flex-col gap-1">
          {app.github_name ? (
            app.github_html_url ? (
              <a
                href={settingsHref ?? app.github_html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
                aria-label={t(
                  locale,
                  settingsHref ? "settings.appInfoManageOnGithub" : "settings.appInfoViewOnGithub",
                  { name: app.github_name },
                )}
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
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.appInfoLocalId", { id: app.id })}
          </p>
          {/* The delivery URL a webhook repoint needs (deploy doc § 3 sends
              the operator here): manager-only, because the webhook URL is
              the App's delivery route and a member has no repoint duty.
              Both segments are internal ids, so the section shows them above.
              Selected as one text node so click-drag copies it whole. */}
          {canManage ? (
            <p className="text-xs text-muted-foreground">
              {t(locale, "settings.appInfoDeliveryUrl")}{" "}
              <code className="select-all rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                {`${currentOrigin()}/webhook/${workspaceId}/${app.id}`}
              </code>
            </p>
          ) : null}
          {app.github_metadata_synced_at ? (
            <p className="text-xs text-muted-foreground">
              {t(locale, "settings.appInfoSynced", {
                time: formatRelativeTime(app.github_metadata_synced_at, locale),
              })}
            </p>
          ) : null}
        </div>
      </div>
      {canManage && onReload ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button type="button" variant="secondary" disabled={refreshing} onClick={() => void refreshMetadata()}>
              {t(locale, "settings.appInfoRefresh")}
            </Button>
          </div>
          <NoticeRegion notice={notice} />
        </div>
      ) : null}
    </FlowSection>
  );
}

/**
 * The Installed tab's first block: the GitHub installation entry point.
 *
 * An `owned` bot keeps the plain share link (derived from the cached GitHub
 * slug; an App whose metadata has not synced explains that instead of
 * rendering a dead link). A `shared` bot instead offers the CLAIM action: the
 * claim row is the only thing that lets GitHub's stateless setup redirect bind
 * this target, so sending the user straight to `installations/new` would create
 * an installation no target can attribute. Either way the block names the
 * target's bound installation — its account, and when GitHub no longer has it,
 * that reviews stopped until it comes back.
 */
export function AppInstallSection({
  locale,
  appId,
  app,
  installation,
  pendingInstallations,
  blocked,
  onReload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  /** Every face: the three app shapes share the fields the block names. */
  app: AppInstallApp;
  installation: SettingsManagePayload["installation"];
  /** The bot's live installations no target references — the bind source. */
  pendingInstallations: SettingsManagePayload["pending_installations"];
  /** The server-derived Blocked state: no install/claim action while true. */
  blocked: boolean;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const slug = app.github_slug;
  const name = appDisplayName(app);
  const href = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
  const [claiming, setClaiming] = useState(false);
  const [claimFailed, setClaimFailed] = useState(false);
  /** The installation id being bound, so one row's action is not doubled. */
  const [binding, setBinding] = useState<number | null>(null);
  const [bindFailed, setBindFailed] = useState(false);

  /**
   * Bind one pending installation to this target. The route runs the same
   * consume-and-bind batch the GitHub setup redirect does, so a refusal (a
   * lost race, an unshared bot) is reported here instead of silently
   * reloading.
   */
  async function bindInstallation(installationId: number): Promise<void> {
    setBinding(installationId);
    setBindFailed(false);
    try {
      const res = await postForm(`${apiBase()}/apps/${encodeURIComponent(appId)}/bind-installation`, {
        installationId: String(installationId),
      });
      if (res.status !== 200) {
        setBindFailed(true);
        return;
      }
      await onReload({ background: true });
    } catch {
      setBindFailed(true);
    } finally {
      setBinding(null);
    }
  }

  /** Record the claim, then leave for GitHub's install page. */
  async function startClaim(): Promise<void> {
    setClaiming(true);
    setClaimFailed(false);
    try {
      const res = await postForm(`${apiBase()}/apps/${encodeURIComponent(appId)}/claim`, {});
      const result = res.status === 200 ? parseInstallClaimResult(JSON.parse(res.body)) : null;
      if (result === null) {
        setClaimFailed(true);
        return;
      }
      // A full navigation out to GitHub; the claim row carries the intent, so
      // the callback can attribute the installation the user creates there.
      window.location.assign(result.installationUrl);
    } catch {
      setClaimFailed(true);
    } finally {
      setClaiming(false);
    }
  }

  return (
    <FlowSection title={t(locale, "settings.install")} subtitle={slug ? t(locale, "settings.installCopy") : undefined}>
      <div className="flex items-start gap-4">
        <AppAvatar
          src={app.github_avatar_url}
          appId={app.github_app_id}
          className="h-10 w-10 shrink-0 rounded-full border border-(--border-default) object-cover"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold">{name}</p>
          {blocked ? null : href === null ? (
            <p className="text-sm text-muted-foreground">{t(locale, "settings.installNoSlug")}</p>
          ) : app.scope === "shared" && installation === null ? (
            <>
              <p className="text-sm text-muted-foreground">{t(locale, "settings.installClaimCopy")}</p>
              <Button
                type="button"
                variant="secondary"
                className="w-fit"
                disabled={claiming}
                onClick={() => void startClaim()}
              >
                {t(locale, "settings.installClaim")}
              </Button>
              {claimFailed ? (
                <p role="status" className="text-sm text-(--tone-warn-fg)">
                  {t(locale, "settings.installClaimFailed")}
                </p>
              ) : null}
              {pendingInstallations.length === 0 ? null : (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t(locale, "settings.installPending")}</p>
                  <ul className="flex flex-col gap-2">
                    {pendingInstallations.map((row) => (
                      <li key={row.installation_id} className="flex items-center gap-2 text-sm">
                        <span>
                          {row.account_login === null
                            ? t(locale, "settings.installPendingUnknownAccount", {
                                id: String(row.installation_id),
                              })
                            : row.account_login}
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          className="w-fit"
                          disabled={binding !== null}
                          onClick={() => void bindInstallation(row.installation_id)}
                        >
                          {t(locale, "settings.installPendingBind")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {bindFailed ? (
                    <p role="status" className="text-sm text-(--tone-warn-fg)">
                      {t(locale, "settings.installBindFailed")}
                    </p>
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
              aria-label={t(locale, "settings.installLinkAria", { name })}
            >
              {t(locale, "settings.installLink")}
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </a>
          )}
          {installation === null ? null : (
            <p className="text-sm text-muted-foreground">
              {installation.account_login === null
                ? t(locale, "settings.installBoundNoAccount", { id: String(installation.id) })
                : t(locale, "settings.installBoundAccount", { account: installation.account_login })}
            </p>
          )}
          {installation !== null && installation.removed ? (
            <p className="text-sm text-(--tone-warn-fg)">{t(locale, "settings.installRemoved")}</p>
          ) : null}
        </div>
      </div>
    </FlowSection>
  );
}

/**
 * The Installed tab's second block: the owner allowlist (it sits above the
 * installation table and below the install link — owners arrive through
 * installations). The caller renders it for EVERY visibility: admission
 * enforces the stored list whatever the cached visibility, so hiding the
 * control for a private App would leave a live filter unmanageable — a
 * private App gets a line saying the control is shown for that reason
 * (`privateApp`). The switch and the logins save together: `enabled` rides as
 * exactly one `"1"` / `"0"` field and `owners` as one newline-separated text
 * field the server splits, trims and de-duplicates.
 */
export function AllowlistSection({
  locale,
  appId,
  allowlist,
  privateApp,
  installations,
  onReload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  allowlist: AllowlistSettings;
  /** The cached visibility is `private` — only the note below changes. */
  privateApp: boolean;
  /**
   * The bot's installations — the rows this allowlist admits or refuses.
   * `null` = not readable here (a Blocked target): the table is replaced by a
   * line saying so instead of a false "no installations".
   */
  installations: SettingsManagePayload["installations"] | null;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState(allowlist.enabled);
  const [owners, setOwners] = useState(allowlist.owners.join("\n"));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  // The save rides the button: the signal drives its face, the success copy
  // survives as assistive text beside it — never as a notice box.
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
  // Server-state mirror: the deps compare by content, so an unrelated
  // background reload (same stored values) never discards unsaved typing,
  // while this save's reload — or a failed one — resyncs from the row.
  const storedOwners = allowlist.owners.join("\n");
  useEffect(() => {
    setEnabled(allowlist.enabled);
    setOwners(storedOwners);
  }, [allowlist.enabled, storedOwners]);

  const listed = owners
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  async function save(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await postPinnedOutcome(
        `${apiBase()}/apps/${encodeURIComponent(appId)}/settings`,
        { op: "save-allowlist", enabled: enabled ? "1" : "0", owners },
        locale,
        () => onReload({ background: true }),
      );
      if (outcome.kind === "success") {
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowSection title={t(locale, "settings.allowlist")} subtitle={t(locale, "settings.allowlistCopy")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {privateApp ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.allowlistPrivateStillApplies")}</p>
        ) : null}
        {/* The switch: a native binary control bound to its label — the house
            primitives carry no switch, and a bespoke widget would duplicate
            keyboard and state handling the platform already gets right. */}
        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-(--tone-accent-solid)"
            checked={enabled}
            disabled={busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t(locale, "settings.allowlistEnable")}
        </label>
        {enabled ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.allowlistOwners")}
            <textarea
              className="min-h-28 w-full rounded-sm border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50"
              value={owners}
              disabled={busy}
              onChange={(event) => setOwners(event.target.value)}
            />
          </label>
        ) : null}
        {enabled && listed.length === 0 ? (
          <p role="status" className="text-sm text-(--tone-warn-fg)">
            {t(locale, "settings.allowlistFailClosed")}
          </p>
        ) : null}
        {/* Admission, per installation: the allowlist is what decides it, so
            the verdict renders HERE beside the owners it judges — the bot's
            installation rows themselves live on the bot page. */}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t(locale, "settings.installationsAvailability")}</span>
          {installations === null ? (
            <p className="text-sm text-muted-foreground">{t(locale, "settings.installationsNotVisible")}</p>
          ) : installations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {installations.map((inst) => {
                // Admission mirrors the server rule (migration 0045): the
                // switch off admits everyone; on, only a login on the owners
                // list (GitHub logins are case-insensitive) is admitted.
                const login = inst.account_login;
                const valid =
                  !enabled ||
                  (login !== null &&
                    listed.some((owner) => owner.toLowerCase() === login.toLowerCase()));
                return (
                  <li key={inst.installation_id} className="flex items-center gap-2 text-sm">
                    <span>{login ?? t(locale, "common.time.unknown")}</span>
                    <StatusBadge tone={valid ? "success" : "neutral"}>
                      {t(locale, valid ? "settings.availabilityValid" : "settings.availabilityInvalid")}
                    </StatusBadge>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <Button type="submit" disabled={busy} status={signal.status === "idle" ? undefined : signal.status}>
            {t(locale, "settings.allowlistSave")}
          </Button>
          <SaveInFlight show={signal.status === "loading"} locale={locale} />
          {signal.status === "success" && savedCopy !== null ? (
            <span role="status" className="sr-only">
              {savedCopy}
            </span>
          ) : null}
        </div>
        <NoticeRegion notice={notice} />
      </form>
    </FlowSection>
  );
}

/**
 * The Settings tab's review gate (migration 0045): the score floor plus the
 * verdicts that satisfy it — the App's Check pass condition. `pass_verdicts`
 * rides as one repeated field per checked box (the shape the server
 * aggregates); an empty selection is legal and fails closed, so no review can
 * pass. Both bounds are re-validated server-side.
 */
export function ReviewGateSection({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: TargetReviewSlice;
  onSettings: (fields: Record<string, string> | URLSearchParams) => Promise<OpNotice>;
}) {
  const gate = payload.check_gate;
  // An unreadable stored verdict list arrives as `null`: there is no value to
  // render and nothing a save could round-trip, so the section keeps its
  // heading, states the degradation, and offers the one recovery that works.
  if (gate === null) return <ReviewGateRecovery locale={locale} onSettings={onSettings} />;
  return <ReviewGateEditor locale={locale} gate={gate} onSettings={onSettings} />;
}

/**
 * The unreadable-gate face. There is no value to edit, so the only way back is
 * a re-write of the SAME row through the settings route's `save-check-gate`
 * op: `saveCheckGate`'s UPDATE never reads the columns it sets, so the
 * documented DDL defaults overwrite whatever the row holds and the readable
 * gate section returns on the reload. No second writer and no new route — the
 * control names the values it writes, and nothing is written until it is used.
 */
function ReviewGateRecovery({
  locale,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  onSettings: (fields: Record<string, string> | URLSearchParams) => Promise<OpNotice>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  // The reset rides the button: the signal drives its face, the success copy
  // survives as assistive text beside it — never as a notice box.
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);

  async function reset(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await onSettings(
        checkGateSaveFields({
          min_score: String(DEFAULT_CHECK_GATE.min_score),
          pass_verdicts: DEFAULT_CHECK_GATE.pass_verdicts,
        }),
      );
      if (outcome.kind === "success") {
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowSection title={t(locale, "settings.reviewGate")} subtitle={t(locale, "settings.reviewGateCopy")}>
      <p role="status" className="text-sm text-(--tone-warn-fg)">
        {t(locale, "settings.reviewGateUnreadable")}
      </p>
      <div>
        <Button type="button" disabled={busy} onClick={() => void reset()} status={signal.status === "idle" ? undefined : signal.status}>
          {t(locale, "settings.reviewGateReset", {
            score: DEFAULT_CHECK_GATE.min_score,
            verdicts: DEFAULT_CHECK_GATE.pass_verdicts.join(", "),
          })}
        </Button>
        <SaveInFlight show={signal.status === "loading"} locale={locale} />
        {signal.status === "success" && savedCopy !== null ? (
          <span role="status" className="sr-only">
            {savedCopy}
          </span>
        ) : null}
      </div>
      <NoticeRegion notice={notice} />
    </FlowSection>
  );
}

function ReviewGateEditor({
  locale,
  gate,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  gate: CheckGateSettings;
  onSettings: (fields: Record<string, string> | URLSearchParams) => Promise<OpNotice>;
}) {
  const [score, setScore] = useState(String(gate.min_score));
  const [verdicts, setVerdicts] = useState<string[]>([...gate.pass_verdicts]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  // The save rides the button: the signal drives its face, the success copy
  // survives as assistive text beside it — never as a notice box.
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
  // Content-compared mirror, same discipline as the allowlist's: unrelated
  // reloads keep unsaved edits; a landed save resyncs from the stored row.
  const storedVerdicts = gate.pass_verdicts.join(",");
  useEffect(() => {
    setScore(String(gate.min_score));
    setVerdicts([...gate.pass_verdicts]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.min_score, storedVerdicts]);

  function toggle(verdict: string): void {
    setVerdicts((current) =>
      current.includes(verdict) ? current.filter((entry) => entry !== verdict) : [...current, verdict],
    );
  }

  async function save(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await onSettings(
        checkGateSaveFields({
          min_score: score.trim(),
          // One field per checked box, in the canonical vocabulary order.
          pass_verdicts: PR_VERDICTS.filter((verdict) => verdicts.includes(verdict)),
        }),
      );
      if (outcome.kind === "success") {
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowSection title={t(locale, "settings.reviewGate")} subtitle={t(locale, "settings.reviewGateCopy")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex w-fit flex-col gap-1.5 text-sm font-medium">
          {t(locale, "settings.reviewGateScore")}
          <Input
            type="number"
            min={0}
            max={100}
            step={1}
            value={score}
            disabled={busy}
            onChange={(event) => setScore(event.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t(locale, "settings.reviewGateVerdicts")}</legend>
          {PR_VERDICTS.map((verdict) => (
            <label key={verdict} className="flex w-fit items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-(--tone-accent-solid)"
                checked={verdicts.includes(verdict)}
                disabled={busy}
                onChange={() => toggle(verdict)}
              />
              {verdict}
            </label>
          ))}
        </fieldset>
        {verdicts.length === 0 ? (
          <p role="status" className="text-sm text-(--tone-warn-fg)">
            {t(locale, "settings.reviewGateFailClosed")}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={busy} status={signal.status === "idle" ? undefined : signal.status}>
            {t(locale, "settings.reviewGateSave")}
          </Button>
          <SaveInFlight show={signal.status === "loading"} locale={locale} />
          {signal.status === "success" && savedCopy !== null ? (
            <span role="status" className="sr-only">
              {savedCopy}
            </span>
          ) : null}
        </div>
        <NoticeRegion notice={notice} />
      </form>
    </FlowSection>
  );
}

/**
 * The review trigger: when a delivery starts a review (spec
 * review-trigger-policy §2). Target-scoped — the workspace decides it — so it
 * lives on the target detail; the bot's sandbox image sits beside the rest of
 * the bot's own configuration on the bot page.
 */
export function ReviewTriggerSection({
  locale,
  payload,
  onTriggerMode,
}: {
  locale: SpaBoot["locale"];
  payload: TargetReviewSlice;
  /** The review-trigger-mode save (the mode control's POST, resolved back to its own region). */
  onTriggerMode: (mode: ReviewTriggerMode) => Promise<OpNotice>;
}) {
  return (
    <FlowSection title={t(locale, "settings.reviewTrigger")} subtitle={t(locale, "settings.reviewTriggerCopy")}>
      <ReviewTriggerControl
        locale={locale}
        slug={payload.app.github_slug}
        mode={payload.app.review_trigger_mode}
        onTriggerMode={onTriggerMode}
      />
    </FlowSection>
  );
}

/**
 * The runtime-harness selection (the harness mounted into the sandbox image),
 * rendered inside the bot page's sandbox section. The payload carries registry
 * ids only — never image-local configuration or secrets.
 */
export function RuntimeHarnessEditor({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: BotConfigSections;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const [selected, setSelected] = useState(payload.app.sandbox_image_id);
  // The save outcome rides the button next to the trigger — the busy guard
  // keeps the save button disabled while its POST is in flight, and the
  // success copy survives as assistive text, never as a notice box.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);

  useEffect(() => {
    setSelected(payload.app.sandbox_image_id);
  }, [payload.app.sandbox_image_id]);

  async function save(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await onSettings({ op: "save-sandbox-image", sandbox_image_id: selected });
      if (outcome.kind === "success") {
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Content-adaptive shell — no reserved min width, so the
            trigger sits immediately next to the save button; flex-wrap keeps
            the button wrapping below cleanly on narrow screens. */}
        <div className="w-fit max-w-xs">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger aria-label={t(locale, "settings.runtimeHarness")}>
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
        <Button type="button" disabled={busy} onClick={() => void save()} status={signal.status === "idle" ? undefined : signal.status}>
          {t(locale, "settings.saveRuntimeHarness")}
        </Button>
        <SaveInFlight show={signal.status === "loading"} locale={locale} />
        {signal.status === "success" && savedCopy !== null ? (
          <span role="status" className="sr-only">
            {savedCopy}
          </span>
        ) : null}
      </div>
      <NoticeRegion notice={notice} />
    </div>
  );
}

/**
 * Review depth (migration 0047): the select's four faces. Three are the wire
 * levels; the fourth is the inherit face — it stores NULL and follows the
 * operator default, whose resolved level its label names, so a manager never
 * needs the operator console to know what NULL runs. Copy follows the plan's
 * product vocabulary table: `default` reads "Standard" so the three degrees
 * (Quick / Standard / Deep) sit side by side.
 */
export const REVIEW_DEPTH_INHERIT = "inherit";

export type ReviewDepthChoice = ReviewLevel | typeof REVIEW_DEPTH_INHERIT;

/** True exactly when `value` is one of the select's four faces. */
function isReviewDepthChoice(value: string): value is ReviewDepthChoice {
  return value === REVIEW_DEPTH_INHERIT || isReviewLevel(value);
}

const REVIEW_LEVEL_COPY: Record<ReviewLevel, { name: DictionaryKey; hint: DictionaryKey }> = {
  quick: { name: "settings.reviewDepthQuick", hint: "settings.reviewDepthQuickHint" },
  default: { name: "settings.reviewDepthStandard", hint: "settings.reviewDepthStandardHint" },
  deep: { name: "settings.reviewDepthDeep", hint: "settings.reviewDepthDeepHint" },
};

/** The depth select's faces, in order: the three levels, then the inherit face. */
export function reviewDepthOptions(
  locale: SpaBoot["locale"],
  defaultLevel: ReviewLevel,
): Array<{ value: ReviewDepthChoice; label: string }> {
  return [
    ...REVIEW_LEVELS.map((level) => ({
      value: level,
      label: `${t(locale, REVIEW_LEVEL_COPY[level].name)} — ${t(locale, REVIEW_LEVEL_COPY[level].hint)}`,
    })),
    {
      value: REVIEW_DEPTH_INHERIT,
      label: t(locale, "settings.reviewDepthInherit", {
        level: t(locale, REVIEW_LEVEL_COPY[defaultLevel].name),
      }),
    },
  ];
}

/**
 * Review depth: how thoroughly this App's reviews run. One select, four faces;
 * picking one saves immediately (the review-trigger control's discipline), and
 * the inherit face writes NULL. Manage face only — the identity-only payload
 * has no depth field and renders no control.
 */
export function ReviewDepthSection({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: TargetReviewSlice;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const stored: ReviewDepthChoice = payload.app.review_level ?? REVIEW_DEPTH_INHERIT;
  const options = reviewDepthOptions(locale, payload.app.default_review_level);
  const [selected, setSelected] = useState<ReviewDepthChoice>(stored);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);

  // Server-state mirror: a background reload lands the stored depth; a failed
  // save reverts instead of leaving the optimistic value.
  useEffect(() => {
    setSelected(stored);
  }, [stored]);

  async function save(next: ReviewDepthChoice): Promise<void> {
    if (next === selected) return;
    setBusy(true);
    try {
      const outcome = await onSettings({ op: "save-review-level", level: next });
      setNotice(outcome);
      // Success = stored, so the trigger label moves now; the reload just
      // confirms it.
      if (outcome.kind === "success") setSelected(next);
    } finally {
      setBusy(false);
    }
  }

  const label = t(locale, "settings.reviewDepth");
  const selectedLabel = options.find((option) => option.value === selected)?.label ?? label;

  return (
    <FlowSection title={label} subtitle={t(locale, "settings.reviewDepthCopy")}>
      <div className="w-fit max-w-xs">
        <Select
          value={selected}
          disabled={busy}
          onValueChange={(value) => {
            if (isReviewDepthChoice(value)) void save(value);
          }}
        >
          <SelectTrigger aria-label={label}>
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NoticeRegion notice={notice} />
    </FlowSection>
  );
}

/**
 * One danger-zone row: the control's title and what it does to deliveries on
 * the left, the control itself on the right. The row explains the action; the
 * confirm dialog (owned by the page) explains what happens if you proceed.
 */
function OpsRow({ title, copy, children }: { title: string; copy: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3 pb-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{copy}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * The destructive ops zone (the plan's "danger zone"): pause/resume,
 * disable/enable and the soft delete — each one confirm-gated through the
 * page's dialog, each one keeping its existing POST target and semantics.
 * The confirmed outcome renders in this section's own region.
 */
export function OpsSection({
  locale,
  payload,
  onPending,
  notice,
  botWritable,
}: {
  locale: SpaBoot["locale"];
  payload: TargetReviewSlice;
  onPending: (action: PendingAction) => void;
  /** The confirmed ops outcome (pause/resume/disable/enable/delete — delete carries its own copy). */
  notice: OpNotice | null;
  /**
   * Whether the bot's own lifecycle is this workspace's to drive. A Blocked
   * target keeps the pause and the park (target-owned); the bot's
   * disable/enable/delete would be refused by the server, so they never render.
   */
  botWritable: boolean;
}) {
  const { app } = payload;
  const paused = isPaused(app);
  // A disconnected App has no review state to pause: the section summary
  // carries that state, and the first row drops out.
  return (
    <FlowSection
      title={t(locale, "settings.ops")}
      subtitle={t(locale, app.status === "active" ? "settings.opsCopy" : "settings.disconnected")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col divide-y divide-(--border-subtle)">
          {app.status === "active" ? (
            <OpsRow title={t(locale, "settings.opsReviewsTitle")} copy={t(locale, "settings.opsReviewsCopy")}>
              {paused ? (
                <Button type="button" onClick={() => onPending({ kind: "resume" })}>
                  {t(locale, "settings.resumeReviews")}
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => onPending({ kind: "pause" })}>
                  {t(locale, "settings.pauseReviews")}
                </Button>
              )}
            </OpsRow>
          ) : null}
          {botWritable ? (
            <OpsRow title={t(locale, "settings.opsDeliveryTitle")} copy={t(locale, "settings.opsDeliveryCopy")}>
              {app.status === "active" ? (
                <Button type="button" variant="destructive-outline" onClick={() => onPending({ kind: "disable" })}>
                  {t(locale, "apps.actions.disable")}
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => onPending({ kind: "enable" })}>
                  {t(locale, "apps.actions.enable")}
                </Button>
              )}
            </OpsRow>
          ) : null}
          {payload.owner_overlap ? (
            // Park is the repair for an overlapping owner claim, and the route
            // refuses it when the claim no longer overlaps — so the control
            // renders only while the payload proves it would land.
            <OpsRow title={t(locale, "settings.opsParkTitle")} copy={t(locale, "settings.opsParkCopy")}>
              <Button type="button" variant="destructive-outline" onClick={() => onPending({ kind: "park" })}>
                {t(locale, "settings.opsParkAction")}
              </Button>
            </OpsRow>
          ) : null}
          {botWritable ? (
            <OpsRow title={t(locale, "settings.opsDeleteTitle")} copy={t(locale, "settings.opsDeleteCopy")}>
              <Button type="button" variant="destructive" onClick={() => onPending({ kind: "delete" })}>
                {t(locale, "apps.actions.delete")}
              </Button>
            </OpsRow>
          ) : null}
        </div>
        <NoticeRegion notice={notice} />
      </div>
    </FlowSection>
  );
}

/** Server-side cap (src/dashboard/index.ts WORKSPACE_NAME_MAX_LENGTH). */
const NAME_MAX_LENGTH = 80;

/**
 * The rename's ONE save pipeline: PUT the name and, on success, patch the live
 * membership list the top-bar switcher reads (`option.name`), so the label
 * changes without a reload. The URL is the workspace's immutable `id`, so
 * nothing navigates and no history entry changes.
 */
export async function submitWorkspaceName(
  name: string,
  locale: SpaBoot["locale"],
  rename: (ref: string | null, name: string) => void,
): Promise<OpNotice> {
  let status: number;
  let body: string;
  try {
    ({ status, body } = await putJson(`${apiBase()}/api/settings/name`, { name }));
  } catch {
    // Nothing landed, so nothing to patch: the list stays as it is.
    return { kind: "error", message: t(locale, "workspace.nameFailed") };
  }
  const outcome = settingsOpOutcome(locale, status, body, t(locale, "workspace.nameSaved"));
  // Only a landed write relabels the switcher; a refusal leaves the list alone.
  if (outcome.kind === "success") rename(workspaceRefOf(window.location.pathname), name);
  return outcome;
}

/**
 * Renames the workspace — owner-only, enforced by the server (the page gates
 * on the role before rendering it). Its value is the workspace's STORED name,
 * resolved through the live membership list, so a value captured at mount
 * cannot go stale. The control has no path to rewrite: the URL is the id.
 */
export function WorkspaceNameCard({ locale, storedName }: { locale: SpaBoot["locale"]; storedName: string }) {
  // Only what the operator has typed is local; the display falls back to the
  // stored name, so an external change lands without a mount-time copy.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? storedName;
  // Section-local channel: an op outcome never rides the page-level notice.
  const [nameNotice, setNameNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  // The save rides the button: the signal drives its face, the success copy
  // survives as assistive text beside it — never as a notice box.
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
  const renameMembership = useRenameMembership();

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    const next = name.trim();
    if (next.length === 0) {
      setNameNotice({ kind: "error", message: t(locale, "workspace.nameRequired") });
      return;
    }
    if (next.length > NAME_MAX_LENGTH) {
      setNameNotice({ kind: "error", message: t(locale, "workspace.nameTooLong", { max: NAME_MAX_LENGTH }) });
      return;
    }
    setBusy(true);
    signal.start();
    setNameNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await submitWorkspaceName(next, locale, renameMembership);
      if (outcome.kind === "success") {
        setDraft(null);
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNameNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowSection
      title={t(locale, "workspace.nameHeading")}
      subtitle={t(locale, "workspace.nameDescription")}
    >
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void onSubmit(event)}>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="workspace-name">
            {t(locale, "workspace.nameLabel")}
          </label>
          <Input
            id="workspace-name"
            className="w-64"
            autoComplete="off"
            value={name}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy} status={signal.status === "idle" ? undefined : signal.status}>
          {t(locale, "workspace.nameSave")}
        </Button>
        <SaveInFlight show={signal.status === "loading"} locale={locale} />
        {signal.status === "success" && savedCopy !== null ? (
          <span role="status" className="sr-only">
            {savedCopy}
          </span>
        ) : null}
      </form>
      <NoticeRegion notice={nameNotice} />
    </FlowSection>
  );
}

/**
 * One integer setting of the current workspace: fetch → draft → save → notice,
 * with the degraded-read repair path. The concurrency cap and the review-gate
 * default floor share this shell verbatim, so a fix to the degraded retry, the
 * empty-draft guard or the 2xx-with-a-non-JSON body lands once instead of
 * needing a matching edit in two cards.
 */
type NumberSettingCopy = {
  heading: DictionaryKey;
  description: DictionaryKey;
  label: DictionaryKey;
  save: DictionaryKey;
  saved: DictionaryKey;
  failed: DictionaryKey;
  range: DictionaryKey;
  unreadable: DictionaryKey;
};

type NumberSettingValue = { value: number; min: number; max: number; degraded: boolean };

function NumberSettingCard({
  locale,
  getPath,
  putPath,
  payloadKey,
  inputId,
  copy,
  parse,
  parseStored,
}: {
  locale: SpaBoot["locale"];
  getPath: string;
  putPath: string;
  payloadKey: string;
  inputId: string;
  copy: NumberSettingCopy;
  parse: (data: unknown) => NumberSettingValue | null;
  parseStored: (body: string) => number | null;
}) {
  const [loaded, setLoaded] = useState<NumberSettingValue | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // Section-local channel, like the name card's: an op outcome never rides the
  // page-level notice.
  const [cardNotice, setCardNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  // The save rides the button: the signal drives its face, the success copy
  // survives as assistive text beside it — never as a notice box.
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
  // A degraded read starts the field empty and offers two ways out: type a
  // value (the repair write) or re-read.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchJson(`${apiBase()}${getPath}`).then(
      (data) => {
        if (!live) return;
        const parsed = parse(data);
        if (parsed === null) setFailed(true);
        else {
          setFailed(false);
          setLoaded(parsed);
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
    // The parse pair is a per-card constant; only a retry re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || loaded === null) return; // in-flight guard — no double submit
    if (concurrencySubmitBlocked(loaded.degraded, draft)) return;
    // An untouched form must submit the STORED value, never a derived one: the
    // stored number is what the tenant set.
    setBusy(true);
    signal.start();
    setCardNotice(null); // the retry clears this cluster's own stale outcome first
    const submitted = Number((draft ?? String(loaded.value)).trim());
    try {
      const { status, body } = await putJson(`${apiBase()}${putPath}`, {
        [payloadKey]: submitted,
      });
      const outcome = settingsOpOutcome(locale, status, body, t(locale, copy.saved));
      if (outcome.kind === "success") {
        // The stored value is the server's answer, never the typed draft. A
        // landed 2xx whose body is not JSON still stored a value — the write
        // succeeded, so the submitted number stands in for the unreadable one
        // instead of reporting the save as a failure.
        const stored = parseStored(body) ?? submitted;
        // This write is the workspace's own level — the only level this
        // payload's `degraded` reports — so the accepted value is now known
        // and trustworthy: show it and clear the flag.
        setLoaded((previous) => previous && { ...previous, value: stored, degraded: false });
        setDraft(null);
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setCardNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } catch {
      setCardNotice({ kind: "error", message: t(locale, copy.failed) });
      signal.fail();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowSection title={t(locale, copy.heading)} subtitle={t(locale, copy.description)}>
      {failed ? (
        <LoadFailedNotice locale={locale} />
      ) : loaded === null ? (
        <LoadingNotice locale={locale} />
      ) : (
        <div className="flex flex-col gap-3">
          {loaded.degraded ? (
            // The store could not trust the stored value, so the payload's
            // number is a fallback the tenant never chose. The field starts
            // empty and never shows that fallback; a typed value OR the re-read
            // repairs the state.
            <PageNotice
              kind="warn"
              message={t(locale, copy.unreadable, { min: loaded.min, max: loaded.max })}
            />
          ) : null}
          {/* The range line sits outside the row: inside the stack, `items-end`
              would align the button to the hint instead of the input. */}
          <div className="flex flex-col gap-1.5">
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void onSubmit(event)}>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor={inputId}>
                  {t(locale, copy.label)}
                </label>
                <Input
                  id={inputId}
                  type="number"
                  min={loaded.min}
                  max={loaded.max}
                  className="w-32"
                  autoComplete="off"
                  required
                  value={draft ?? (loaded.degraded ? "" : String(loaded.value))}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy} status={signal.status === "idle" ? undefined : signal.status}>
                {t(locale, copy.save)}
              </Button>
              <SaveInFlight show={signal.status === "loading"} locale={locale} />
              {signal.status === "success" && savedCopy !== null ? (
                <span role="status" className="sr-only">
                  {savedCopy}
                </span>
              ) : null}
              {loaded.degraded ? (
                <Button type="button" variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
                  {t(locale, "common.retry")}
                </Button>
              ) : null}
            </form>
            <span className="text-xs text-muted-foreground">
              {t(locale, copy.range, { min: loaded.min, max: loaded.max })}
            </span>
          </div>
        </div>
      )}
      <NoticeRegion notice={cardNotice} />
    </FlowSection>
  );
}

/**
 * The workspace review-concurrency cap — the tenant half of the runtime
 * configuration (iteration spec §1.1). Owner/admin only; the server re-checks
 * the role and validates the value against the workspace's own range only, so
 * this card renders the `min`/`max` the payload carried and never sees the
 * platform quota.
 */
export function WorkspaceConcurrencyCard({ locale }: { locale: SpaBoot["locale"] }) {
  return (
    <NumberSettingCard
      locale={locale}
      getPath="/api/settings/concurrency"
      putPath="/api/settings/concurrency"
      payloadKey="concurrency"
      inputId="workspace-concurrency"
      copy={{
        heading: "workspace.concurrencyHeading",
        description: "workspace.concurrencyDescription",
        label: "workspace.concurrencyLabel",
        save: "workspace.concurrencySave",
        saved: "workspace.concurrencySaved",
        failed: "workspace.concurrencyFailed",
        range: "workspace.concurrencyRange",
        unreadable: "workspace.concurrencyUnreadable",
      }}
      parse={(data) => {
        const parsed = parseConcurrencySettings(data);
        return parsed === null
          ? null
          : { value: parsed.concurrency, min: parsed.min, max: parsed.max, degraded: parsed.degraded };
      }}
      parseStored={parseStoredConcurrency}
    />
  );
}

/**
 * The default review-gate floor for Apps connected later. Owner/admin only,
 * same server gate as the concurrency card. Existing Apps are untouched: this
 * is the value `createApp` seeds, not a backfill.
 */
export function WorkspaceCheckMinScoreCard({ locale }: { locale: SpaBoot["locale"] }) {
  return (
    <NumberSettingCard
      locale={locale}
      getPath="/api/settings/check-min-score"
      putPath="/api/settings/check-min-score"
      payloadKey="min_score"
      inputId="workspace-check-min-score"
      copy={{
        heading: "workspace.checkMinScoreHeading",
        description: "workspace.checkMinScoreDescription",
        label: "workspace.checkMinScoreLabel",
        save: "workspace.checkMinScoreSave",
        saved: "workspace.checkMinScoreSaved",
        failed: "workspace.checkMinScoreFailed",
        range: "workspace.checkMinScoreRange",
        unreadable: "workspace.checkMinScoreUnreadable",
      }}
      parse={(data) => {
        const parsed = parseCheckMinScoreSettings(data);
        return parsed === null
          ? null
          : { value: parsed.minScore, min: parsed.min, max: parsed.max, degraded: parsed.degraded };
      }}
      parseStored={parseStoredCheckMinScore}
    />
  );
}

/**
 * POST one pinned ops path and resolve the outcome — the ONE save pipeline for
 * every pinned-ops caller (the trigger-mode save included). Keyed JSON renders
 * localized through the shared resolver, the remove routes' no-change face
 * becomes its warn notice, raw text still displays (fail-visible, never blank),
 * and a transport failure reports the save-failed copy instead of leaving the
 * op silent. `reload` lands the stored value via the awaited background
 * refresh; the delete path skips it (its settings GET is a guaranteed 404).
 */
export async function postPinnedOutcome(
  path: string,
  fields: Record<string, string>,
  locale: SpaBoot["locale"],
  reload: () => Promise<unknown>,
  { successMessage, refetch = true }: { successMessage?: string; refetch?: boolean } = {},
): Promise<OpNotice> {
  let status: number;
  let body: string;
  try {
    ({ status, body } = await postForm(path, fields));
  } catch {
    return { kind: "error", message: t(locale, "common.saveFailed") };
  }
  const outcome = settingsOpOutcome(locale, status, body, successMessage);
  if (refetch) await reload();
  return outcome;
}

/**
 * The review-trigger-mode save: the pinned path and the verbatim mode body,
 * both derived from the App's own page base. The one derivation the control
 * posts, so a test can execute the real save for the real page context
 * instead of supplying an App path of its own.
 */
export function submitTriggerMode(
  appId: string,
  mode: ReviewTriggerMode,
  locale: SpaBoot["locale"],
  reload: () => Promise<unknown>,
): Promise<OpNotice> {
  return postPinnedOutcome(
    `${apiBase()}/apps/${encodeURIComponent(appId)}/review-trigger-mode`,
    { mode },
    locale,
    reload,
  );
}

/**
 * The App's bot-mention string (spec review-trigger-policy §3): the bare
 * `@{slug}` form. The webhook matcher accepts an optional `[bot]` suffix but
 * never requires it, so the hint shows the shortest string that works.
 */
export function botMention(slug: string): string {
  return `@${slug}`;
}

/** Localized segment labels; the wire values stay verbatim (spec §2). */
const REVIEW_TRIGGER_MODE_LABEL_KEYS: Record<ReviewTriggerMode, DictionaryKey> = {
  open: "settings.triggerModeOpen",
  every_push: "settings.triggerModeEveryPush",
  manual: "settings.triggerModeManual",
};

/**
 * Review trigger mode (spec review-trigger-policy §2): the per-App
 * cadence segmented control beside the review toggle, plus the §3 operator
 * visibility — the exact mention string this App answers to. The control
 * saves on selection through the pinned-ops POST family (body `mode`), so a
 * keyed 400 (`settings.error.triggerModeUnknown`) resolves localized via the
 * shared resolver and the awaited background reload lands the stored value.
 * The selection mirrors the payload (the RuntimeHarnessEditor discipline): a
 * failed save reverts to the stored mode once the reload lands. Radix's
 * empty-string deselect (clicking the active segment) is not a mode and
 * never reaches the wire.
 */
export function ReviewTriggerControl({
  locale,
  slug,
  mode,
  onTriggerMode,
}: {
  locale: SpaBoot["locale"];
  /**
   * The cached GitHub slug — the ONLY mention target (D2). Null before the
   * first metadata sync: no real target exists, so no mention renders
   * (fail-safe — an invented `@` target could never trigger a review).
   */
  slug: string | null;
  mode: ReviewTriggerMode;
  onTriggerMode: (mode: ReviewTriggerMode) => Promise<OpNotice>;
}) {
  const [selected, setSelected] = useState<ReviewTriggerMode>(mode);
  const [busy, setBusy] = useState(false);
  // The control's own region: a failure renders here, next to the trigger —
  // never through the card's dialog-ops region above. The trigger group has
  // no button face, so a success confirms through the moved highlight plus
  // the success copy as assistive text — never as a notice box.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);

  // Server-state mirror: after this save's (or any op's) background reload
  // lands a fresh payload, the selection tracks the stored mode — a failed
  // save reverts instead of leaving the optimistic value (the
  // sandbox-image editor's identical effect). The save's own success path
  // echoes first: save() updates the selection only after the POST resolves
  // success (success = stored), so the highlight moves immediately and the
  // reload just confirms it.
  useEffect(() => {
    setSelected(mode);
  }, [mode]);

  async function save(next: string): Promise<void> {
    if (!isReviewTriggerMode(next) || next === selected) return;
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await onTriggerMode(next);
      // Success-path echo: success means stored, so the controlled
      // ToggleGroup highlights the new mode now instead of waiting for the
      // reload; a failure leaves the previous segment highlighted and the
      // reload resyncs `selected` from the stored mode (the effect above).
      if (outcome.kind === "success") {
        setSelected(next);
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  // The mention exists only when GitHub's slug cache does — the bare
  // `@{slug}` form (spec §3), never a local value.
  const mention = slug ? botMention(slug) : null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t(locale, "settings.triggerMode")}</span>
      <div className="w-fit">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={selected}
          disabled={busy}
          onValueChange={(value) => void save(value)}
          aria-label={t(locale, "settings.triggerMode")}
        >
          {REVIEW_TRIGGER_MODES.map((triggerMode) => (
            <ToggleGroupItem key={triggerMode} value={triggerMode} title={triggerMode}>
              {t(locale, REVIEW_TRIGGER_MODE_LABEL_KEYS[triggerMode])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {mention ? (
        <p className="text-xs text-muted-foreground">
          {t(locale, "settings.triggerModeMention")}{" "}
          {/* The mention renders as ONE text node, so a click-drag selects /
              copies the exact string; the plain form rides the title and the
              localized aria label (spec §3 operator visibility). */}
          <code
            className="rounded bg-muted px-1 py-0.5 font-mono text-foreground"
            title={mention}
            aria-label={t(locale, "settings.triggerModeMentionAria", { mention })}
          >
            {mention}
          </code>
        </p>
      ) : null}
      {signal.status === "success" && savedCopy !== null ? (
        <span role="status" className="sr-only">
          {savedCopy}
        </span>
      ) : null}
      <NoticeRegion notice={notice} />
    </div>
  );
}

/**
 * The draft tab's client-side id. A colon can never appear in a
 * stored chain name (MODEL_CHAIN_NAME_PATTERN allows only lowercase letters,
 * digits and hyphens), so the sentinel is collision-free with real tab ids.
 * It never reaches the server — the draft saves under the ENTERED name
 * through op=add-chain.
 */
const DRAFT_CHAIN_TAB_ID = ":draft";

const DRAFT_CHAIN_TAB: ChainTab = { id: DRAFT_CHAIN_TAB_ID, isDefault: false, chain: null };

/**
 * (AD-551): the draft tab's label mirrors the lifted draft name live
 * — a non-blank input shows as-is (trim only gates the fallback), an
 * empty/whitespace name falls back to the static 新链 copy. Pure render: the
 * Radix Tabs controlled value derives from tabs/selectedTab alone, so a
 * label change never touches tab selection.
 */
export function draftChainTabLabel(draftName: string, locale: SpaBoot["locale"]): string {
  return draftName.trim() ? draftName : t(locale, "settings.draftChain");
}

/**
 * The bot's model chains: the Default chain plus every named one, each edited
 * in place. Bot-scoped — rendered on the bot page, never on the target.
 */
export function ChainsSection({
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
  payload: BotConfigSections;
  groups: ModelOptionGroup[];
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  /** Bugbot fix: the draft create — resolves an error when the awaited reload fails, so the panel keeps the draft open. */
  onCreateDraft: (fields: Record<string, string>) => Promise<OpNotice>;
  onRemoveChain: (name: string) => void;
  /** The dialog-confirmed remove-chain outcome. */
  notice: OpNotice | null;
  /** Where the draft panel reports its success (the draft closes, so its panel cannot render it). */
  onOutcome: (notice: OpNotice) => void;
}) {
  // Default and named chains are peer tabs. The selection coerces
  // through activeChainTabId so a delete or a stale payload lands on the
  // non-removable Default tab instead of pointing at a removed chain.
  const [selectedTab, setSelectedTab] = useState<string>(DEFAULT_CHAIN_NAME);
  // `+ 新建链` opens a DRAFT peer tab instead of a disclosure —
  // the create flow is itself a tab, edited in place like every other chain.
  // One boolean of state, so a second draft can never exist while one lives.
  const [draftOpen, setDraftOpen] = useState(false);
  // (AD-551): the draft name is owned HERE so the tab trigger can
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
    <FlowSection
      title={t(locale, "settings.modelChains")}
      subtitle={t(locale, "settings.modelChainsCopy")}
    >
      <div className="flex flex-col gap-6">
        <Tabs value={activeChainTabId(tabs, selectedTab)} onValueChange={setSelectedTab}>
          {/* The add-chain entry keeps its strip placement: a TabsList
              SIBLING (never inside the role=tablist) — outline control, plus
              glyph, localized label. The click no longer toggles a
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
                {/* (review deferral): the panel title rides the SAME
                    SectionCardTitle face as every card title — no second
                    heading-16 spelling at this site. */}
                <SectionCardTitle>{tab.id}</SectionCardTitle>
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
                  // (AD-551): the lifted name no longer dies with the
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
        {/* The section's region: the dialog-confirmed remove and the
            draft's forwarded save success render here, below every tabpanel —
            the editors themselves render their save outcomes in-panel. */}
        <NoticeRegion notice={notice} />
      </div>
    </FlowSection>
  );
}

/**
 * Seats: the role → chain mapping is its own card below chain
 * management, independent of the chain tabs. Every select offers Default
 * first, then the current named chains from the same tab model; a
 * stored name that no longer resolves (deleted chain, stale payload) renders
 * and saves as Default, so op=save-roles never submits an invalid reference.
 * The save stays the route's full-map contract: one role_<role> field per
 * audit seat, always all seats.
 */
/** The seat → chain assignment: which chain each review role selects from. */
export function SeatsSection({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: BotConfigSections;
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

  // The seat save rides its button; a failure reports in this card, under
  // its own trigger, and the success copy survives as assistive text.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const fields: Record<string, string> = { op: "save-roles" };
      for (const role of payload.model_role_ids) {
        fields[`role_${role}`] = seatSelectValue(tabs, seats[role]);
      }
      const outcome = await onSettings(fields);
      if (outcome.kind === "success") {
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowSection title={t(locale, "settings.seats")} subtitle={t(locale, "settings.seatsCopy")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {payload.model_role_ids.map((role) => (
          <label key={role} className="flex w-fit flex-col gap-1.5 text-sm font-medium">
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
        <div>
          <Button type="submit" disabled={busy} status={signal.status === "idle" ? undefined : signal.status}>
            {t(locale, "settings.saveRoleModels")}
          </Button>
          <SaveInFlight show={signal.status === "loading"} locale={locale} />
          {signal.status === "success" && savedCopy !== null ? (
            <span role="status" className="sr-only">
              {savedCopy}
            </span>
          ) : null}
        </div>
        <NoticeRegion notice={notice} />
      </form>
    </FlowSection>
  );
}

/**
 * The draft chain tab's panel (the shared editor pattern): the
 * full editor inside its own tabpanel — the name field first, then the model
 * builder (the components a named chain's panel uses verbatim). 保存 posts
 * the unchanged op=add-chain with the entered name + built chain; a rejected
 * create — or a create whose awaited background reload failed — renders its
 * error INLINE through ChainEditor's own region (role=
 * alert, inside this panel) and keeps the draft + typed input; only success
 * (POST ok AND reload landed) hands the trimmed stored name back so the real
 * tab is selected, forwarding the saved outcome to the card's region (the
 * panel is about to unmount). 放弃 discards the draft without confirmation
 * (documented; matches the accepted disclosure-discard behavior) — the
 * selection coerces through activeChainTabId once the draft tab is gone. The
 * busy gate covers both triggers while the create POST is in flight, so a
 * discard can never race a resolving save into selecting the created tab.
 * (AD-551): the draft name is controlled — owned by ChainsSection so
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
  /** (AD-551): the controlled draft name, owned by ChainsSection. */
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
      {/* (review deferral): the draft panel's own visible face —
          the name field is the panel's identity header, so it renders as a
          compact header block (w-fit + w-64, the invite-input idiom) instead
          of a full-width stretch. The named panels open [identity title] +
          [editor]; the draft opens [identity field] + [editor] — one rhythm.
          The controlled wiring below is the pinned AD-551 surface, untouched. */}
      <label className="flex w-fit flex-col gap-1.5 text-sm font-medium">
        {t(locale, "settings.chainName")}
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={t(locale, "settings.chainNamePlaceholder")}
          autoComplete="off"
          maxLength={64}
          className="w-64"
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
              // setState-after-unmount no-op (QC fix round, F-001).
              setBusy(false);
            });
        }}
        saveLabel={t(locale, "settings.saveChain")}
        actions={
          // (AD-552): 放弃 joins the save row instead of the old
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
  /** Resolves the save outcome; rendered in this editor's region. */
  onSave: (chain: string) => Promise<OpNotice>;
  saveLabel?: string;
  /**
   * (AD-552): caller actions rendered in the control row, right of the
   * save button (pure render insertion — save semantics, the busy gate and
   * the outcome region are untouched). Absent, the row carries the picker,
   * the add button and the save button only (Default / named-chain editors).
   */
  actions?: ReactNode;
}) {
  const [chain, setChain] = useState(() => splitModelChain(stored));
  const [pick, setPick] = useState<string | undefined>(undefined);
  // Each editor instance owns its region — a failed chain save renders
  // inside its own tabpanel (the user-reported 400 case), never on the page
  // top; the success rides the save button, its copy surviving as assistive
  // text. The next save replaces the content (replace-on-submit).
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
  const probeProviders = groups.filter((group) => group.source === "probe");

  useEffect(() => {
    setChain(splitModelChain(stored));
  }, [stored]);

  async function save(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null); // the retry clears this cluster's own stale outcome first
    try {
      const outcome = await onSave(chain.join(", "));
      if (outcome.kind === "success") {
        setSavedCopy(outcome.message);
        signal.succeed();
      } else {
        setNotice(outcome);
        if (outcome.kind === "error") signal.fail();
      }
    } finally {
      setBusy(false);
    }
  }

  const saveButton = (
    <>
      <Button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        status={signal.status === "idle" ? undefined : signal.status}
      >
        {saveLabel ?? t(locale, "settings.saveChain")}
      </Button>
      <SaveInFlight show={signal.status === "loading"} locale={locale} />
      {signal.status === "success" && savedCopy !== null ? (
        <span role="status" className="sr-only">
          {savedCopy}
        </span>
      ) : null}
    </>
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
            <li
              key={`${selector}-${index}`}
              className="flex items-center justify-between gap-2 rounded-(--radius-control) border border-(--border-default) bg-(--surface-inset) px-3 py-2"
            >
              <span className="font-mono text-sm">{selector}</span>
              {/* (review deferral): removing a selector edits
                  the UNSAVED local list — recoverable by re-picking, no
                  dialog, no server op — so it rides the AD-552 local-edit
                  face (outline + sm, the discard idiom). The destructive red
                  stays reserved for confirm-gated stored-data removals. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setChain(chain.filter((_, i) => i !== index))}
              >
                {t(locale, "settings.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* One control row (the RuntimeHarnessEditor shape): the picker keeps
          its content-adaptive shell — no reserved slot — and the add, save and
          caller actions sit beside it at their intrinsic widths, wrapping
          below cleanly on narrow screens. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t(locale, "settings.modelChainField")}</span>
        <div className="w-fit max-w-xs">
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
        {saveButton}
        {actions}
      </div>
      <NoticeRegion notice={notice} />
    </div>
  );
}
