/**
 * Task 4: the SPA contract layer for the App/Bot IA — `viewer_relation` and
 * `rp_per_credit` on every App-detail face, `archived` on chain rows and the
 * bot payload, and the Credits formatter. A drifted field fails the parse
 * into the page's error face instead of rendering an undefined value.
 */
import { describe, expect, test } from "bun:test";
import { formatCredits, parseApps, parseBotSettings, parseSettings, parseUsableBots } from "../../src/spa/pages/data";

const chainRow = {
  position: 0,
  bot_id: "bot-1",
  name: "Studio Reviewer",
  description: null,
  provider_workspace: "Acme",
  owned: true,
  available: true,
  multiplier: 1,
  month_used_rp: 40,
  effective_monthly_rp: null,
  archived: false,
  default_chain: "deepseek/deepseek-chat",
  runtime: "omp",
};

/** The smallest valid App-detail payload: the read-only (non-manager) face. */
const settingsPayload = {
  can_manage: false,
  workspace_id: "ws-1",
  viewer_relation: "installed",
  rp_per_credit: 1000,
  blocked: false,
  blocked_reason: null,
  chain: [chainRow],
  app: {
    github_app_id: 123,
    status: "active",
    created_by: "btspoony",
    created_at: "2026-01-01T00:00:00Z",
    id: "app-1",
    github_name: "Morning Star",
    github_slug: "morning-star",
    github_description: null,
    github_html_url: null,
    github_avatar_url: null,
    github_metadata_synced_at: null,
  },
};

const botPayload = {
  can_manage: true,
  owned: true,
  archived: false,
  app: {
    github_app_id: null,
    id: "bot-1",
    name: "Team bot",
    status: null,
    scope: "owned",
    sandbox_image_id: "omp",
    last_webhook_at: null,
    github_name: null,
    github_slug: null,
    github_description: null,
    github_html_url: null,
    github_avatar_url: null,
    github_metadata_synced_at: null,
  },
  installations: [],
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog_version: "fixture-version",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
};

describe("parseSettings — viewer_relation and rp_per_credit", () => {
  test("a valid payload with every relation value parses", () => {
    for (const relation of ["installed", "created", "both"] as const) {
      const parsed = parseSettings({ ...settingsPayload, viewer_relation: relation });
      expect(parsed?.viewer_relation).toBe(relation);
    }
  });

  test("a missing viewer_relation is a parse failure", () => {
    const { viewer_relation: _omitted, ...without } = settingsPayload;
    expect(parseSettings(without)).toBeNull();
  });

  test("an unknown viewer_relation value is a parse failure", () => {
    expect(parseSettings({ ...settingsPayload, viewer_relation: "owner" })).toBeNull();
  });

  test("rp_per_credit is optional: absent parses", () => {
    const { rp_per_credit: _omitted, ...without } = settingsPayload;
    expect(parseSettings(without)?.rp_per_credit).toBeUndefined();
  });

  test("a present rp_per_credit must be a positive finite number", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
      expect(parseSettings({ ...settingsPayload, rp_per_credit: bad })).toBeNull();
    }
    expect(parseSettings({ ...settingsPayload, rp_per_credit: 500 })?.rp_per_credit).toBe(500);
  });
});

describe("parseSettings — chain row archived", () => {
  test("a chain row with archived parses and keeps the flag", () => {
    const parsed = parseSettings({ ...settingsPayload, chain: [{ ...chainRow, archived: true }] });
    expect(parsed?.chain?.[0]?.archived).toBe(true);
  });

  test("a missing or malformed archived flag is a parse failure", () => {
    const { archived: _omitted, ...without } = chainRow;
    expect(parseSettings({ ...settingsPayload, chain: [without] })).toBeNull();
    expect(parseSettings({ ...settingsPayload, chain: [{ ...chainRow, archived: "yes" }] })).toBeNull();
  });
});

describe("parseSettings — chain row effective ceiling", () => {
  test("an override, a default and none all parse", () => {
    for (const effective of [5000, null]) {
      const parsed = parseSettings({
        ...settingsPayload,
        chain: [{ ...chainRow, effective_monthly_rp: effective }],
      });
      expect(parsed?.chain?.[0]?.effective_monthly_rp).toBe(effective);
    }
  });

  test("a missing, zero or non-integer effective ceiling fails the parse", () => {
    const { effective_monthly_rp: _omitted, ...without } = chainRow;
    expect(parseSettings({ ...settingsPayload, chain: [without] })).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN, "5000"]) {
      expect(
        parseSettings({ ...settingsPayload, chain: [{ ...chainRow, effective_monthly_rp: bad }] }),
        String(bad),
      ).toBeNull();
    }
  });
});

describe("parseBotSettings — archived", () => {
  test("a valid bot payload parses with the archived state", () => {
    expect(parseBotSettings(botPayload)?.archived).toBe(false);
    expect(parseBotSettings({ ...botPayload, archived: true })?.archived).toBe(true);
  });

  test("a missing or malformed archived flag is a parse failure", () => {
    const { archived: _omitted, ...without } = botPayload;
    expect(parseBotSettings(without)).toBeNull();
    expect(parseBotSettings({ ...botPayload, archived: 1 })).toBeNull();
  });
});

describe("parseApps — list chain rows", () => {
  const listPayload = {
    viewer: { login: "mallory", role: "member" },
    apps: [
      {
        github_app_id: 123,
        github_name: "Morning Star",
        github_slug: "morning-star",
        github_avatar_url: null,
        status: "active",
        review_enabled: 1,
        created_by: "btspoony",
        health: { latest: null, rejected24h: 0 },
        chain: [chainRow],
      },
    ],
  };

  test("a list row whose chain entries carry archived parses", () => {
    const parsed = parseApps(listPayload);
    expect(parsed?.apps[0]?.chain?.[0]?.archived).toBe(false);
  });

  test("a missing or non-boolean archived in a list chain row fails the parse", () => {
    const { archived: _omitted, ...without } = chainRow;
    expect(parseApps({ ...listPayload, apps: [{ ...listPayload.apps[0], chain: [without] }] })).toBeNull();
    expect(
      parseApps({ ...listPayload, apps: [{ ...listPayload.apps[0], chain: [{ ...chainRow, archived: "yes" }] }] }),
    ).toBeNull();
  });
});

/**
 * Every App-detail face carries `viewer_relation`: the manage, untargeted,
 * blocked and blocked-many payloads below mirror the production shapes pinned
 * in `tests/spa/app-detail.test.tsx` (copied, not imported).
 */
describe("parseSettings — viewer_relation on every App-detail face", () => {
  const manageFace = {
    can_manage: true,
    official_workspace: true,
    can_configure_bot: true,
    installation: null,
    pending_installations: [],
    viewer_relation: "created",
    workspace_id: "ws-1",
    target_id: "rt-1",
    blocked: false,
    blocked_reason: null,
    chain: [chainRow],
    app: {
      github_app_id: 123,
      id: "app-1",
      status: "active",
      created_by: "btspoony",
      last_webhook_at: null,
      scope: "owned",
      sandbox_image_id: "omp",
      review_enabled: true,
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_visibility: "unknown",
      github_name: "Morning Star",
      github_slug: "morning-star",
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
    },
    check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
  };

  const untargetedFace = {
    ...manageFace,
    target_id: undefined,
    app: {
      github_app_id: manageFace.app.github_app_id,
      id: manageFace.app.id,
      status: manageFace.app.status,
      created_by: manageFace.app.created_by,
      last_webhook_at: null,
      scope: "owned",
      sandbox_image_id: "omp",
      github_visibility: "unknown",
      github_name: manageFace.app.github_name,
      github_slug: manageFace.app.github_slug,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
  };

  const blockedFace = {
    can_manage: true,
    blocked: true,
    blocked_reason: "bot_not_shared",
    viewer_relation: "created",
    workspace_id: "ws-1",
    target_id: "rt-1",
    chain: [chainRow],
    app: {
      github_app_id: manageFace.app.github_app_id,
      id: manageFace.app.id,
      status: manageFace.app.status,
      created_by: manageFace.app.created_by,
      review_enabled: true,
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      scope: "owned",
      github_name: manageFace.app.github_name,
      github_slug: manageFace.app.github_slug,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_visibility: "unknown",
    },
    installation: null,
    check_gate: manageFace.check_gate,
  };

  const blockedManyFace = {
    ...blockedFace,
    target_id: null,
    targets_many: true,
    app: {
      github_app_id: manageFace.app.github_app_id,
      id: manageFace.app.id,
      status: "active",
      created_by: "btspoony",
      scope: "owned",
      github_name: null,
      github_slug: "morning-star",
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_visibility: "unknown",
    },
    installation: null,
  };

  const faces = [
    ["manage", manageFace],
    ["untargeted", untargetedFace],
    ["blocked", blockedFace],
    ["blocked-many", blockedManyFace],
  ] as const;

  test("each face parses with a valid viewer_relation", () => {
    for (const [name, face] of faces) {
      const parsed = parseSettings(face);
      expect(parsed, name).not.toBeNull();
      expect(parsed?.viewer_relation, name).toBe("created");
    }
  });

  test("each face fails the parse without viewer_relation", () => {
    for (const [name, face] of faces) {
      const { viewer_relation: _omitted, ...without } = face;
      expect(parseSettings(without), name).toBeNull();
    }
  });

  test("each face fails the parse on an unknown viewer_relation value", () => {
    for (const [name, face] of faces) {
      expect(parseSettings({ ...face, viewer_relation: "owner" }), name).toBeNull();
    }
  });

  test("each face fails the parse when a chain row loses its archived flag", () => {
    const { archived: _omitted, ...without } = chainRow;
    for (const [name, face] of faces) {
      expect(parseSettings({ ...face, chain: [without] }), name).toBeNull();
    }
  });

  test("each face fails the parse when a chain row's archived flag is not a boolean", () => {
    for (const [name, face] of faces) {
      expect(parseSettings({ ...face, chain: [{ ...chainRow, archived: "yes" }] }), name).toBeNull();
    }
  });

  test("each face parses a chain row's default chain and runtime, keeping a null chain", () => {
    for (const [name, face] of faces) {
      const parsed = parseSettings({ ...face, chain: [{ ...chainRow, default_chain: null }] });
      expect(parsed, name).not.toBeNull();
      expect(parsed?.chain?.[0]?.default_chain, name).toBeNull();
      expect(parsed?.chain?.[0]?.runtime, name).toBe("omp");
    }
  });

  test("a withheld default chain and runtime parse as null (the row outlived its relation)", () => {
    for (const [name, face] of faces) {
      const parsed = parseSettings({
        ...face,
        chain: [{ ...chainRow, available: false, default_chain: null, runtime: null }],
      });
      expect(parsed, name).not.toBeNull();
      expect(parsed?.chain?.[0]?.runtime, name).toBeNull();
    }
  });

  test("each face fails the parse when a chain row's default chain or runtime is malformed", () => {
    for (const [name, face] of faces) {
      const { default_chain: _noChain, ...withoutChain } = chainRow;
      expect(parseSettings({ ...face, chain: [withoutChain] }), name).toBeNull();
      expect(
        parseSettings({ ...face, chain: [{ ...chainRow, default_chain: 7 }] }),
        name,
      ).toBeNull();
      const { runtime: _noRuntime, ...withoutRuntime } = chainRow;
      expect(parseSettings({ ...face, chain: [withoutRuntime] }), name).toBeNull();
      expect(parseSettings({ ...face, chain: [{ ...chainRow, runtime: "" }] }), name).toBeNull();
    }
  });
});

describe("formatCredits", () => {
  test("defaults to the ADR-documented rate of 1 Credit = 1,000 RP", () => {
    expect(formatCredits(1240)).toBe("1.24 Credits");
    expect(formatCredits(0)).toBe("0.00 Credits");
  });

  test("uses the profile's rate when the payload carries one", () => {
    expect(formatCredits(1240, 500)).toBe("2.48 Credits");
  });
});

/**
 * F2-5: a pending-bind row from an OLDER payload must stay visible.
 *
 * The list's pending block gained `can_bind` when the server started stating
 * bindability. A page served by an older deployment (or a cached payload) has
 * the row WITHOUT that flag. Filtering such a row out hides a real installation
 * silently — the user sees fewer pending installs than they have. The parser
 * therefore keeps the row and withholds the ACTION, because an unknown
 * permission must never read as a granted one.
 */
describe("parseApps — a pending row without can_bind is shown, not dropped", () => {
  const pending = {
    installation_id: 8801,
    account_login: "acme-org",
    seen_at: "2026-11-20 09:00:00",
    app_id: "app-shared",
    app_github_app_id: 7601,
    app_name: "Platform",
  };
  const payload = (rows: unknown[]) => ({
    viewer: { login: "alice", role: "member" },
    apps: [],
    pending_installations: rows,
  });

  test("an older row survives with the bind action withheld", () => {
    const parsed = parseApps(payload([pending]));
    expect(parsed?.pending_installations).toEqual([{ ...pending, can_bind: false }]);
  });

  test("a stated true is preserved, and rows mix without losing either", () => {
    const parsed = parseApps(
      payload([pending, { ...pending, installation_id: 8802, can_bind: true }]),
    );
    expect(parsed?.pending_installations?.map((row) => [row.installation_id, row.can_bind])).toEqual([
      [8801, false],
      [8802, true],
    ]);
  });

  test("a malformed can_bind is still a refusal — absence is the only thing tolerated", () => {
    expect(parseApps(payload([{ ...pending, can_bind: "yes" }]))?.pending_installations).toEqual([]);
    expect(parseApps(payload([{ ...pending, can_bind: null }]))?.pending_installations).toEqual([]);
  });
});

/**
 * QC F4-17: every new amount field is guarded to its WIRE domain, and a
 * missing REQUIRED ceiling is not "unlimited".
 *
 * The producer's own shapes are the input: `overview.effective_ceiling` is
 * computed on every successful bot read, `rp_per_credit` is the positive whole
 * number the admin authoring route accepts, and each list row is an object.
 * A payload that slips a fraction through would render a wrong figure instead
 * of the page's error face, which is the one outcome a type guard exists to
 * prevent.
 */
describe("amount guards — the parsers apply the writer's domain", () => {
  const botsPayload = (overrides: Record<string, unknown> = {}) => ({
    workspace_id: "ws-1",
    plan_monthly_rp: 20000,
    rp_per_credit: 1000,
    bots: [
      {
        id: "bot-1",
        name: "Acme",
        description: null,
        workspace_id: "ws-1",
        workspace_name: "Acme",
        owned: true,
        can_manage: true,
        scope: "owned",
        multiplier: 1,
        month_used_rp: 40,
        effective_ceiling: null,
        archived: false,
      },
    ],
    ...overrides,
  });

  test("a malformed rp_per_credit fails every payload that carries one", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "1000"]) {
      expect(parseUsableBots(botsPayload({ rp_per_credit: bad })), `bots ${String(bad)}`).toBeNull();
      expect(parseSettings({ ...settingsPayload, rp_per_credit: bad }), `settings ${String(bad)}`).toBeNull();
      expect(
        parseBotSettings({ ...botPayload, rp_per_credit: bad }),
        `bot ${String(bad)}`,
      ).toBeNull();
    }
    // An absent rate stays valid: that is the documented 1,000 fallback.
    const { rp_per_credit: _omitted, ...withoutRate } = botsPayload();
    expect(parseUsableBots(withoutRate)).not.toBeNull();
  });

  test("a malformed plan ceiling or recorded spend fails the list parse", () => {
    for (const bad of [0, -1, 1.5, "20000"]) {
      expect(parseUsableBots(botsPayload({ plan_monthly_rp: bad })), `plan ${String(bad)}`).toBeNull();
    }
    for (const bad of [-1, 1.5, Number.NaN, "40"]) {
      expect(
        parseUsableBots(botsPayload({ bots: [{ ...botsPayload().bots[0], month_used_rp: bad }] })),
        `spend ${String(bad)}`,
      ).toBeNull();
    }
  });

  test("a non-object list row is refused, not rendered", () => {
    const { viewer } = { viewer: { login: "alice", role: "member" } };
    for (const bad of ["row", 7, null, [], undefined]) {
      expect(parseApps({ viewer, apps: [bad] }), String(bad)).toBeNull();
    }
    // A well-formed row beside a malformed one still fails the whole parse.
    const good = {
      github_app_id: 1,
      github_name: null,
      github_slug: null,
      github_avatar_url: null,
      status: "active",
      review_enabled: 1,
      created_by: "alice",
      health: { latest: null, rejected24h: 0 },
    };
    expect(parseApps({ viewer, apps: [good, 42] })).toBeNull();
    expect(parseApps({ viewer, apps: [good] })).not.toBeNull();
  });

  test("a list row's month block must carry a recorded spend and a bounded multiplier", () => {
    const viewer = { login: "alice", role: "member" };
    const row = {
      github_app_id: 1,
      github_name: null,
      github_slug: null,
      github_avatar_url: null,
      status: "active",
      review_enabled: 1,
      created_by: "alice",
      health: { latest: null, rejected24h: 0 },
      month: { used_rp: 40, owned: false, multiplier: 1 },
    };
    expect(parseApps({ viewer, apps: [row] })).not.toBeNull();
    for (const bad of [
      { used_rp: 1.5, owned: false, multiplier: 1 },
      { used_rp: 40, owned: false, multiplier: 0 },
      { used_rp: 40, owned: false, multiplier: 5000 },
      { used_rp: 40, owned: "no", multiplier: 1 },
      "month",
    ]) {
      expect(parseApps({ viewer, apps: [{ ...row, month: bad }] }), JSON.stringify(bad)).toBeNull();
    }
    // `null` is the "no chain mounted" fact the dash renders.
    expect(parseApps({ viewer, apps: [{ ...row, month: null }] })).not.toBeNull();
  });

  test("an overview without effective_ceiling is a failure, while explicit null is 'no ceiling'", () => {
    const overview = (patch: Record<string, unknown>) => ({
      provider_workspace: "Acme",
      month_used_rp: 40,
      plan_monthly_rp: null,
      effective_ceiling: null,
      default_chain: null,
      mounted_apps: [],
      ...patch,
    });
    expect(parseBotSettings({ ...botPayload, overview: overview({}) })).not.toBeNull();

    const { effective_ceiling: _omitted, ...withoutCeiling } = overview({});
    // A missing REQUIRED ceiling is NOT unlimited: it fails the parse.
    expect(parseBotSettings({ ...botPayload, overview: withoutCeiling })).toBeNull();
    for (const bad of [0, -1, 1.5, "3000", Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseBotSettings({ ...botPayload, overview: overview({ effective_ceiling: bad }) })).toBeNull();
    }
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(parseBotSettings({ ...botPayload, overview: overview({ month_used_rp: bad }) })).toBeNull();
    }
  });

  test("the bot payload's own pricing fields stay inside the shared domains", () => {
    for (const bad of [0, -1, 5000]) {
      expect(
        parseBotSettings({ ...botPayload, app: { ...botPayload.app, multiplier: bad } }),
        `multiplier ${String(bad)}`,
      ).toBeNull();
    }
    for (const bad of [0, -1, 1.5]) {
      expect(
        parseBotSettings({ ...botPayload, app: { ...botPayload.app, monthly_rp: bad } }),
        `monthly_rp ${String(bad)}`,
      ).toBeNull();
    }
    // The consumer payload omits both: absence is not a malformed value.
    const { multiplier: _m, monthly_rp: _r, ...app } = { ...botPayload.app };
    expect(parseBotSettings({ ...botPayload, app })).not.toBeNull();
  });
});
