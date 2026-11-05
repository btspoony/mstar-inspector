/**
 * The per-key usage dialog (plan api-key-usage-probe T3): probes the
 * provider's own quota endpoint with this one key and reports whether the
 * key is still accepted and what remains of its allowance. The probe POSTs
 * `provider` + `keyId` as form data to `/api/apps/:appId/keys/usage` on open
 * and on Refresh — the refresh IS the cache (the plan forbids a polling or
 * server-cache layer), so a key that just went dead never shows a stale bar.
 *
 * Four faces on the snapshot: `ok` renders every limit — a window as a
 * hairline bar (`--surface-inset` track, `--tone-accent-solid` fill) with
 * the remaining share and its future reset time, a balance as the remaining
 * amount with its unit; `unauthorized` and `error` are danger notices;
 * `absent` is a muted line. The wire's diagnostic `reason` is never
 * rendered verbatim. A transport/HTTP/parse failure renders the same danger
 * notice as the wire's `error` face.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
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

  const probe = useCallback(async () => {
    setPhase("loading");
    try {
      const { status, body } = await postForm(
        `${apiBase()}/api/apps/${encodeURIComponent(String(appId))}/keys/usage`,
        { provider, keyId },
      );
      if (status !== 200) {
        setPhase("failed");
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        setPhase("failed");
        return;
      }
      const parsed = parseUsageSnapshot(raw);
      if (parsed === null) {
        setPhase("failed");
        return;
      }
      setSnapshot(parsed);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
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
        if (!next) onClose();
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
      {snapshot.limits.map((limit) => (
        <UsageLimitRow key={limit.id} locale={locale} limit={limit} />
      ))}
    </ul>
  );
}

function UsageLimitRow({ locale, limit }: { locale: SpaBoot["locale"]; limit: UsageLimit }) {
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
  return (
    <li className="text-sm text-muted-foreground">
      {t(locale, "settings.providers.usage.balanceRemaining", {
        amount: limit.remaining ?? 0,
        unit: t(locale, `settings.providers.usage.unit.${limit.unit}`),
      })}
      {suffix}
    </li>
  );
}
