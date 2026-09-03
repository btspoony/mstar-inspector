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
 *   - The `notice` slot mirrors the `PageNotice` type (kind × message) and
 *     every message the legacy routes construct today.
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
      appStatusChanged: "{verb} {slug}.",
      appPaused: "Paused {slug}.",
      appResumed: "Resumed {slug}.",
      keyStored: "Stored the {provider} key for {slug} — it is only ever shown masked.",
      chainCleared:
        "Cleared the model chain for {slug} — reviews fail closed until a chain + provider keys are configured (per-App only).",
      chainSaved: "Saved the model chain for {slug}.",
      rolesSaved: "Saved the role models for {slug}.",
      customProviderDeclared:
        "Declared custom provider {providerId} for {slug} — its key is stored encrypted and injected by environment variable name.",
      customProviderRemoved: "Removed the custom provider {providerId} from {slug}.",
      keyRemoved: "Removed the stored {provider} key for {slug}.",
    },
    warn: {
      alreadyMember: "{login} is already a member — nothing changed.",
      alreadyStatus: "{slug} was already {state} — nothing changed.",
      justRemoved: "{slug} was just removed — nothing changed.",
      noCustomProvider: "No custom provider {providerId} on {slug} — nothing changed.",
      noStoredKey: "No stored {provider} key on {slug} — nothing changed.",
    },
    error: {
      enterLogin: "Enter a GitHub login to invite.",
      invalidLogin: "{login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.",
      unknownMember: "Unknown member — nothing was removed, try again.",
      cannotRemoveSelf: "You cannot remove yourself.",
      lastAdmin: "The last admin cannot be removed.",
      inviteFailed: "Could not invite {login} — try again.",
      roleChangeFailed: "Could not change {login}'s role — the member list just changed, try again.",
      removeFailed: "Could not remove {login} — the member list just changed, try again.",
      encryptionKeyMissing:
        "This deployment has no valid DASHBOARD_ENCRYPTION_KEY for its stored keys — ask the operator to configure it, then resubmit.",
      storageRejected: "The dashboard database rejected the change — nothing was stored. You can resubmit.",
      pickProvider: "Pick a provider for the key.",
      enterApiKey: "Enter an API key to store.",
      keyTooLong:
        "That API key is too long ({length} characters) — keys are limited to {max} characters. Nothing was stored.",
      chainDuplicate: "The model chain field was submitted more than once — resubmit the form. Nothing was saved.",
      chainTooLong: "That model chain is too long ({length} characters) — limited to {max}. Nothing was saved.",
      chainEmpty: "Enter at least one comma-separated model selector.",
      roleFieldDuplicate:
        "The {field} field was submitted more than once — resubmit the Role models form with one value per role. Nothing was saved.",
      unknownRole: "{role} is not a known review role — nothing was saved.",
      noRoleSelectors: "No role selectors were submitted — resubmit the Role models form.",
      roleSelectorTooLong:
        "The {role} selector is too long ({length} characters) — limited to {max}. Nothing was saved.",
      roleSelectorEmpty:
        "The {role} selector needs at least one comma-separated model selector — or leave it empty to use the App model chain. Nothing was saved.",
      customProviderIdEmpty: "Enter a provider id for the custom provider.",
      customProviderIdInvalid:
        "Provider ids are lowercase letters, digits, and hyphens — 1 to 64 characters, starting with a letter or digit. Nothing was stored.",
      customProviderBuiltin:
        "{providerId} is a built-in provider — custom providers must use a new id. Nothing was stored.",
      customProviderBaseConflict:
        "{providerId} is already provided by the review environment's base configuration — custom providers must use a new id. Nothing was stored.",
      customProviderMax:
        "This App already has the maximum of {max} custom providers — remove one before declaring another (updating an existing declaration is always allowed). Nothing was stored.",
      baseUrlEmpty: "Enter the provider's base URL.",
      baseUrlInvalid: "The base URL must be a valid https URL with a host — nothing was stored.",
      baseUrlTooLong:
        "That base URL is too long ({length} characters) — limited to {max}. Nothing was stored.",
      apiEmpty: "Pick an API protocol for the custom provider.",
      apiInvalid: "{api} is not a supported API protocol — pick one from the list. Nothing was stored.",
      modelIdsEmpty: "Enter at least one model id for the custom provider.",
      modelIdsTooMany: "Too many model ids ({count}) — at most {max}. Nothing was stored.",
      modelIdTooLong: "Model ids are limited to {max} characters each. Nothing was stored.",
      unknownOp: "Unknown settings operation — resubmit one of this page's forms.",
    },
  },
  apps: {
    title: "Apps",
    heading: "Apps",
    create: "Create GitHub App",
    empty: "No Apps yet — create one below.",
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
      disable: "Disable",
      enable: "Enable",
      delete: "Delete",
    },
    health: {
      delivery: "delivery {time}",
      deliveryNever: "delivery never",
      rejected24h: "{count} rejected in 24h",
    },
  },
  members: {
    title: "Members",
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
    title: "Review health",
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
    filterWindow: "Window (days)",
    filterRepo: "Repo (owner/repo)",
    filterRepoPlaceholder: "owner/repo",
    apply: "Apply",
    uncategorized: "uncategorized",
  },
  settings: {
    title: "App settings",
    providerKeys: "Provider keys",
    providerKeysCopy:
      "Keys for App {slug} are stored encrypted and shown masked — the last 4 characters only. Re-adding a provider replaces its stored key.",
    addKey: "Add key",
    provider: "Provider",
    apiKey: "API key",
    apiKeyPlaceholder: "Paste the provider API key",
    keyEnding: "key ending {last4}",
    keyTooShort: "key too short to show a tail",
    updated: "updated {time}",
    remove: "Remove",
    noKeys:
      "No provider keys stored for this App — reviews fail closed until keys are configured (per-App BYOK only).",
    selectProvider: "Select a provider…",
    modelChain: "Model chain",
    modelChainCopy:
      "Select models from this App's verified providers for its reviews — the deployment's global chain knob was retired; this App's chain is the only chain its reviews use.",
    modelChainNote:
      "Saving an empty chain clears it — reviews then fail closed with per-App config incomplete (missing model chain or provider key) until the chain and the required provider keys are configured.",
    modelChainField: "Model chain",
    saveChain: "Save model chain",
    customProviders: "Custom providers",
    customProvidersCopy:
      "Declare a non-built-in model provider for this App's reviews — the API key is stored encrypted and injected into the review runner by environment variable name, never as a literal.",
    noCustomProviders: "No custom providers declared for this App — its reviews use the built-in providers.",
    providerId: "Provider id",
    baseUrl: "Base URL",
    api: "API",
    modelIds: "Model ids",
    addCustomProvider: "Add custom provider",
    selectApi: "Select an API…",
    roleModels: "Role models",
    roleModelsCopy:
      "Optional per-seat model overrides for this App's reviews — each audit role picks from the same verified-model list (a :thinking suffix passes through).",
    emptyUsesAppChain: "Empty = use the App model chain.",
    roleHintReviewSeat: "quick + default review seats",
    roleHintDeep: "deep review seat",
    saveRoleModels: "Save role models",
    review: "Review",
    reviewOn: "Reviews are on for this App's pull requests.",
    pauseReviews: "Pause reviews",
    reviewPaused: "paused",
    reviewPausedCopy:
      "Webhooks stay connected — deliveries are answered and ignored, and nothing is reviewed until you resume.",
    resumeReviews: "Resume reviews",
    disconnected: "This App is disconnected — enable it to review.",
    installHealth: "Install health",
    lastWebhook: "Last webhook: {time}",
    noInstallations: "No installations yet.",
    installation: "installation {id}",
    lastSeen: "last seen {time}",
    recentDeliveries: "Recent deliveries",
    recentDeliveriesCopy: "The last 5 webhook deliveries for this App — newest first.",
    noDeliveries: "No deliveries yet.",
    unknownEvent: "unknown event",
    status: "status {code}",
    useAppChain: "Use App model chain",
    addToChain: "Add to chain",
    noAutoDiscovery: "This provider does not list models — pick from another verified provider.",
    noVerifiedModels: "Verify a provider key to populate model options.",
    chainEmpty: "No models in the chain yet.",
    pickModel: "Select a model…",
    keyVerified: "Key verified — models cached.",
    unsupportedProvidersHint:
      "Azure OpenAI and AI Gateway keys can't be verified here — manage them in the provider console.",
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
  home: {
    insightsHeading: "Overall insights",
    viewFull: "View full insights →",
    trendHint: "Latest week {week}: {reviews} · {findings}",
    noTrend: "No recent trend in this window.",
  },
};

/** The dictionary shape — derived from en, the source of truth. */
export type Dictionary = typeof en;
