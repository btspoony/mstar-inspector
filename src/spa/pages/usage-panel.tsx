/**
 * The per-key usage panel: probes the provider's own quota endpoint with
 * this one key and reports whether the key is still accepted and what
 * remains of its allowance, inline under the key's row. The probe POSTs
 * `provider` + `keyId` as form data to `/api/apps/:appId/keys/usage` on open
 * and on every re-open — the re-probe IS the cache (there is deliberately
 * no polling or server-side cache layer), so a key that just went dead never
 * shows a stale bar. A generation guard discards responses that resolve
 * after the panel closed or moved on to another key.
 *
 * Four faces on the snapshot: `ok` renders the known dimensions
 * (session / week / month) as one row of one to three cells in that fixed
 * order. A cell comes from any limit whose id segment names one of those
 * dimensions — a window draws a hairline bar (`--surface-inset` track,
 * `--tone-accent-solid` fill) with the remaining share and its future reset
 * time, while an amount-only pool states its remaining amount and, when the
 * payload carries one, the on-demand amount beside it, with no bar invented
 * for a fraction the vendor never gave. Windows of unknown dimensions fall
 * back to one line per window so nothing is dropped, and every balance outside
 * those dimensions renders as the muted bottom line. `unauthorized` and
 * `error` are danger notices; `absent` is a muted line. The wire's diagnostic
 * `reason` is never rendered verbatim. A transport/HTTP/parse failure renders
 * the same danger notice as the wire's `error` face, unless the 400 carries a
 * dictionary key — then that key's localized sentence renders instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t, isDictionaryKey, type DictionaryKey } from "../../i18n";
import type { SpaBoot } from "../boot";
import { postForm } from "../api";
import { apiBase } from "../workspace-base";
import { formatUntil } from "../relative-time";
import { LoadingNotice, PageNotice } from "./PageNotice";
import { parseUsageSnapshot, type UsageLimit, type UsageSnapshot } from "./data";

type UsagePhase = "loading" | "ready" | "failed";

/** A 400's keyed face: the dictionary key plus the server's interpolation params. */
type Refusal = { key: DictionaryKey; params?: Record<string, string | number> };

/** A value `t()` can interpolate; anything else would render `[object Object]` or leave `{name}` bare. */
function isParamValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * Resolve a 400 body's keyed face; an unkeyed, non-JSON, or malformed-params
 * body keeps the generic notice rather than a half-filled refusal.
 */
function refusalOf(body: string): Refusal | null {
  try {
    const parsed = JSON.parse(body) as { key?: unknown; params?: unknown };
    if (typeof parsed.key !== "string" || !isDictionaryKey(parsed.key)) return null;
    if (parsed.params === undefined) return { key: parsed.key };
    if (
      typeof parsed.params !== "object" ||
      parsed.params === null ||
      Array.isArray(parsed.params) ||
      !Object.values(parsed.params).every(isParamValue)
    ) {
      return null;
    }
    return { key: parsed.key, params: parsed.params as Record<string, string | number> };
  } catch {
    return null;
  }
}

/** The window dimensions that earn a bar cell, in their fixed display order. */
const CELL_SEGMENTS = ["session", "week", "month"] as const;
type CellSegment = (typeof CELL_SEGMENTS)[number];

/**
 * The mounted panels, youngest last. Every provider card owns its own open
 * panel, so several coexist; Escape dismisses only the last one opened.
 */
const openPanels: object[] = [];

export function UsagePanel({
  locale,
  appId,
  provider,
  keyId,
  open,
  onClose,
}: {
  locale: SpaBoot["locale"];
  /** The numeric GitHub App id — the same segment `/keys/usage` posts to. */
  appId: number;
  provider: string;
  keyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<UsagePhase>("loading");
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Generation guard: the parent keeps the panel mounted across re-probes of
  // the same key (a fresh mount per key), so a probe that resolves late must
  // not set state under another key's row or after close.
  const generation = useRef(0);

  const probe = useCallback(async () => {
    const mine = ++generation.current;
    setPhase("loading");
    setRefusal(null);
    let ready: UsageSnapshot | null = null;
    let keyed: Refusal | null = null;
    try {
      const { status, body } = await postForm(
        `${apiBase()}/api/apps/${encodeURIComponent(String(appId))}/keys/usage`,
        { provider, keyId },
      );
      if (status === 200) {
        try {
          ready = parseUsageSnapshot(JSON.parse(body));
        } catch {
          /* body is not JSON */
        }
      } else {
        keyed = refusalOf(body);
      }
    } catch {
      /* transport failure — the failure face below covers it */
    }
    if (mine !== generation.current) return;
    if (ready === null) {
      setRefusal(keyed);
      setPhase("failed");
      return;
    }
    setSnapshot(ready);
    setPhase("ready");
  }, [appId, provider, keyId]);

  // Probe on open; the row's re-click remounts the panel (a new generation),
  // which re-posts through the same path and replaces the rendered snapshot.
  useEffect(() => {
    if (open) void probe();
  }, [open, probe]);

  // Escape collapses this panel only: panels in different cards coexist, so
  // just the one opened last owns the key, and an open modal layer above it
  // (the model picker, a step dialog) keeps its own Escape. Closing also
  // bumps the generation.
  useEffect(() => {
    if (!open) return;
    const token = {};
    openPanels.push(token);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openPanels[openPanels.length - 1] !== token) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return;
      generation.current += 1;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const at = openPanels.indexOf(token);
      if (at !== -1) openPanels.splice(at, 1);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div data-slot="usage-panel" className="border-t border-(--border-subtle) bg-(--surface-inset) px-3 py-3">
      {phase === "loading" ? <LoadingNotice locale={locale} /> : null}
      {phase === "failed" ? (
        <PageNotice
          kind="error"
          message={
            refusal === null
              ? t(locale, "settings.providers.usage.error")
              : t(locale, refusal.key, refusal.params)
          }
        />
      ) : null}
      {phase === "ready" && snapshot !== null ? (
        <UsageFace locale={locale} snapshot={snapshot} />
      ) : null}
    </div>
  );
}

function UsageFace({ locale, snapshot }: { locale: SpaBoot["locale"]; snapshot: UsageSnapshot }) {
  if (snapshot.status === "unauthorized") {
    return <PageNotice kind="error" message={t(locale, "settings.providers.usage.unauthorized")} />;
  }
  if (snapshot.status === "absent") {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          locale,
          snapshot.absentCause === "no-probe"
            ? "settings.providers.usage.absentNoProbe"
            : "settings.providers.usage.absentNothing",
        )}
      </p>
    );
  }
  if (snapshot.status === "error") {
    // The wire's `reason` is diagnostic vendor text — it never renders.
    return <PageNotice kind="error" message={t(locale, "settings.providers.usage.error")} />;
  }
  const windows = snapshot.limits.filter((limit) => limit.kind === "window");
  // A cell is claimed by any limit whose id segment names a known dimension —
  // a window with a percentage, or a balance the vendor states only as an
  // amount (Command Code's monthly pool). The cell draws no bar without a
  // fraction; it never invents one.
  const cells = CELL_SEGMENTS.map((segment) => ({
    segment,
    limit: snapshot.limits.find((limit) => segmentOf(limit) === segment),
  })).filter((cell): cell is { segment: CellSegment; limit: UsageLimit } => cell.limit !== undefined);
  const cellIds = new Set(cells.map((cell) => cell.limit.id));
  // Windows outside the known dimensions get a line each — no bar, but no
  // dropped information either.
  const lines = windows.filter((limit) => !cellIds.has(limit.id));
  const balances = snapshot.limits.filter((limit) => limit.kind !== "window" && !cellIds.has(limit.id));
  return (
    <div className="flex flex-col gap-3">
      {cells.length > 0 ? (
        <ul
          className="grid gap-3"
          // Cells share the row: a snapshot reporting one window fills it
          // instead of painting a third of it.
          style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
        >
          {cells.map((cell) => (
            <UsageCell key={cell.segment} locale={locale} segment={cell.segment} limit={cell.limit} />
          ))}
        </ul>
      ) : null}
      {lines.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {lines.map((limit, index) => (
            <UsageWindowLine
              key={limit.id}
              locale={locale}
              limit={limit}
              index={index}
              total={windows.length}
            />
          ))}
        </ul>
      ) : null}
      {balances.map((limit, index) => (
        <UsageBalance key={limit.id} locale={locale} limit={limit} index={index} total={snapshot.limits.length} />
      ))}
    </div>
  );
}

function segmentOf(limit: UsageLimit): string {
  return limit.id.slice(limit.id.lastIndexOf(":") + 1);
}

/** The window's remaining share in percent, or null when the snapshot states neither a fraction nor a derivable one. */
function remainingPercent(limit: UsageLimit): number | null {
  const fraction =
    typeof limit.usedFraction === "number"
      ? limit.usedFraction
      : typeof limit.remaining === "number" &&
          typeof limit.limit === "number" &&
          limit.limit > 0 &&
          limit.remaining >= 0
        ? 1 - limit.remaining / limit.limit
        : null;
  return fraction === null ? null : Math.max(0, Math.round((1 - fraction) * 100));
}

/** The muted detail line a window carries under its label or bar: remaining share, reset time, shared pool. */
function windowDetailLines(locale: SpaBoot["locale"], limit: UsageLimit): string[] {
  const remainingPct = remainingPercent(limit);
  const lines: string[] = [];
  if (remainingPct !== null) {
    lines.push(t(locale, "settings.providers.usage.windowRemaining", { percent: remainingPct }));
  } else if (typeof limit.remaining === "number") {
    // An amount-only cell (no stated cap): the remaining total is the whole
    // truth it has, so it says that rather than nothing.
    lines.push(
      t(locale, "settings.providers.usage.balanceRemaining", {
        amount: limit.remaining,
        unit: t(locale, `settings.providers.usage.unit.${limit.unit}`),
      }),
    );
  }
  // On-demand credits live in the same cell as the pool they sit beside; they
  // are a second amount, never a second row.
  if (typeof limit.extraRemaining === "number") {
    lines.push(
      t(locale, "settings.providers.usage.extraRemaining", {
        amount: limit.extraRemaining,
        unit: t(locale, `settings.providers.usage.unit.${limit.unit}`),
      }),
    );
  }
  if (typeof limit.resetsAt === "number") {
    lines.push(t(locale, "settings.providers.usage.resets", { time: formatUntil(limit.resetsAt, locale) }));
  }
  if (limit.shared === true) lines.push(t(locale, "settings.providers.usage.shared"));
  return lines;
}

/**
 * The row's semantic label: the segment after the last ":" of the normalized
 * limit id (e.g. `cline-pass:session` → `session`) mapped through the
 * dictionary. The id segment itself is NEVER rendered — for some providers
 * it is vendor bucket text (`cursor:planUsage`) — so an unknown segment
 * gets a generic label, numbered only when the snapshot holds more than
 * one limit.
 */
function limitLabel(locale: SpaBoot["locale"], limit: UsageLimit, index: number, total: number): string {
  const segment = segmentOf(limit);
  const key = `settings.providers.usage.window.${segment}`;
  if (isDictionaryKey(key)) return t(locale, key);
  return total > 1
    ? t(locale, "settings.providers.usage.limit.generic", { index: index + 1 })
    : t(locale, "settings.providers.usage.limit.genericSingle");
}

function UsageCell({
  locale,
  segment,
  limit,
}: {
  locale: SpaBoot["locale"];
  segment: CellSegment;
  limit: UsageLimit;
}) {
  const remainingPct = remainingPercent(limit);
  const lines = windowDetailLines(locale, limit);
  return (
    <li data-slot="usage-cell" className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{t(locale, `settings.providers.usage.window.${segment}`)}</p>
      {remainingPct !== null ? (
        // The hairline bar: inset track, accent fill sized by the REMAINING share.
        <div data-slot="usage-bar" className="h-1.5 w-full overflow-hidden rounded-full bg-(--surface-inset)">
          <div
            className="h-full rounded-full bg-(--tone-accent-solid)"
            style={{ width: `${remainingPct}%` }}
          />
        </div>
      ) : null}
      {lines.length > 0 ? (
        <p className="text-sm text-muted-foreground">{lines.join(" · ")}</p>
      ) : null}
    </li>
  );
}

/** A window of unknown dimension: one line, no fabricated bar. */
function UsageWindowLine({
  locale,
  limit,
  index,
  total,
}: {
  locale: SpaBoot["locale"];
  limit: UsageLimit;
  index: number;
  total: number;
}) {
  const lines = windowDetailLines(locale, limit);
  return (
    <li className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{limitLabel(locale, limit, index, total)}</p>
      {lines.length > 0 ? (
        <p className="text-sm text-muted-foreground">{lines.join(" · ")}</p>
      ) : null}
    </li>
  );
}

/** A balance renders as the muted bottom line — never a bar. */
function UsageBalance({
  locale,
  limit,
  index,
  total,
}: {
  locale: SpaBoot["locale"];
  limit: UsageLimit;
  index: number;
  total: number;
}) {
  const suffix = limit.shared === true ? ` · ${t(locale, "settings.providers.usage.shared")}` : "";
  // A balance the vendor stated without an amount has nothing truthful to
  // render — the muted absent copy, never a fabricated "0 credits remaining".
  if (typeof limit.remaining !== "number") {
    return (
      <p className="text-sm text-muted-foreground">{t(locale, "settings.providers.usage.absentNothing")}</p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {limitLabel(locale, limit, index, total)} —{" "}
      {t(locale, "settings.providers.usage.balanceRemaining", {
        amount: limit.remaining,
        unit: t(locale, `settings.providers.usage.unit.${limit.unit}`),
      })}
      {suffix}
    </p>
  );
}
