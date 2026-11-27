/**
 * Task 4: the SPA contract layer for the App/Bot IA — `viewer_relation` and
 * `rp_per_credit` on every App-detail face, `archived` on chain rows and the
 * bot payload, and the Credits formatter. A drifted field fails the parse
 * into the page's error face instead of rendering an undefined value.
 */
import { describe, expect, test } from "bun:test";
import { formatCredits, parseBotSettings, parseSettings } from "../../src/spa/pages/data";

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
  monthly_rp: null,
  archived: false,
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

describe("formatCredits", () => {
  test("defaults to the ADR-documented rate of 1 Credit = 1,000 RP", () => {
    expect(formatCredits(1240)).toBe("1.24 Credits");
    expect(formatCredits(0)).toBe("0.00 Credits");
  });

  test("uses the profile's rate when the payload carries one", () => {
    expect(formatCredits(1240, 500)).toBe("2.48 Credits");
  });
});
