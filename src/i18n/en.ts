/**
 * English dictionary — the i18n source of truth (plan 29 T2).
 *
 * Contract:
 *   - `Dictionary` is derived from this object via `typeof en`; `zh-CN.ts`
 *     is typed as `Dictionary`, so a missing (or extra) key is a compile
 *     error. The runtime key-set parity test in tests/i18n/i18n.test.ts is
 *     the belt-and-suspenders check.
 *   - Values are PLAIN TEXT (no HTML entities, no markup). Consumers escape
 *     before rendering — SSR pages via escapeHtml, the SPA via JSX.
 *   - `{placeholder}` tokens are interpolated by `t(locale, key, params)`.
 *   - This is the single string table for the whole dashboard: plan 29
 *     Tasks 4/5 and plans 30/31 APPEND keys here — they never start a
 *     second table.
 *   - The `notice` slot mirrors the `PageNotice` type (kind × message);
 *     after the plan-46/49 dead-key purges it carries only the member-flow
 *     messages (the retired SSR settings routes rendered plain text).
 *   - Manifest copy deliberately carries NO REVIEW_ENABLED user-facing
 *     sentence (plan 29 T5 removes it; per-App pause is the only switch).
 */
export const en = {
  nav: {
    brand: "Morning Star Inspector",
    primary: "Primary navigation",
    apps: "Apps",
    insights: "Insights",
    members: "Members",
    /** Label of the OTHER locale — the toggle target (en shows 中文, zh_CN shows EN). */
    language: "中文",
    /** Theme toggle (plan 41/44): icon-only button; state + action live in the aria copy. */
    /** {mode} = current effective theme, {target} = the theme clicking switches to. */
    themeToggleAria: "Display theme: {mode}. Activate to switch to {target}.",
    themeDark: "dark",
    themeLight: "light",
    logout: "Logout",
    signedInAs: "Signed in as {name}",
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
      deniedTitle: "Access denied",
      deniedBody: "This deployment is invite-only. Ask an admin to add {login}.",
      removedTitle: "Access removed",
      removedBody: "Your dashboard access was removed. Ask an admin to re-invite {login}.",
      forbiddenTitle: "Forbidden",
      forbiddenBody:
        "This page is restricted to dashboard admins. You are signed in as {login} — back to /dashboard.",
      signInErrorTitle: "Sign-in error",
      signInErrorBody:
        "Sign-in failed. {message} No session was created. Return to /dashboard/login to try again.",
    },
    oauth: {
      stateInvalid: "Sign-in could not be verified (bad or expired state).",
      missingCode: "GitHub did not return an authorization code.",
      codeRejected: "GitHub rejected the authorization code.",
      profileFailed: "Could not read your GitHub profile.",
    },
    loading: "Loading…",
    loadFailed: "Could not load this page.",
    saveFailed: "Could not save your changes.",
    cancel: "Cancel",
  },
  login: {
    heading: "Sign in to Morning Star Inspector",
    description: "Use your GitHub account to access the console.",
    signIn: "Sign in with GitHub",
    inviteOnly: "This deployment is invite-only — ask an admin to add your GitHub login.",
  },
  notice: {
    success: {
      invited: "Invited {login} — they can sign in with GitHub now.",
      removedMember: "Removed {login}.",
      roleChanged: "{login} is now {role}.",
    },
    warn: {
      alreadyMember: "{login} is already a member — nothing changed.",
    },
    error: {
      enterLogin: "Enter a GitHub login to invite.",
      invalidLogin: "{login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.",
      inviteFailed: "Could not invite {login} — try again.",
      roleChangeFailed: "Could not change {login}'s role — the member list just changed, try again.",
      removeFailed: "Could not remove {login} — the member list just changed, try again.",
    },
  },
  apps: {
    heading: "Apps",
    create: "Create GitHub App",
    empty: "No Apps yet — Create GitHub App connects your first one.",
    settings: "Settings",
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
    openAria: "Open {slug} settings",
  },
  members: {
    heading: "Members",
    inviteOnlyNotice: "Only the GitHub users listed here can sign in to this deployment.",
    inviteLabel: "Invite by GitHub login",
    invitePlaceholder: "e.g. octocat",
    inviteButton: "Invite member",
    roleLabel: "Role",
    tableLogin: "GitHub login",
    tableJoined: "Joined",
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
    you: "you",
    adminOnly: "This page is restricted to dashboard admins.",
    roleAdmin: "admin",
    roleMember: "member",
    empty: "No members yet.",
  },
  insights: {
    heading: "Review health",
    window: "Window: {label}",
    reviewsTotal: "Reviews: {count}",
    verdicts: "Verdicts: {line}",
    noReviews: "No reviews in this window.",
    findingsBySeverity: "Findings by severity",
    findingsByCategory: "Findings by category",
    weeklyTrend: "Weekly trend",
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
    recordsHeading: "Review records",
    filterRepo: "Repo",
    filterRepoAll: "All",
    uncategorized: "uncategorized",
  },
  settings: {
    title: "App settings",
    backToApps: "Back to Apps",
    changesSaved: "Changes saved.",
    addKey: "Add key",
    provider: "Provider",
    apiKey: "API key",
    apiKeyPlaceholder: "Paste the provider API key",
    keyEnding: "key ending {last4}",
    keyTooShort: "key too short to show a tail",
    updated: "updated {time}",
    remove: "Remove",
    selectProvider: "Select a provider…",
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
    installHealth: "Install health",
    installHealthCopy: "Webhook installations and the latest deliveries for this App.",
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
     * Plan 45 T4: machine-readable 400 faces for the settings POST family.
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
      unknownOperation: "Unknown settings operation — resubmit one of this page's forms.",
    },
    ops: "Operations",
    opsCopy: "Pause ignores deliveries with 2xx; disable answers 404; delete is a soft-delete — all fail closed.",
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
    catalogBuiltin: "Built-in providers",
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
    confirmRemoveKeyTitle: "Remove the {provider} key?",
    confirmRemoveKeyBody: "Selectors that need {provider} will fail until you verify a new key.",
    confirmRemoveCustomTitle: "Remove provider {provider}?",
    confirmRemoveCustomBody: "The provider and its stored key are removed. Chains referencing its models fail on save.",
    runtimeImage: "Runtime image",
    runtimeImageCopy:
      "The sandbox runtime image that executes this App's reviews. Reviews read their model configuration at run time — nothing App-specific is baked into an image.",
    runtimeImageValue: "This App's reviews run on the {id} runtime image.",
    saveRuntimeImage: "Save runtime image",
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
    },
  },
};

/** The dictionary shape — derived from en, the source of truth. */
export type Dictionary = typeof en;
