import { useEffect, useRef, useState, type SubmitEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Plus } from "lucide-react";
import { isDictionaryKey, t, type DictionaryKey } from "../../i18n";
import {
  Button,
  CardContent,
  CardDescription,
  CardHeader,
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
} from "@design-system";
import { AppAvatar } from "../components/AppAvatar";
import { AppInstallIdentity, appInstallHref } from "../components/AppInstallIdentity";
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
  configuredKeySlot,
  DEFAULT_CHAIN_NAME,
  isPaused,
  concurrencySubmitBlocked,
  modelChainTabs,
  parseCheckMinScoreSettings,
  parseConcurrencySettings,
  parseStoredCheckMinScore,
  parseStoredConcurrency,
  removeChanged,
  REVIEW_LEVELS,
  seatRoleValues,
  seatSelectValue,
  splitModelChain,
  chainRowKey,
  moveChainEntry,
  type ChainTab,
  type BotConfigSections,
  type ModelOptionGroup,
  type ReviewLevel,
  type AppIdentityCardApp,
  type AppInstallApp,
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
  | { kind: "pause" | "resume" | "disable" | "enable" | "delete" }
  | { kind: "share" | "unshare" }
  | { kind: "remove-chain"; name: string }
  | { kind: "remove-key"; provider: string; keyId: string; last4: string }
  | { kind: "remove-custom"; providerId: string };

function verifyReasonMessage(locale: SpaBoot["locale"], reason: string): string {
  if (reason === "invalid_key") return t(locale, "settings.verify.invalid_key");
  if (reason === "quota_exhausted") return t(locale, "settings.verify.quota_exhausted");
  if (reason === "rate_limited") return t(locale, "settings.verify.rate_limited");
  if (reason === "unreachable") return t(locale, "settings.verify.unreachable");
  if (reason === "unsupported_provider") return t(locale, "settings.verify.unsupported_provider");
  return t(locale, "settings.verify.unexpected");
}

function isParamValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function paramsInterpolable(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every(isParamValue))
  );
}

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
      const reason = parsed?.reason;
      return typeof reason === "string"
        ? verifyReasonMessage(locale, reason)
        : t(locale, "settings.providers.addKeyRefused");
    }
    case 403:
      return t(locale, "settings.providers.addKeyForbidden");
    case 404:
      return t(locale, "settings.providers.addKeyUnknownApp");
    case 409:
      return t(locale, "settings.providers.addKeyConflict");
    case 429:
      return t(locale, "settings.providers.addKeyRateLimited");
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
    if (typeof parsed.key === "string" && isDictionaryKey(parsed.key)) {
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
  if (status < 200 || status >= 300) {
    return { kind: "error", message: settingsErrorMessage(locale, body) };
  }
  if (removeChanged(body) === false) {
    return { kind: "warn", message: t(locale, "settings.removeNoChange") };
  }
  return { kind: "success", message: successMessage ?? t(locale, "settings.changesSaved") };
}

/**
 * The identity-only App settings face: the GitHub identity card and nothing
 * else. Every manager face and every review-policy control lives on the pages
 * that own them (the App page's bot sections, the repository surface's target
 * policy), so this body has no manager branch to fall through to — the App the
 * caller names is not writable from here whatever the payload says.
 */
export function SettingsView({
  locale,
  payload,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
}) {
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

/** The dialog copy for a confirmed action — shared with the bot page's remove actions. */
export function pendingConfirmCopy(
  locale: SpaBoot["locale"],
  name: string,
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
  if (pending.kind === "share") {
    return {
      title: t(locale, "botSettings.confirmShareTitle", { name }),
      body: t(locale, "botSettings.confirmShareBody"),
      action: t(locale, "botSettings.shareAction"),
      destructive: false,
    };
  }
  if (pending.kind === "unshare") {
    return {
      title: t(locale, "botSettings.confirmUnshareTitle", { name }),
      body: t(locale, "botSettings.confirmUnshareBody"),
      action: t(locale, "botSettings.unshareAction"),
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
  app: SettingsIdentityAppMeta | SettingsAppMeta | AppIdentityCardApp | BotSettingsAppMeta;
  workspaceId: string;
  canManage: boolean;
  onReload?: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function refreshMetadata(): Promise<void> {
    setRefreshing(true);
    try {
      const res = await fetch(`${apiBase()}/api/apps/${app.github_app_id}/refresh-metadata`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = await res.text();
      if (!res.ok) {
        const failure: OpNotice = { kind: "error", message: settingsErrorMessage(locale, body) };
        setNotice(failure);
        return;
      }
      const outcome: OpNotice = { kind: "success", message: t(locale, "settings.appInfoRefreshDone") };
      setNotice(outcome);
      await onReload?.();
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setRefreshing(false);
    }
  }
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
          {app.github_app_id === null ? null : (
            <p className="text-sm text-muted-foreground">
              {t(locale, "settings.appInfoAppId", { id: app.github_app_id })}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.appInfoLocalId", { id: app.id })}
          </p>
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
 * Both scopes keep the same plain share link (derived from the cached GitHub
 * slug; an App whose metadata has not synced explains that instead of
 * rendering a dead link). Installing on GitHub is what records the
 * installation — the `installation.created` webhook writes `bot_installations`,
 * and the operator binds it to this target afterwards from the pending list
 * below. The block also names the target's bound installation — its account,
 * and when GitHub no longer has it, that reviews stopped until it comes back.
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
  app: AppInstallApp;
  installation: SettingsManagePayload["installation"];
  pendingInstallations: SettingsManagePayload["pending_installations"];
  blocked: boolean;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const slug = app.github_slug;
  const name = appDisplayName(app);
  const href = appInstallHref(slug);
  const [binding, setBinding] = useState<number | null>(null);
  const [bindFailed, setBindFailed] = useState(false);

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
      const body = JSON.parse(res.body) as { authorize_url?: unknown };
      if (typeof body.authorize_url === "string") {
        window.location.assign(body.authorize_url);
        return;
      }
      await onReload({ background: true });
    } catch {
      setBindFailed(true);
    } finally {
      setBinding(null);
    }
  }

  return (
    <FlowSection title={t(locale, "settings.install")} subtitle={href === null ? undefined : t(locale, "settings.installCopy")}>
      <AppInstallIdentity
        locale={locale}
        name={name}
        avatarSrc={app.github_avatar_url}
        appId={app.github_app_id}
        href={blocked ? null : href}
      >
        {blocked ? null : href === null ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.installNoSlug")}</p>
        ) : app.scope === "shared" && installation === null ? (
          <>
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
        ) : null}
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
      </AppInstallIdentity>
    </FlowSection>
  );
}

/**
 * The bot's installation roster — every installation the settings read
 * carries, one row each, under the same heading and count the header band
 * already names. Both figures come from `installations`, the one array the
 * payload hands this page, so a row can never disagree with the band.
 *
 * The read carries LIVE rows only (`listInstallations` filters
 * `removed_at IS NULL`), and the state column says so instead of leaving the
 * table to read as the App's full install history: an uninstalled installation
 * still has its own face in the install block above (the bound row says
 * reviews stopped), so it is not lost, only out of this roster.
 */
export function AppInstallationsSection({
  locale,
  installations,
}: {
  locale: SpaBoot["locale"];
  installations: BotConfigSections["installations"];
}) {
  const columns: DataTableColumn<BotConfigSections["installations"][number]>[] = [
    {
      header: t(locale, "settings.installationsAccount"),
      cell: (row) => row.account_login ?? t(locale, "common.time.unknown"),
    },
    {
      header: t(locale, "settings.installationsId"),
      cell: (row) => <span className="font-mono tabular-nums">{row.installation_id}</span>,
    },
    {
      header: t(locale, "settings.installationsLastSync"),
      cell: (row) => (
        <span className="text-muted-foreground tabular-nums" title={row.seen_at}>
          {formatRelativeTime(row.seen_at, locale)}
        </span>
      ),
    },
    {
      header: t(locale, "settings.installationsState"),
      cell: () => <StatusBadge tone="success">{t(locale, "settings.installationsLive")}</StatusBadge>,
    },
  ];

  return (
    <FlowSection
      title={t(locale, "settings.installations")}
      subtitle={t(
        locale,
        installations.length === 1 ? "settings.installationsCountOne" : "settings.installationsCount",
        { count: installations.length },
      )}
    >
      <DataTable
        columns={columns}
        rows={installations}
        rowKey={(row) => String(row.installation_id)}
        empty={<p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>}
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
    setNotice(null);
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
  targetOwned,
}: {
  locale: SpaBoot["locale"];
  payload: TargetReviewSlice;
  onPending: (action: PendingAction) => void;
  notice: OpNotice | null;
  botWritable: boolean;
  targetOwned: boolean;
}) {
  const { app } = payload;
  const paused = isPaused(app);
  return (
    <FlowSection
      title={t(locale, "settings.ops")}
      subtitle={t(locale, app.status === "active" ? "settings.opsCopy" : "settings.disconnected")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col divide-y divide-(--border-subtle)">
          {targetOwned && app.status === "active" ? (
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
    return { kind: "error", message: t(locale, "workspace.nameFailed") };
  }
  const outcome = settingsOpOutcome(locale, status, body, t(locale, "workspace.nameSaved"));
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
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? storedName;
  const [nameNotice, setNameNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
  const renameMembership = useRenameMembership();

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
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
    setNameNotice(null);
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
  const [cardNotice, setCardNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || loaded === null) return;
    if (concurrencySubmitBlocked(loaded.degraded, draft)) return;
    setBusy(true);
    signal.start();
    setCardNotice(null);
    const submitted = Number((draft ?? String(loaded.value)).trim());
    try {
      const { status, body } = await putJson(`${apiBase()}${putPath}`, {
        [payloadKey]: submitted,
      });
      const outcome = settingsOpOutcome(locale, status, body, t(locale, copy.saved));
      if (outcome.kind === "success") {
        const stored = parseStored(body) ?? submitted;
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
            <PageNotice
              kind="warn"
              message={t(locale, copy.unreadable, { min: loaded.min, max: loaded.max })}
            />
          ) : null}
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
  onCreateDraft: (fields: Record<string, string>) => Promise<OpNotice>;
  onRemoveChain: (name: string) => void;
  notice: OpNotice | null;
  onOutcome: (notice: OpNotice) => void;
}) {
  const [selectedTab, setSelectedTab] = useState<string>(DEFAULT_CHAIN_NAME);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const storedTabs = modelChainTabs(payload.model_chains);
  const draft = draftOpen ? DRAFT_CHAIN_TAB : null;
  const tabs = draft ? [...storedTabs, draft] : storedTabs;
  const namedTabs = storedTabs.filter((tab) => !tab.isDefault);

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
                  setDraftOpen(false);
                  setDraftName("");
                }}
                onCreated={(created) => {
                  setDraftOpen(false);
                  setDraftName("");
                  setSelectedTab(created);
                }}
              />
            </TabsContent>
          ) : null}
        </Tabs>
        <NoticeRegion notice={notice} />
      </div>
    </FlowSection>
  );
}

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
  const tabIdSetKey = tabs.map((tab) => tab.id).join();
  const [seats, setSeats] = useState<Record<string, string>>(() =>
    seatRoleValues(payload.model_role_ids, payload.model_roles, tabs),
  );

  useEffect(() => {
    setSeats(seatRoleValues(payload.model_role_ids, payload.model_roles, tabs));
  }, [tabIdSetKey]);

  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const signal = useSaveSignal();
  const [savedCopy, setSavedCopy] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    signal.start();
    setNotice(null);
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
        <div className="flex flex-col divide-y divide-(--border-subtle)">
          {payload.model_role_ids.map((role) => (
            <label
              key={role}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3 pb-3 text-sm font-medium first:pt-0 last:pb-0"
            >
              <span>
                {role} — {roleHint(role)}
              </span>
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
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
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
  name: string;
  onNameChange: (name: string) => void;
  onCreate: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
  onDiscard: () => void;
  onCreated: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-3">
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
              if (outcome.kind === "success") {
                onOutcome(outcome);
                onCreated(name.trim());
              }
              return outcome;
            })
            .finally(() => {
              setBusy(false);
            });
        }}
        saveLabel={t(locale, "settings.saveChain")}
        actions={
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
  onSave: (chain: string) => Promise<OpNotice>;
  saveLabel?: string;
  actions?: ReactNode;
}) {
  const [chain, setChain] = useState(() => splitModelChain(stored));
  const [pick, setPick] = useState<string | undefined>(undefined);
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
    setNotice(null);
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
              key={chainRowKey(chain, index)}
              className="flex items-center justify-between gap-2 rounded-(--radius-control) border border-(--border-default) bg-(--surface-inset) px-3 py-2"
            >
              <span className="font-mono text-sm">{selector}</span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={t(locale, "settings.moveChainUp")}
                  disabled={index === 0}
                  onClick={() => setChain(moveChainEntry(chain, index, -1))}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={t(locale, "settings.moveChainDown")}
                  disabled={index === chain.length - 1}
                  onClick={() => setChain(moveChainEntry(chain, index, 1))}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setChain(chain.filter((_, i) => i !== index))}
                >
                  {t(locale, "settings.remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-sm font-medium">{t(locale, "settings.modelChainField")}</span>
        <div className="w-fit max-w-xs min-w-0">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className="max-w-full" aria-label={t(locale, "settings.modelChainField")}>
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
