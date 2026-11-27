import { useCallback, useEffect, useRef, useState } from "react";
import { t, isDictionaryKey, type DictionaryKey } from "../../i18n";
import type { SpaBoot } from "../boot";
import { postForm } from "../api";
import { apiBase } from "../workspace-base";
import { formatUntil } from "../relative-time";
import { LoadingNotice, PageNotice } from "./PageNotice";
import { parseUsageSnapshot, type UsageLimit, type UsageSnapshot } from "./data";

type UsagePhase = "loading" | "ready" | "failed";

type Refusal = { key: DictionaryKey; params?: Record<string, string | number> };

function isParamValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

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

const CELL_SEGMENTS = ["session", "week", "month"] as const;
type CellSegment = (typeof CELL_SEGMENTS)[number];

const openPanels: object[] = [];

export function UsagePanel({
  locale,
  botId,
  provider,
  keyId,
  open,
  onClose,
}: {
  locale: SpaBoot["locale"];
  botId: string;
  provider: string;
  keyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<UsagePhase>("loading");
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const generation = useRef(0);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const probe = useCallback(async () => {
    const mine = ++generation.current;
    setPhase("loading");
    setRefusal(null);
    let ready: UsageSnapshot | null = null;
    let keyed: Refusal | null = null;
    try {
      const { status, body } = await postForm(
        `${apiBase()}/api/review-bots/${encodeURIComponent(botId)}/keys/usage`,
        { provider, keyId },
      );
      if (status === 200) {
        try {
          ready = parseUsageSnapshot(JSON.parse(body));
        } catch {
        }
      } else {
        keyed = refusalOf(body);
      }
    } catch {
    }
    if (mine !== generation.current) return;
    if (ready === null) {
      setRefusal(keyed);
      setPhase("failed");
      return;
    }
    setSnapshot(ready);
    setPhase("ready");
  }, [botId, provider, keyId]);

  useEffect(() => {
    if (open) void probe();
  }, [open, probe]);

  useEffect(() => {
    if (!open) return;
    const token = {};
    openPanels.push(token);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openPanels[openPanels.length - 1] !== token) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return;
      generation.current += 1;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const at = openPanels.indexOf(token);
      if (at !== -1) openPanels.splice(at, 1);
    };
  }, [open]);

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
    return <PageNotice kind="error" message={t(locale, "settings.providers.usage.error")} />;
  }
  const windows = snapshot.limits.filter((limit) => limit.kind === "window");
  const cells = CELL_SEGMENTS.map((segment) => ({
    segment,
    limit: snapshot.limits.find((limit) => segmentOf(limit) === segment),
  })).filter((cell): cell is { segment: CellSegment; limit: UsageLimit } => cell.limit !== undefined);
  const cellIds = new Set(cells.map((cell) => cell.limit.id));
  const lines = windows.filter((limit) => !cellIds.has(limit.id));
  const balances = snapshot.limits.filter((limit) => limit.kind !== "window" && !cellIds.has(limit.id));
  return (
    <div className="flex flex-col gap-3">
      {cells.length > 0 ? (
        <ul
          className="grid gap-3"
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

function windowDetailLines(locale: SpaBoot["locale"], limit: UsageLimit): string[] {
  const remainingPct = remainingPercent(limit);
  const lines: string[] = [];
  if (remainingPct !== null) {
    lines.push(t(locale, "settings.providers.usage.windowRemaining", { percent: remainingPct }));
  } else if (typeof limit.remaining === "number") {
    lines.push(
      t(locale, "settings.providers.usage.balanceRemaining", {
        amount: limit.remaining,
        unit: t(locale, `settings.providers.usage.unit.${limit.unit}`),
      }),
    );
  }
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
