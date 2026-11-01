import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { isDictionaryKey, t, type DictionaryKey } from "../../i18n";
import { APP_VERSION } from "../../version";
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
import { postForm, putJson } from "../api";
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
  isReviewTriggerMode,
  modelChainTabs,
  removeChanged,
  REVIEW_TRIGGER_MODES,
  seatRoleValues,
  seatSelectValue,
  splitModelChain,
  type ChainTab,
  type ModelOptionGroup,
  type ReviewTriggerMode,
  type SettingsAppMeta,
  type SettingsIdentityAppMeta,
  type SettingsManagePayload,
  type SettingsPayload,
} from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";
import { ProvidersSection } from "./settings-providers";

export type PendingAction =
  | { kind: "pause" | "resume" | "disable" | "enable" | "delete" }
  | { kind: "remove-chain"; name: string }
  | { kind: "remove-key"; provider: string; keyId: string; last4: string }
  | { kind: "remove-custom"; providerId: string };

/**
 * The 应用设置 tab body of the App detail page (App detail IA):
 * a pure-ish presentational component — the data load, the page notice
 * channel, and the loading/error faces live on the AppDetailPage shell,
 * which threads the parsed payload, the model groups, the reload
 * callback, and the banner notice down here. The version footer stays
 * part of the settings tab; page wayfinding (the back link) moved to
 * the AppDetailPage shell.
 */
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
    // Mapped 400s carry a machine-readable key plus the
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

/**
 * Resolve a settings/pinned POST response to its op outcome: a mapped 4xx
 * resolves through the keyed resolver; a 2xx whose body reports
 * `changed: false` — the remove routes' tolerant no-op, where the row was
 * already gone — is a WARNING carrying the localized no-change copy, never
 * "Changes saved."; every other 2xx is the caller's success copy.
 */
function settingsOpOutcome(
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

export function SettingsView({
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
  // Every pinned path of this page hangs off the page's workspace prefix
  // (`/dashboard` legacy, `/dashboard/<slug>` under strict) — the legacy App
  // route family answers 404 on a workspace-scoped deployment.
  const appPath = `${apiBase()}/apps/${app.github_app_id}`;
  const base = `${appPath}/settings`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  // Dialog-confirmed ops report into the card that owns the
  // action (one notice state per card region). Form-submit outcomes render
  // through their own form-local regions instead and never pass through here.
  // The providers card's state keeps only the add-flow (verify /
  // template) outcomes — the dialog-confirmed removes moved to the row-local
  // outcome below.
  const [opsNotice, setOpsNotice] = useState<OpNotice | null>(null);
  const [providersNotice, setProvidersNotice] = useState<OpNotice | null>(null);
  const [chainsNotice, setChainsNotice] = useState<OpNotice | null>(null);
  // (audit UI-45-05): remove-key / remove-custom outcome plus the
  // removed row's position. The slot is captured from the pre-POST payload in
  // onConfirm — the awaited background reload drops the row from
  // the payload before the outcome resolves, so the position must be
  // remembered for the card to render the feedback where the row was.
  const [providersRemoveOutcome, setProvidersRemoveOutcome] = useState<{
    notice: OpNotice;
    slot: number;
  } | null>(null);

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
  async function submitSettings(fields: Record<string, string>): Promise<OpNotice & { reloaded: boolean }> {
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
   * The draft create's completion check (the bugbot fix): POST success
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

  // Resolves whether the key was verified AND stored. The refresh
  // after the POST is a background reload (the card tree stays mounted), so a
  // failed verify keeps the add panel open with the typed key for correction
  // while the provider stays unconfigured; only success resets/closes the
  // form via onDone. The structured reason rides the providers card's region.
  async function submitVerify(fields: Record<string, string>): Promise<OpNotice> {
    let status: number;
    let body: string;
    // The catch guards only the verify POST — a background reload never
    // rejects: load() catches its own failures into the page notice.
    try {
      ({ status, body } = await postForm(
        `${apiBase()}/api/apps/${encodeURIComponent(String(app.github_app_id))}/keys/verify`,
        fields,
      ));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed") };
    }
    if (status >= 400) {
      let reason = "unexpected";
      // (CARRY-2): the eligibility rejection additionally carries
      // the keyed face — prefer the mapped key so the runtime-harness cause
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

  async function runPinned(path: string, fields: Record<string, string> = {}): Promise<OpNotice> {
    return postPinnedOutcome(path, fields, locale, () => onReload({ background: true }));
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
    // The remove actions originate solely from the manage face's
    // ProvidersSection; the read-only face can never reach a confirm, so the
    // empty fallback here is unreachable in practice.
    const configured = payload.can_manage ? payload.configured_providers : [];
    setBusy(true);
    try {
      if (action.kind === "remove-chain") {
        setChainsNotice(await submitSettings({ op: "remove-chain", name: action.name }));
      } else if (action.kind === "remove-custom") {
        // (audit UI-45-05): the remove outcome renders row-locally,
        // so it carries the row's position — captured from the pre-POST
        // payload, because the awaited background reload drops the
        // row before the outcome resolves. A dialog-confirmed row is always
        // found; the length fallback keeps the outcome visible at the list's
        // end instead of dropping it.
        const slot = configured.findIndex((row) => row.kind === "custom" && row.provider_id === action.providerId);
        setProvidersRemoveOutcome({
          notice: await submitSettings({ op: "remove-custom-provider", provider_id: action.providerId }),
          slot: slot >= 0 ? slot : configured.length,
        });
      } else if (action.kind === "remove-key") {
        // Same position capture as remove-custom (see above) — the row is the
        // identity's, so a pool with a sibling key keeps it.
        const slot = configuredKeySlot(configured, action.provider, action.keyId);
        setProvidersRemoveOutcome({
          notice: await runPinned(`${base}/key/delete`, {
            provider: action.provider,
            key_id: action.keyId,
          }),
          slot: slot >= 0 ? slot : configured.length,
        });
      } else if (action.kind === "delete") {
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

  // Version footer: the deployment's current release from the
  // generated src/version.ts surface — the same `vX.Y.Z` form as the
  // /healthz field and release tags, so dashboard, health endpoint and
  // tag reconcile by eye. Static build-time value.
  const versionFooter = (
    <p className="text-sm text-muted-foreground">
      {t(locale, "settings.footer.version", { version: `v${APP_VERSION}` })}
    </p>
  );

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
        {versionFooter}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Detail-page section flow (r3 baseline § 5): one content plane divided
          by hairlines instead of one framed card per section. Sections are
          direct siblings so FlowSection's first/last edge trimming applies.
          Order and membership are the plan's: identity, installations,
          runtime & harness, configuration (providers, chains), seats, and the
          destructive ops zone. Every field, action and data flow is unchanged. */}
      <div className="flex flex-col">
        <AppInfoSection
          locale={locale}
          app={app}
          workspaceId={payload.workspace_id}
          canManage={payload.can_manage}
          onReload={() => onReload({ background: true })}
        />

        <InstallationsSection locale={locale} payload={payload} />

        <RuntimeHarnessSection
          locale={locale}
          payload={payload}
          onSettings={submitSettings}
          onTriggerMode={runTriggerMode}
        />

        <ProvidersSection
          locale={locale}
          payload={payload}
          onVerify={submitVerify}
          onSettings={submitSettings}
          onPending={setPending}
          notice={providersNotice}
          removeOutcome={providersRemoveOutcome}
          onOutcome={setProvidersNotice}
        />

        <ChainsSection
          locale={locale}
          payload={payload}
          groups={groups}
          onSettings={submitSettings}
          onCreateDraft={createDraftChain}
          onRemoveChain={(name) => setPending({ kind: "remove-chain", name })}
          notice={chainsNotice}
          onOutcome={setChainsNotice}
        />

        <SeatsSection locale={locale} payload={payload} onSettings={submitSettings} />

        <OpsSection locale={locale} payload={payload} onPending={setPending} notice={opsNotice} />
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
      {versionFooter}
    </div>
  );
}

function pendingConfirmCopy(
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
  /** Both faces — the identity and manage app shapes structurally share every field the card reads. */
  app: SettingsIdentityAppMeta | SettingsAppMeta;
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
 * Installations — the App's `installations[]` rows (manager settings payload
 * only) as a table, plus the delivery health they explain: the last webhook
 * and the recent deliveries. One row is one installation, and its facts are
 * exactly `account_login`, `installation_id` and `seen_at` — the payload
 * carries no per-installation repository count, so no repository column
 * exists (dashboard surface pass, 2026-11-01; compass D13).
 */
export function InstallationsSection({
  locale,
  payload,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
}) {
  const { app, installations } = payload;
  const columns: DataTableColumn<SettingsManagePayload["installations"][number]>[] = [
    {
      header: t(locale, "settings.installationsAccount"),
      cell: (inst) => inst.account_login ?? t(locale, "common.time.unknown"),
    },
    {
      header: t(locale, "settings.installationsId"),
      cell: (inst) => <span className="font-mono tabular-nums">{inst.installation_id}</span>,
    },
    {
      header: t(locale, "settings.installationsLastSync"),
      cell: (inst) => (
        <span className="text-muted-foreground tabular-nums">
          {formatRelativeTime(inst.seen_at, locale)}
        </span>
      ),
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
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.lastWebhook", { time: formatRelativeTime(app.last_webhook_at, locale) })}
        {payload.delivery_summary && payload.delivery_summary.rejected24h > 0 ? (
          // The refusal count is the failure this line reports, so it wears the
          // alert token; the last-webhook prose beside it stays muted.
          <>
            {" · "}
            <span className="text-(--tone-danger-fg)">
              {t(locale, "apps.health.rejected24h", { count: payload.delivery_summary.rejected24h })}
            </span>
          </>
        ) : null}
      </p>
      <DataTable
        columns={columns}
        rows={installations}
        rowKey={(inst) => String(inst.installation_id)}
        empty={<p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>}
      />
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t(locale, "settings.recentDeliveries")}</h3>
        <p className="text-sm text-muted-foreground">{t(locale, "settings.recentDeliveriesCopy")}</p>
        {payload.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noDeliveries")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
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
    </FlowSection>
  );
}

/**
 * Runtime & harness: how this App's reviews run — the review trigger cadence
 * (spec review-trigger-policy §2/§3, with the exact mention string) and the
 * runtime-harness selection (the harness mounted into the sandbox image).
 * Manage face only: the identity-only non-manager payload carries neither a
 * `sandbox_image_id` nor a save path, so it renders the read-only line.
 * The payload carries registry ids only — never image-local configuration
 * or secrets.
 */
export function RuntimeHarnessSection({
  locale,
  payload,
  onSettings,
  onTriggerMode,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  /** The review-trigger-mode save (the mode control's POST, resolved back to its own region). */
  onTriggerMode: (mode: ReviewTriggerMode) => Promise<OpNotice>;
}) {
  return (
    <FlowSection
      title={t(locale, "settings.runtimeHarness")}
      subtitle={t(locale, "settings.runtimeHarnessCopy", { id: payload.app.sandbox_image_id })}
    >
      {payload.can_manage ? (
        <>
          <ReviewTriggerControl
            locale={locale}
            slug={payload.app.github_slug}
            mode={payload.app.review_trigger_mode}
            onTriggerMode={onTriggerMode}
          />
          <RuntimeHarnessEditor locale={locale} payload={payload} onSettings={onSettings} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(locale, "settings.runtimeHarnessValue", { id: payload.app.sandbox_image_id })}
        </p>
      )}
    </FlowSection>
  );
}

function RuntimeHarnessEditor({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const [selected, setSelected] = useState(payload.app.sandbox_image_id);
  // The save outcome renders in this card, next to the trigger —
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
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {t(locale, "settings.saveRuntimeHarness")}
        </Button>
      </div>
      <NoticeRegion notice={notice} />
    </div>
  );
}

/**
 * The destructive ops zone (the plan's "danger zone"): pause/resume,
 * disable/enable and the soft delete — each one confirm-gated through the
 * page's dialog, each one keeping its existing POST target and semantics.
 * The confirmed outcome renders in this section's own region.
 */
function OpsSection({
  locale,
  payload,
  onPending,
  notice,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onPending: (action: PendingAction) => void;
  /** The confirmed ops outcome (pause/resume/disable/enable/delete — delete carries its own copy). */
  notice: OpNotice | null;
}) {
  const { app } = payload;
  const paused = isPaused(app);
  return (
    <FlowSection title={t(locale, "settings.ops")} subtitle={t(locale, "settings.opsCopy")}>
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
    try {
      const outcome = await submitWorkspaceName(next, locale, renameMembership);
      if (outcome.kind === "success") setDraft(null);
      setNameNotice(outcome);
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
        <Button type="submit" disabled={busy}>
          {t(locale, "workspace.nameSave")}
        </Button>
      </form>
      <NoticeRegion notice={nameNotice} />
    </FlowSection>
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
 * The App's exact bot-mention string (spec review-trigger-policy §3):
 * the canonical GitHub form `@{slug}[bot]`. Typing this in a PR comment
 * (re-)starts a review in every trigger mode.
 */
export function botMention(slug: string): string {
  return `@${slug}[bot]`;
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
   * (fail-safe — an invented `@[bot]` could never trigger a review).
   */
  slug: string | null;
  mode: ReviewTriggerMode;
  onTriggerMode: (mode: ReviewTriggerMode) => Promise<OpNotice>;
}) {
  const [selected, setSelected] = useState<ReviewTriggerMode>(mode);
  const [busy, setBusy] = useState(false);
  // The control's own region: this save's outcome renders here, next to
  // the trigger — never through the card's dialog-ops region above.
  const [notice, setNotice] = useState<OpNotice | null>(null);

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
    try {
      const outcome = await onTriggerMode(next);
      setNotice(outcome);
      // Success-path echo: success means stored, so the controlled
      // ToggleGroup highlights the new mode now instead of waiting for the
      // reload; a failure leaves the previous segment highlighted and the
      // reload resyncs `selected` from the stored mode (the effect above).
      if (outcome.kind === "success") setSelected(next);
    } finally {
      setBusy(false);
    }
  }

  // The mention exists only when GitHub's slug cache does — the string is
  // the canonical `@{slug}[bot]` form (spec §3), never a local value.
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

function ChainsSection({
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
function SeatsSection({
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

  // The seat save reports in this card, under its own trigger.
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
          <Button type="submit" disabled={busy}>{t(locale, "settings.saveRoleModels")}</Button>
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
  // Each editor instance owns its region — a chain save's outcome
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
