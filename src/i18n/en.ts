/**
 * English dictionary — the i18n source of truth.
 *
 * Contract:
 *   - `Dictionary` is derived from this object via `typeof en`; `zh-CN.ts`
 *     is typed as `Dictionary`, so a missing (or extra) key is a compile
 *     error. The runtime key-set parity test in tests/i18n/i18n.test.ts is
 *     the belt-and-suspenders check.
 *   - Values are PLAIN TEXT (no HTML entities, no markup). Consumers escape
 *     before rendering — SSR pages via escapeHtml, the SPA via JSX.
 *   - `{placeholder}` tokens are interpolated by `t(locale, key, params)`.
 *   - This is the single string table for the whole dashboard: later
 *     feature work APPENDs keys here — they never start a
 *     second table.
 *   - The `notice` slot mirrors the `PageNotice` type (kind × message);
 *     after the dead-key purges it carries only the member-flow
 *     messages (the retired SSR settings routes rendered plain text).
 *   - Manifest copy deliberately carries no deployment-level review switch
 *     copy (per-App pause is the only switch).
 */
export const en = {
  nav: {
    brand: "Morning Star Inspector",
    primary: "Primary navigation",
    apps: "Apps",
    members: "Members",
    settings: "Settings",
    /** Sidebar-footer entry to the platform console (operators on `saas`). */
    platformOperations: "Platform operations",
    /** Label of the OTHER locale — the toggle target (en shows 中文, zh_CN shows EN). */
    language: "中文",
    /** Theme toggle: icon-only button; state + action live in the aria copy. */
    /** {mode} = current effective theme, {target} = the theme clicking switches to. */
    themeToggleAria: "Display theme: {mode}. Activate to switch to {target}.",
    themeDark: "dark",
    themeLight: "light",
    logout: "Logout",
    signedInAs: "Signed in as {name}",
    /** Label of the shell's workspace switcher (the select itself shows names). */
    workspaceSwitcher: "Workspace",
    /** The switcher menu's last row — the workspace-creation entry. */
    newWorkspace: "New workspace",
    /**
     * Why the new-workspace item is disabled (`createWorkspaceBlockedReason:
     * "free_slot"`): this login already holds its one free workspace.
     */
    newWorkspaceBlockedFreeSlot:
      "You already belong to a free workspace — one per login. Delete it, or ask its owner to remove you, then create another.",
    /**
     * Why the new-workspace item is disabled (`createWorkspaceBlockedReason:
     * "flag"`): the operator closed workspace creation platform-wide.
     */
    newWorkspaceBlockedFlag: "Workspace creation is closed on this platform right now.",
  },
  common: {
    pageTitle: "{page} — {brand}",
    time: {
      justNow: "just now",
      minuteAgo: "{count} minute ago",
      minutesAgo: "{count} minutes ago",
      hourAgo: "{count} hour ago",
      hoursAgo: "{count} hours ago",
      dayAgo: "{count} day ago",
      daysAgo: "{count} days ago",
      never: "never",
      unknown: "unknown",
    },
    error: {
      removedTitle: "Access removed",
      removedBody: "Your dashboard access was removed. Ask an admin to re-invite {login}.",
      forbiddenTitle: "Forbidden",
      forbiddenBody:
        "This page is restricted to dashboard admins. You are signed in as {login} — back to /dashboard.",
      notFoundTitle: "Not found",
      notFoundBody:
        "This page does not exist, or it is not available in this workspace. Back to /dashboard.",
      signInErrorTitle: "Sign-in error",
      signInErrorBody:
        "Sign-in failed. {message} No session was created. Return to /dashboard/login to try again.",
    },
    oauth: {
      stateInvalid: "Sign-in could not be verified (bad or expired state).",
      missingCode: "GitHub did not return an authorization code.",
      codeRejected: "GitHub rejected the authorization code.",
      profileFailed: "Could not read your GitHub profile.",
      /** `signup_open` is off: an unknown login cannot create an account. */
      signupClosed: "Sign-up is closed on this platform right now.",
    },
    loading: "Loading…",
    loadFailed: "Could not load this page.",
    saveFailed: "Could not save your changes.",
    cancel: "Cancel",
    retry: "Retry",
  },
  login: {
    heading: "Sign in",
    description: "Use your GitHub account to access the console.",
    signIn: "Sign in with GitHub",
    /** Sign-in is open — no access list stands between here and a workspace. */
    openAccess: "Any GitHub account can sign in — create a workspace, or accept an invitation.",
  },
  notice: {
    success: {
      invited: "Invited {login} — they can accept from this workspace now.",
      removedMember: "Removed {login}.",
      roleChanged: "{login} is now {role}.",
      revoked: "Revoked the invitation for {login}.",
      workspaceDeleted: "Workspace deleted. Its Apps are not reviewed.",
    },
    warn: {
      alreadyMember: "{login} is already a member — nothing changed.",
      invitePending: "{login} already has a pending invitation — nothing changed.",
      workspaceUnavailable: "This workspace is no longer available to you.",
    },
    error: {
      enterLogin: "Enter a GitHub login to invite.",
      invalidLogin: "{login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.",
      inviteFailed: "Could not invite {login} — try again.",
      roleChangeFailed: "Could not change {login}'s role — the member list just changed, try again.",
      removeFailed: "Could not remove {login} — the member list just changed, try again.",
      revokeFailed: "Could not revoke {login}'s invitation — try again.",
    },
  },
  /** App detail page (App detail IA): the two-tab shell. */
  appDetail: {
    backToApps: "Back to Apps",
    tabSettings: "Settings",
    tabInsights: "Insights",
  },
  /**
   * Per-App insights tab (the 洞察 face). The records copy returns with
   * the per-App successor of the retired global insights page — the
   * 7/30/90 window segments and repo filter semantics are unchanged.
   */
  insights: {
    heading: "Review health",
    window: "Window: {label}",
    reviewsTotal: "Reviews: {count}",
    verdicts: "Verdicts: {line}",
    noReviews: "No reviews in this window.",
    findingsBySeverity: "Findings by severity",
    findingsByCategory: "Findings by category",
    trend: "Trend",
    recurringFindings: "Recurring findings",
    noFindings: "No findings in this window.",
    noRecurring: "No recurring findings in this window.",
    finding: "{count} finding",
    findings: "{count} findings",
    review: "{count} review",
    reviews: "{count} reviews",
    lastDay: "last {count} day",
    lastDays: "last {count} days",
    repo: "repo {repo}",
    windowSegment: "Time window",
    daysShort: "{count}d",
    filterRepo: "Repo",
    filterRepoAll: "All",
    uncategorized: "uncategorized",
    seriesReviews: "Reviews",
    seriesFindings: "Findings",
    trendSummary: "In this window: {reviews} · {findings}",
    /** Composed zero-review empty state — no-action variant (reviews arrive via installed Apps). */
    emptyTitle: "No reviews yet",
    emptyDescription: "Insights fill in as your installed GitHub Apps review pull requests.",
  },
  apps: {
    heading: "Apps",
    create: "Create GitHub App",
    /**
     * Why the Create control is disabled. `role`: the caller is not
     * owner/admin of the workspace the page addresses. `workspace`: this
     * deployment carries several workspaces and the page names none.
     */
    createUnavailable: {
      role: "Only a workspace owner or admin can create an App here.",
      workspace: "Open a workspace first — this deployment has more than one, so an App needs to know which it belongs to.",
    },
    /** Composed empty state (EmptyState title + description). */
    emptyTitle: "No Apps yet",
    emptyDescription: "Create GitHub App connects your first one.",
    detail: "Detail",
    appId: "App id {id}",
    by: "by {login}",
    status: {
      active: "active",
      disabled: "disabled",
      paused: "paused",
    },
    actions: {
      pause: "Pause",
      resume: "Resume",
      disable: "Disable (reversible)",
      enable: "Enable",
      delete: "Delete",
    },
    health: {
      delivery: "delivery {time}",
      deliveryNever: "delivery never",
      rejected24h: "{count} rejected in 24h",
      outcome: {
        ok: "OK",
        paused: "Paused",
        ignored: "Ignored",
        rejected: "Rejected",
      },
    },
    tableName: "App",
    tableStatus: "Status",
    tableHealth: "Health",
    tableCreator: "Creator",
    openAria: "Open {slug} detail",
  },
  members: {
    heading: "Members",
    visibleToMembers: "Everyone in this workspace can see who is a member.",
    /** The "This workspace" block — plan, seats and the month's meter. */
    workspaceHeading: "This workspace",
    planLabel: "Plan",
    planFreeHint: "BYOK only",
    membersLabel: "Members",
    memberSeats: "{count} / {limit}",
    slotsLeft: "{count} slots left",
    slotsLeftOne: "{count} slot left",
    noSeatsLeft: "No seats left",
    noMemberLimit: "No limit",
    pendingInviteOne: "{count} pending invitation",
    pendingInvites: "{count} pending invitations",
    reviewAttemptsLabel: "Review attempts this month",
    reviewAttemptsHint: "Counted, not limited.",
    /** Owner-only workspace deletion: entry, confirmation body and refusal. */
    deleteWorkspace: "Delete workspace",
    deleteWorkspaceTitle: "Delete this workspace?",
    deleteWorkspaceBody:
      "This cannot be undone. Members will lose access, pending invites will be cancelled, and Apps in this workspace will no longer be reviewed. A review that has already started is not cancelled.",
    deleteWorkspaceFailed: "Could not delete the workspace — try again.",
    deleteWorkspaceNotOwner: "Only the workspace owner can delete it.",
    inviteLabel: "Invite by GitHub login",
    invitePlaceholder: "e.g. octocat",
    inviteButton: "Invite member",
    roleLabel: "Role",
    tableLogin: "GitHub login",
    tableJoined: "Joined",
    tableExpires: "Expires",
    tableActions: "Actions",
    actionsMenuLabel: "Open actions for {login}",
    makeAdmin: "Change to admin",
    makeMember: "Change to member",
    confirmRoleTitle: "Change {login}'s role?",
    confirmRoleBody: "{login} will become {role}. The change takes effect immediately.",
    confirmRoleButton: "Change role",
    confirmRemoveTitle: "Remove {login}?",
    confirmRemoveBody:
      "{login} will no longer be able to sign in — their session stops working right away. Apps they created stay in place and remain manageable by admins.",
    remove: "Remove",
    pendingHeading: "Pending invitations",
    confirmRevokeTitle: "Revoke {login}'s invitation?",
    confirmRevokeBody: "{login} will not be able to accept this invitation. They can be invited again later.",
    revoke: "Revoke",
    you: "you",
    /** Workspace role vocabulary (`workspace_members.role`), including owner. */
    role: {
      owner: "owner",
      admin: "admin",
      member: "member",
    },
    /** Composed empty state — no-action variant (the invite form is the path). */
    emptyTitle: "No members yet",
    emptyDescription: "Invite the first member with the form above.",
    emptyDescriptionMember: "This workspace has no other members yet.",
  },
  /**
   * Workspace creation — the signed-in landing for a login that belongs to no
   * workspace yet. Sign-in joins nobody, so this is the only path
   * into a first workspace besides accepting an invitation.
   */
  workspace: {
    /** The `/dashboard/<ref>/settings` page title. */
    settingsHeading: "Workspace settings",
    setupHeading: "Create a workspace",
    setupDescription:
      "You are not a member of a workspace yet. Create one and you become its owner — you can invite teammates afterwards.",
    /**
     * The switcher menu's creation dialog: the same POST, opened by
     * a member who already has a workspace — so it cannot claim "no workspace
     * yet", and it makes no plan statement (the surface is not mode-gated).
     */
    createDialogDescription: "Name it and you become its owner — you can invite teammates afterwards.",
    /**
     * The `self-hosted` empty-instance line: this sign-in created the
     * deployment's first account. Absent on `saas` and once `users` is
     * non-empty.
     */
    emptyInstance:
      "This instance has no accounts yet. Your login is now this instance's first account — create a workspace to start.",
    nameLabel: "Workspace name",
    namePlaceholder: "e.g. Acme",
    create: "Create workspace",
    nameRequired: "Enter a workspace name.",
    nameTooLong: "Use at most {max} characters.",
    createFailed: "Could not create the workspace — try again.",
    /** Pending invitations on the creation surface — the invitee's accept path (MF-2). */
    invitesHeading: "Workspace invitations",
    invitesDescription: "Accept an invitation to join that workspace, or create your own below.",
    inviteAccept: "Accept",
    /** {role} = the invited workspace role; {expires} = the relative expiry stamp. */
    inviteMeta: "Invited as {role} — expires {expires}",
    inviteExpired: "This invitation has expired.",
    inviteGone: "This invitation is no longer pending — it may have been revoked.",
    inviteAcceptFailed: "Could not accept the invitation — try again.",
    /** Workspace URL (slug) rename — the settings control and its refusal faces. */
    slugHeading: "Workspace URL",
    slugDescription:
      "The readable part of this workspace's dashboard URL. Lowercase letters, digits and hyphens — not a reserved word, not another workspace's id.",
    slugLabel: "Slug",
    slugSave: "Save slug",
    slugSaved: "Workspace URL updated — the old slug no longer works.",
    slugInvalid: "Use 2–39 lowercase letters, digits or hyphens, starting with a letter or digit.",
    slugReserved: "That word is reserved by the dashboard — pick another slug.",
    slugTaken: "Another workspace already uses that slug — pick another one.",
    slugIsWorkspaceId: "That value is another workspace's id — pick another slug.",
    slugForbidden: "Only the workspace owner can change its URL.",
    slugFailed: "Could not change the workspace URL — try again.",
  },
  /**
   * Platform-operator support (2026-10): the operator's read-only face and the
   * tenant's undismissable grant notice. The notice states who is looking, why,
   * and until when — and offers no action, because the tenant can neither end
   * nor edit a grant.
   */
  support: {
    heading: "Support access",
    readOnly: "You are viewing this workspace under a time-boxed support grant. Everything here is read-only.",
    workspaceId: "Workspace id",
    createdAt: "Created",
    grantsHeading: "Active support grants",
    grantLine: "{login} has support access until {expires} — {reason}",
    tableLogin: "GitHub login",
    tableRole: "Role",
    /** The tenant's always-on notice; not dismissible, carries no action. */
    noticeHeading: "Support access is active",
    noticeLine: "{login} can read this workspace's members until {expires} — {reason}",
    noticeError: "Could not check for active support access.",
    noGrant: "No support access is active.",
  },
  settings: {
    /**
     * (AD-591): section-group eyebrow labels for the two tier
     * zones — app info/status (Tier 1) and configuration (Tier 2).
     */
    group: {
      appInfo: "App info",
      configuration: "Configuration",
    },
    changesSaved: "Changes saved.",
    removeNoChange: "Nothing changed — there was nothing to remove.",
    addKey: "Add key",
    provider: "Model provider",
    apiKey: "API key",
    apiKeyPlaceholder: "Paste the provider API key",
    keyEnding: "key ending {last4}",
    keyTooShort: "key too short to show a tail",
    keyVerifiedAt: "verified {time}",
    keyVerifyFailed: "verification failed",
    updated: "updated {time}",
    remove: "Remove",
    selectProvider: "Search model providers…",
    noProviderMatch: 'No providers match "{query}".',
    modelChainField: "Model chain",
    saveChain: "Save model chain",
    providerId: "Provider id",
    baseUrl: "Base URL",
    api: "API",
    modelIds: "Model ids",
    addCustomProvider: "Add custom provider",
    selectApi: "Select an API…",
    roleHintReviewSeat: "quick + default review seats",
    roleHintDeep: "deep review seat",
    saveRoleModels: "Save seat chains",
    pauseReviews: "Pause reviews",
    resumeReviews: "Resume reviews",
    disconnected: "This App is disconnected — enable it to review.",
    lastWebhook: "Last webhook: {time}",
    noInstallations: "No installations yet.",
    installation: "installation {id}",
    lastSeen: "last seen {time}",
    recentDeliveries: "Recent deliveries",
    recentDeliveriesCopy: "The last 5 webhook deliveries for this App — newest first.",
    noDeliveries: "No deliveries yet.",
    unknownEvent: "unknown event",
    status: "status {code}",
    addToChain: "Add to chain",
    noAutoDiscovery: "This provider does not list models — pick from another verified provider.",
    noVerifiedModels: "Verify a provider key to populate model options.",
    chainEmpty: "No models in the chain yet.",
    pickModel: "Select a model…",
    keyVerified: "Key verified — models cached.",
    verify: {
      invalid_key: "That API key was rejected by the provider — nothing was stored.",
      unreachable: "The provider could not be reached — nothing was stored.",
      unexpected: "The provider returned an unexpected response — nothing was stored.",
      unsupported_provider:
        "This provider can't be verified here — manage the key in the provider console. Nothing was stored.",
    },
    membership: {
      not_in_verified_models: "Selector {selector} is not in this App's verified models.",
    },
    /**
     * Machine-readable 400 faces for the settings POST family.
     * The worker emits `{ key, message, params? }` — `message` is this en
     * face (interpolated server-side, also the fallback when the SPA does
     * not know the key); the SPA resolves `key` in the operator's locale.
     * Faces match the route's former inline literals byte-for-byte except
     * `customProviderDeclRejected` (the store-backstop 400, whose former
     * face was the thrown error's developer text).
     */
    error: {
      providerRequired: "Pick a provider for the key.",
      providerUnknown: "{provider} is not a supported provider — pick one from the list.",
      providerUnavailableOnImage:
        "{provider} is not available under this App's selected runtime image ({image}) — nothing was stored.",
      apiKeyRequired: "Enter an API key to store.",
      apiKeyTooLong:
        "That API key is too long ({count} characters) — keys are limited to {limit} characters. Nothing was stored.",
      apiKeyCommandPrefix:
        "That API key starts with \"!\" — the review runtime would run it as a shell command, so keys of that shape are refused. Nothing was stored.",
      providerKeyLimit:
        "{provider} already holds the maximum of {limit} keys — remove one before adding another. Nothing was stored.",
      chainFieldDuplicated: "The model chain field was submitted more than once — resubmit the form. Nothing was saved.",
      chainTooLong: "That model chain is too long ({count} characters) — limited to {limit} characters. Nothing was saved.",
      chainEmpty: "Enter at least one comma-separated model selector.",
      roleFieldDuplicated:
        "The {field} field was submitted more than once — resubmit the Role models form with one value per role. Nothing was saved.",
      roleUnknown: "{role} is not a known review role — nothing was saved.",
      roleFieldsMissingAll: "No role chain references were submitted — resubmit the Role models form.",
      roleFieldMissing:
        "The {roles} role field is missing — the Role models form always saves every seat (blank = default chain). Nothing was saved.",
      roleFieldsMissing:
        "The {roles} role fields are missing — the Role models form always saves every seat (blank = default chain). Nothing was saved.",
      roleChainUnknown:
        "{role} is not a known model chain — pick one from the list or leave it empty to use the default chain. Nothing was saved.",
      chainNameInvalid:
        "Chain names must be 1–{limit} lowercase letters, digits or hyphens — and \"default\" is reserved. Nothing was saved.",
      chainValueRequired: "Enter a model chain for the named chain.",
      defaultChainRemoveProtected: "The \"default\" chain cannot be removed — clear it instead. Nothing was saved.",
      providerIdRequired: "Enter a provider id for the custom provider.",
      providerIdInvalid:
        "Provider ids are lowercase letters, digits, and hyphens — 1 to 64 characters, starting with a letter or digit. Nothing was stored.",
      providerIdBuiltin: "{provider} is a built-in provider — custom providers must use a new id. Nothing was stored.",
      providerIdBaseConfig:
        "{provider} is already provided by the review environment's base configuration — custom providers must use a new id. Nothing was stored.",
      customProviderMax:
        "This App already has the maximum of {limit} custom providers — remove one before declaring another (updating an existing declaration is always allowed). Nothing was stored.",
      baseUrlRequired: "Enter the provider's base URL.",
      baseUrlInvalid: "The base URL must be a valid https URL with a host — nothing was stored.",
      baseUrlTooLong:
        "That base URL is too long ({count} characters) — limited to {limit} characters. Nothing was stored.",
      apiProtocolRequired: "Pick an API protocol for the custom provider.",
      apiProtocolUnknown: "{api} is not a supported API protocol — pick one from the list. Nothing was stored.",
      modelIdsRequired: "Enter at least one model id for the custom provider.",
      modelIdsTooMany: "Too many model ids ({count}) — at most {limit}. Nothing was stored.",
      modelIdTooLong: "Model ids are limited to {limit} characters each. Nothing was stored.",
      customProviderDeclRejected: "The custom provider was rejected — nothing was stored.",
      providerEndpointLocked:
        "{provider} already stores keys for its current endpoint — remove them before changing its base URL or API protocol. Nothing was stored.",
      templateUnknown: "Unknown provider template — nothing was stored.",
      templateIncomplete: "This provider template is incomplete — nothing was stored.",
      accountIdRequired: "Enter your Cloudflare account id to complete the Workers AI base URL.",
      accountIdInvalid: "Cloudflare account ids are 32 hex characters — nothing was stored.",
      templateIdBuiltin: "{template} is a built-in provider — nothing was stored.",
      templateIdBaseConfig:
        "{template} is already provided by the review environment's base configuration — nothing was stored.",
      materializedBaseUrlInvalid: "The materialized base URL is not a valid https URL — nothing was stored.",
      templateApiUnsupported: "{api} is not a supported API protocol — nothing was stored.",
      templateNoModels: "This provider template has no model ids — nothing was stored.",
      templateMaterializeMax:
        "This App already has the maximum of {limit} custom providers — remove one before materializing another (updating an existing declaration is always allowed). Nothing was stored.",
      sandboxImageUnknown: "Unknown or disabled sandbox image — nothing was stored.",
      triggerModeUnknown: "{mode} is not a review trigger mode — use open, every_push, or manual. Nothing was stored.",
      unknownOperation: "Unknown settings operation — resubmit one of this page's forms.",
    },
    ops: "Operations",
    opsCopy: "Pause ignores deliveries with 2xx; disable answers 404; delete is a soft-delete — all fail closed.",
    // Review trigger mode (spec review-trigger-policy §2/§3): segment
    // labels localize; the wire values (open / every_push / manual) and the
    // mention string stay verbatim.
    triggerMode: "Review trigger",
    triggerModeOpen: "First open",
    triggerModeEveryPush: "Every push",
    triggerModeManual: "Manual",
    triggerModeMention: "Mention the bot in a PR comment to (re-)start a review — works in every mode:",
    triggerModeMentionAria: "Bot mention: {mention}",
    confirmPauseTitle: "Pause reviews for {slug}?",
    confirmPauseBody: "Webhooks stay connected — deliveries are answered and ignored until you resume.",
    confirmResumeTitle: "Resume reviews for {slug}?",
    confirmResumeBody: "This App will review pull requests again.",
    confirmDisableTitle: "Disable {slug}?",
    confirmDisableBody: "GitHub deliveries will get 404 until you enable it again.",
    confirmDisableAction: "Disable",
    confirmEnableTitle: "Enable {slug}?",
    confirmEnableBody: "This App will accept webhook deliveries again.",
    confirmDeleteTitle: "Delete {slug}?",
    confirmDeleteBody: "This is a soft-delete. The App disappears from the list; reviews fail closed.",
    confirmDeleteButton: "Delete App",
    deleteSuccess: "App deleted. It has been removed from the Apps list.",
    providers: "Providers",
    providersCopy:
      "The providers configured for this App — stored keys show masked, custom declarations show their base URL and models. Add Provider picks a catalog entry; keys are stored only after a successful verify.",
    noConfiguredProviders:
      "No providers configured yet — use Add Provider to configure one. Reviews fail closed until a provider key is verified.",
    addProvider: "Add provider",
    addProviderCopy:
      "Pick a catalog provider — its configuration requirements appear once selected. Entries unusable on the App's runtime image are marked and can't be saved; providers outside the catalog use the custom declaration below.",
    catalogProvenance:
      "{count} providers from the committed models.dev snapshot, compiled into the app — no provider is contacted until you submit a key for verification.",
    catalogBuiltin: "Common providers",
    catalogTemplate: "Catalog templates",
    eligibilityBuiltin: "Works on the {image} runtime image — this provider runs as a built-in.",
    eligibilityTemplate:
      "Works on the {image} runtime image after materialization — your account id and key are saved as a custom provider declaration.",
    eligibilityUnavailable:
      "Not usable on the {image} runtime image — the entry stays listed for discovery but cannot be configured for this App. Switch the App's runtime image or use a custom declaration instead.",
    eligibilityUnavailableShort: "unavailable on {image}",
    configureProvider: "Configure {label}",
    customEntry: "Custom",
    customEntryCopy: "Declare a non-built-in provider — id, base URL, model ids, and key.",
    accountId: "Account id",
    accountIdPlaceholder: "32 hex characters",
    addTemplate: "Add {label}",
    modelChains: "Model chains",
    modelChainsCopy:
      "Default and named chains are peer tabs — edit each chain in its tab. The default chain is required and can't be removed; seats on a removed named chain fall back to the default.",
    addChain: "Add chain",
    chainName: "Chain name",
    chainNamePlaceholder: "e.g. deep-review",
    draftChain: "New chain",
    discardChain: "Discard",
    defaultChain: "Default chain",
    seats: "Seat chains",
    seatsCopy:
      "Each audit seat runs on the Default chain or an explicit named chain — a seat whose named chain was removed falls back to Default.",
    useDefaultChain: "Default chain",
    confirmRemoveChainTitle: "Remove chain {name}?",
    confirmRemoveChainBody: "Seats using {name} fall back to the default chain.",
    consoleOnly: "This provider can't be verified here — manage the key in the provider console.",
    confirmRemoveKeyTitle: "Remove the {provider} key ending {last4}?",
    confirmRemoveKeyBody:
      "The App's other {provider} keys stay. Selectors that depend on this key alone fail until you verify a replacement.",
    confirmRemoveCustomTitle: "Remove provider {provider}?",
    confirmRemoveCustomBody:
      "The provider and every key in its pool are removed. To free one slot only, remove that key's own row. Chains referencing its models fail on save.",
    runtimeImage: "Runtime image",
    runtimeImageCopy:
      "The sandbox runtime image that executes this App's reviews. Reviews read their model configuration at run time — nothing App-specific is baked into an image.",
    runtimeImageValue: "This App's reviews run on the {id} runtime image.",
    saveRuntimeImage: "Save runtime image",
    /**
     * GitHub identity card. `{name}`/`{id}`/`{time}` carry the
     * synced profile name, the numeric App id, and a relative synced-at time
     * (formatRelativeTime output) — nullable server fields degrade per-field,
     * so each key renders only when its value exists.
     */
    appInfo: "GitHub App",
    appInfoCopy:
      "The identity GitHub reports for this App. Profile fields are cached from the App's GitHub settings page; open the name to manage it there.",
    appInfoAppId: "App ID: {id}",
    appInfoViewOnGithub: "View {name} on GitHub",
    // (AD-623): the manager-face label — the name link targets the
    // App's GitHub settings page, so the accessible name says "manage", not
    // "view". Member face keeps appInfoViewOnGithub.
    appInfoManageOnGithub: "Manage {name} on GitHub",
    appInfoSynced: "Synced {time}",
    /**
     * Deployment version footer. `{version}` carries the
     * v-prefixed display form (`v${APP_VERSION}`) — the same shape as the
     * /healthz field and release tags.
     */
    footer: {
      version: "Version {version}",
    },
  },
  manifest: {
    title: "Create GitHub App",
    start: {
      heading: "Create GitHub App",
      body:
        "Continue to GitHub to register {appName} with the review permissions and webhook for this Worker. GitHub shows the requested permissions first — nothing is created until you confirm there.",
      continue: "Continue on GitHub",
      cancel: "Cancel",
    },
    confirm: {
      heading: "Create GitHub App",
      ready: "GitHub App {appName} (id {id}) is ready to connect.",
      registeredAs: "It will be registered for this deployment as:",
      slugWebhook: "Slug {slug} · webhook URL {webhookUrl}",
      note:
        "Connecting delivers this App's pull_request and issue_comment webhooks to this Worker. Reviews are controlled per App — pause an App to stop its reviews.",
      create: "Create App",
      cancel: "Cancel",
    },
    onboarding: {
      title: "GitHub App connected",
      heading: "GitHub App connected",
      connected: "GitHub App {appName} (id {id}) is connected to this deployment.",
      slug: "Slug: {slug}",
      webhookUrl: "Webhook URL: {webhookUrl}",
      nextStep:
        "Next: open Settings and configure a provider — reviews begin once this App's provider key is verified and its models are picked.",
      openSettings: "Open Settings",
      dashboard: "Back to /dashboard",
    },
    error: {
      title: "GitHub App setup",
      failedHeading: "GitHub App setup failed.",
      secretsUnchanged: "No Worker secrets were changed.",
      resumable: "Your GitHub App is still held for retry — return to the confirmation page to resubmit.",
      confirmPage: "confirmation page",
      retry: "Return to /dashboard to try again.",
      stateMismatch: "The app-creation flow could not be verified (bad or expired state).",
      missingCode: "GitHub did not return an app-manifest code.",
      codeRejected: "GitHub rejected the app-manifest code.",
      loginMismatch:
        "This confirmation belongs to a different GitHub login — sign back in and restart the app-creation flow.",
      noEncryptionKey:
        "This deployment has no valid DASHBOARD_ENCRYPTION_KEY to store App credentials with — ask the operator to configure it, then resubmit.",
      slugConflict:
        "Another App claimed this App's webhook slug while setup was in progress, so the GitHub App was created on GitHub but not connected to this deployment — no Worker data was stored. A manifest-created App cannot be connected twice: delete the just-created App on GitHub, then run a new app-creation flow from the dashboard.",
      alreadyConnected: "This GitHub App is already connected on this deployment — no changes were made.",
      dbRejected: "The App could not be stored — the dashboard database rejected the write. You can resubmit.",
      dbUnbound: "Dashboard storage is not configured — the App could not be stored.",
      workspaceRequired:
        "This deployment has more than one workspace, so an App needs to know which it belongs to — open a workspace and create the App from there.",
      workspaceGone:
        "The workspace this App was created in no longer exists, so the App has no workspace page here — delete it on GitHub and start a new app-creation flow from a live workspace.",
    },
  },
  /**
   * Platform console (`/_internal_admin`) — the operator surface. Bilingual
   * through the same locale cookie as the workspace shell: `main.tsx` reads
   * `boot.locale`, every screen takes it as a prop, and page copy resolves
   * via `t(locale, …)`. These keys are operator-facing and never reuse the
   * tenant-facing `support.*` copy.
   */
  admin: {
    /** The document `<title>` — substituted server-side in `serveDocument`. */
    documentTitle: "Morning Star — Platform operations",
    /** The header/nav shell of `src/spa/admin/main.tsx`. */
    header: {
      title: "Platform operations",
      /** Shown under the title when the boot carries no login. */
      signedOut: "signed out",
      /** Link back to the operator's own workspace shell. */
      dashboardLink: "Workspace dashboard",
    },
    /** The four console nav labels — `pages.ts` routes by `labelKey`. */
    nav: {
      flags: "Server flags",
      workspaces: "Workspaces",
      users: "Users",
      supportGrants: "Support access",
    },
    /**
     * A refused console write: the page's generic failure message stays
     * primary and the server's own `{error}` text rides along as secondary
     * detail (PageNotice's single message string carries both).
     */
    refusalDetail: "Server: {detail}",
    /** Server flags page. */
    flags: {
      description:
        "Platform-wide switches. A change applies to the next request and appends one audit row.",
      loadFailed: "Could not load the server flags.",
      emptyTitle: "No flags",
      emptyDescription: "This server exposes no platform switch.",
      flagColumn: "Flag",
      effectColumn: "Effect when off",
      stateColumn: "State",
      /** State renders as ON/OFF in both locales (compass D9). */
      stateOn: "ON",
      stateOff: "OFF",
      /** The note under the review_global key (spec §3.1). */
      reviewGlobalNote: "Queued work is not cancelled.",
      noDocumentedEffect: "No documented effect.",
      /** What each flag governs while it is off, keyed by flag key. */
      effectReviewGlobal: "No new review is enqueued. The per-App pause switch is unchanged.",
      effectSignupOpen:
        "An unknown GitHub login cannot sign in for the first time. Existing accounts are unaffected.",
      effectWorkspaceCreationOpen:
        "No workspace can be created, the operator's own included.",
      /** Write confirmation dialog — {flag}, {from} and {to} (ON/OFF) are interpolated. */
      confirmTitle: "Turn {flag} from {from} to {to}?",
      confirmButton: "Confirm",
      cancelButton: "Cancel",
      /** Inline confirmation next to the row right after a successful write. */
      saved: "Saved.",
      /** Fallback when the write fails with an unrecognised error. */
      toggleFailed: "Could not change {flag}.",
      /** Toggle accessible name: "{flag} {state}" with the ON/OFF state. */
      stateAria: "{flag} {state}",
    },
    /** Workspaces page. */
    workspaces: {
      description:
        "Every live workspace. A plan change never removes a member; a downgrade only blocks new invites.",
      loadFailed: "Could not load the workspace list.",
      emptyTitle: "No workspaces",
      emptyDescription: "This deployment has no live workspace yet.",
      workspaceColumn: "Workspace",
      ownerColumn: "Owner",
      membersColumn: "Members",
      /** {count} = pending invite count (rendered only when > 0). */
      pendingInvites: "{count} pending",
      seatsColumn: "Seats",
      planColumn: "Plan",
      createdColumn: "Created",
      /** Fallback when the plan write fails with an unrecognised error. */
      planChangeFailed: "Could not change the plan for {name}.",
      /** The plan picker's accessible name. */
      planAria: "Plan for {name}",
      /** The plan picker's catalogue labels, keyed by the wire plan id. */
      planFree: "Free",
      planPro: "Pro",
      planUnlimited: "Unlimited",
    },
    /** Users page. */
    users: {
      description:
        "Every account on this platform. Read-only: operator status comes from the allowlist, support access from the grant list.",
      loadFailed: "Could not load the user list.",
      emptyTitle: "No users",
      emptyDescription: "Nobody has signed in to this platform yet.",
      githubColumn: "GitHub",
      firstSeenColumn: "First seen",
      workspacesColumn: "Workspaces",
      identityColumn: "Identity",
      identityOperator: "Operator",
      /** {count} = the login's live grant count. */
      identitySupport: "Support ({count})",
      identityUser: "User",
    },
    /**
     * Client-side table search (Workspaces, Users): one input filters the
     * already-loaded rows; the counter reads "shown / total".
     */
    search: {
      placeholder: "Search",
      /** {shown} = matching rows, {total} = loaded rows. */
      counter: "{shown} / {total}",
      emptyTitle: "No matches",
      emptyDescription: "No row matches the current search.",
    },
    /** Support grants page — list heads and the create form. */
    supportGrants: {
      description:
        "Time-boxed cross-workspace access. Creating and revoking a grant each append one audit row.",
      loadFailed: "Could not load the support grants.",
      /** Fallback when a write fails with an unrecognised error. */
      createFailed: "Could not create the support grant.",
      revokeFailed: "Could not revoke the support grant.",
      newWindowTitle: "New support window",
      workspaceLabel: "Workspace",
      workspacePlaceholder: "Select a workspace",
      operatorLabel: "Operator login",
      operatorPlaceholder: "octocat",
      reasonLabel: "Reason",
      reasonPlaceholder: "incident 42",
      hoursLabel: "Hours",
      submit: "Grant access",
      operatorColumn: "Operator",
      workspaceColumn: "Workspace",
      reasonColumn: "Reason",
      expiresColumn: "Expires",
      revokeAction: "Revoke",
      emptyTitle: "No open support windows",
      emptyDescription: "No operator holds cross-workspace access right now.",
    },
  },
};

/** The dictionary shape — derived from en, the source of truth. */
export type Dictionary = typeof en;
