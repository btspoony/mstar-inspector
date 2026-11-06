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
 * Four faces on the snapshot: `ok` renders the known window dimensions
 * (session / week / month) as a three-cell bar row — a hairline bar
 * (`--surface-inset` track, `--tone-accent-solid` fill) with the remaining
 * share and its future reset time — windows of unknown dimensions fall back
 * to one line per window so nothing is dropped, and a balance renders as
 * the muted bottom line; `unauthorized` and `error` are danger notices;
 * `absent` is a muted line. The wire's diagnostic `reason` is never
 * rendered verbatim. A transport/HTTP/parse failure renders the same danger
 * notice as the wire's `error` face.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t, isDictionaryKey } from "../../i18n";
import type { SpaBoot } from "../boot";
import { postForm } from "../api";
import { apiBase } from "../workspace-base";
import { formatUntil } from "../relative-time";
import { LoadingNotice, PageNotice } from "./PageNotice";
import { parseUsageSnapshot, type UsageLimit, type UsageSnapshot } from "./data";

type UsagePhase = "loading" | "ready" | "failed";

/** The window dimensions that earn a bar cell, in their fixed display order. */
const CELL_SEGMENTS = ["session", "week", "month"] as const;
type CellSegment = (typeof CELL_SEGMENTS)[number];

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
  // Generation guard: the parent keeps the panel mounted across re-probes of
  // the same key (a fresh mount per key), so a probe that resolves late must
  // not set state under another key's row or after close.
  const generation = useRef(0);

  const probe = useCallback(async () => {
    const mine = ++generation.current;
    setPhase("loading");
    let ready: UsageSnapshot | null = null;
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
      }
    } catch {
      /* transport failure — the failure face below covers it */
    }
    if (mine !== generation.current) return;
    if (ready === null) {
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

  // Escape collapses the disclosure; closing also bumps the generation.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      generation.current += 1;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div data-slot="usage-panel" className="border-t border-(--border-subtle) bg-(--surface-inset) px-3 py-3">
      {phase === "loading" ? <LoadingNotice locale={locale} /> : null}
      {phase === "failed" ? (
        <PageNotice kind="error" message={t(locale, "settings.providers.usage.error")} />
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
  const cells = CELL_SEGMENTS.map((segment) => ({
    segment,
    limit: windows.find((windowLimit) => segmentOf(windowLimit) === segment),
  })).filter((cell): cell is { segment: CellSegment; limit: UsageLimit } => cell.limit !== undefined);
  // Windows outside the known dimensions get a line each — no bar, but no
  // dropped information either.
  const lines = windows.filter(
    (limit) => !(CELL_SEGMENTS as readonly string[]).includes(segmentOf(limit)),
  );
  const balances = snapshot.limits.filter((limit) => limit.kind !== "window");
  return (
    <div className="flex flex-col gap-3">
      {cells.length > 0 ? (
        <ul className="grid grid-cols-3 gap-3">
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
