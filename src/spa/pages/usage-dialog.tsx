/**
 * The per-key usage dialog: probes the provider's own quota endpoint with
 * this one key and reports whether the key is still accepted and what
 * remains of its allowance. The probe POSTs `provider` + `keyId` as form
 * data to `/api/apps/:appId/keys/usage` on open and on Refresh — the
 * refresh IS the cache (there is deliberately no polling or server-side
 * cache layer), so a key that just went dead never shows a stale bar. A
 * generation guard discards responses that resolve after the dialog closed
 * or moved on to another key.
 *
 * Four faces on the snapshot: `ok` renders every limit — a window as a
 * hairline bar (`--surface-inset` track, `--tone-accent-solid` fill) with
 * the remaining share and its future reset time, a balance as the remaining
 * amount with its unit; `unauthorized` and `error` are danger notices;
 * `absent` is a muted line. The wire's diagnostic `reason` is never
 * rendered verbatim. A transport/HTTP/parse failure renders the same danger
 * notice as the wire's `error` face.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t, isDictionaryKey } from "../../i18n";
import { Button } from "@design-system";
import type { SpaBoot } from "../boot";
import { postForm } from "../api";
import { apiBase } from "../workspace-base";
import { formatUntil } from "../relative-time";
import { StepDialog } from "../components/StepDialog";
import { LoadingNotice, PageNotice } from "./PageNotice";
import { parseUsageSnapshot, type UsageLimit, type UsageSnapshot } from "./data";

type UsagePhase = "loading" | "ready" | "failed";

export function UsageDialog({
  locale,
  appId,
  open,
  provider,
  label,
  last4,
  keyId,
  onClose,
}: {
  locale: SpaBoot["locale"];
  /** The numeric GitHub App id — the same segment `/keys/verify` posts to. */
  appId: number;
  open: boolean;
  provider: string;
  /** The catalog label — the dialog is named by label + masked tail. */
  label: string;
  last4: string;
  keyId: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<UsagePhase>("loading");
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  // Generation guard: the dialog stays mounted across open/close and across
  // key switches, so a probe that resolves late must not set state under
  // another key's label or after close. Closing also bumps the generation.
  const generation = useRef(0);
  // Reset synchronously during render (the sanctioned adjust-state-on-prop-
  // change pattern): the effect below only starts the probe AFTER paint, so
  // without this the first reopened frame would paint the previous key's
  // snapshot under the new key's title.
  const [viewed, setViewed] = useState<{ open: boolean; keyId: string } | null>(null);
  if (viewed === null || viewed.open !== open || viewed.keyId !== keyId) {
    setViewed({ open, keyId });
    if (open) {
      setPhase("loading");
      setSnapshot(null);
    }
  }

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

  // Probe on open; Refresh re-posts through the same path and replaces the
  // rendered snapshot.
  useEffect(() => {
    if (open) void probe();
  }, [open, probe]);

  return (
    <StepDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        generation.current += 1;
        onClose();
      }}
      title={t(locale, "settings.providers.usage.title", { label })}
      description={t(locale, "settings.keyEnding", { last4 })}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => void probe()} disabled={phase === "loading"}>
            {t(locale, "settings.providers.usage.refresh")}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            {t(locale, "common.cancel")}
          </Button>
        </>
      }
    >
      {phase === "loading" ? <LoadingNotice locale={locale} /> : null}
      {phase === "failed" ? (
        <PageNotice kind="error" message={t(locale, "settings.providers.usage.error")} />
      ) : null}
      {phase === "ready" && snapshot !== null ? (
        <UsageFace locale={locale} snapshot={snapshot} />
      ) : null}
    </StepDialog>
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
  return (
    <ul className="flex flex-col gap-3">
      {snapshot.limits.map((limit, index) => (
        <UsageLimitRow key={limit.id} locale={locale} limit={limit} index={index} total={snapshot.limits.length} />
      ))}
    </ul>
  );
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
  const segment = limit.id.slice(limit.id.lastIndexOf(":") + 1);
  const key = `settings.providers.usage.window.${segment}`;
  if (isDictionaryKey(key)) return t(locale, key);
  return total > 1
    ? t(locale, "settings.providers.usage.limit.generic", { index: index + 1 })
    : t(locale, "settings.providers.usage.limit.genericSingle");
}

function UsageLimitRow({
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
  // The window's used share: the vendor's fraction wins; only when it is
  // absent do we derive one from stated remaining/limit counts.
  const fraction =
    typeof limit.usedFraction === "number"
      ? limit.usedFraction
      : typeof limit.remaining === "number" &&
          typeof limit.limit === "number" &&
          limit.limit > 0 &&
          limit.remaining >= 0
        ? 1 - limit.remaining / limit.limit
        : null;
  const suffix = limit.shared === true ? ` · ${t(locale, "settings.providers.usage.shared")}` : "";
  const label = <p className="text-sm font-medium">{limitLabel(locale, limit, index, total)}</p>;
  if (limit.kind === "window") {
    const remainingPct = fraction === null ? null : Math.max(0, Math.round((1 - fraction) * 100));
    const lines: string[] = [];
    if (remainingPct !== null) {
      lines.push(t(locale, "settings.providers.usage.windowRemaining", { percent: remainingPct }));
    }
    if (typeof limit.resetsAt === "number") {
      lines.push(
        t(locale, "settings.providers.usage.resets", { time: formatUntil(limit.resetsAt, locale) }),
      );
    }
    if (limit.shared === true) lines.push(t(locale, "settings.providers.usage.shared"));
    return (
      <li className="flex flex-col gap-1.5">
        {label}
        {remainingPct !== null ? (
          <>
            {/* The hairline bar: inset track, accent fill sized by the REMAINING share. */}
            <div data-slot="usage-bar" className="h-1.5 w-full overflow-hidden rounded-full bg-(--surface-inset)">
              <div
                className="h-full rounded-full bg-(--tone-accent-solid)"
                style={{ width: `${remainingPct}%` }}
              />
            </div>
          </>
        ) : null}
        {lines.length > 0 ? (
          <p className="text-sm text-muted-foreground">{lines.join(" · ")}</p>
        ) : null}
      </li>
    );
  }
  // A balance the vendor stated without an amount has nothing truthful to
  // render — the muted absent copy, never a fabricated "0 credits remaining".
  if (typeof limit.remaining !== "number") {
    return (
      <li className="flex flex-col gap-1.5">
        {label}
        <p className="text-sm text-muted-foreground">
          {t(locale, "settings.providers.usage.absentNothing")}
        </p>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1.5">
      {label}
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.providers.usage.balanceRemaining", {
          amount: limit.remaining,
          unit: t(locale, `settings.providers.usage.unit.${limit.unit}`),
        })}
        {suffix}
      </p>
    </li>
  );
}
