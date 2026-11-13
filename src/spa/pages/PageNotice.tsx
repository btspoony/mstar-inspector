import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { t, type Locale } from "../../i18n";
import styles from "../pages.module.css";

export type NoticeKind = "success" | "warn" | "error";

/**
 * The v0.3 notice form — each kind gets its semantic glyph
 * over the tinted token face, so success and error read as distinct states
 * at a glance (DESIGN.md Notice: semantic 100 fill / 400 border / 900 text).
 * The glyph inherits the notice's fg token (currentColor), stays decorative
 * (aria-hidden — the message text is the announcement), and the channel
 * semantics are untouched: op-outcome notices and background-reload failures
 * keep riding this face (the AD-582 boundary).
 */
const NOTICE_ICONS = {
  success: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
} as const;

export function PageNotice({
  kind,
  message,
}: {
  kind: NoticeKind;
  message: string;
}) {
  const className =
    kind === "error" ? `${styles.notice} ${styles.noticeError}` : kind === "warn" ? `${styles.notice} ${styles.noticeWarn}` : styles.notice;
  const Icon = NOTICE_ICONS[kind];
  // WCAG 4.1.3: errors announce assertively (role=alert); success and warn
  // outcomes announce politely (role=status) instead of staying silent.
  return (
    <p className={className} role={kind === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/**
 * One op's outcome, resolved back to the card (or form cluster)
 * that produced it. Op feedback never rides the page-level notice channel —
 * that stays reserved for background-reload failures. `warn` is the tolerant
 * no-op face: a remove that matched nothing is neither a saved change nor a
 * failure, so it announces the no-change copy without claiming either.
 */
export type OpNotice = { kind: NoticeKind; message: string };

/**
 * A card's inline op-feedback region: the page banner's markup,
 * roles (alert/status) and notice tokens rendered INSIDE the card next to the
 * actions that produced the outcome. Regions are per action cluster, so the
 * feedback sits where the user is looking. A cluster's region may
 * also sit inside a card's grouped list — the providers remove outcome renders
 * inside the group the removed row belonged to. Clear rule (pinned): a
 * region's content is replaced wholesale by the next op targeting that same
 * region — no manual clears, no cross-card resets.
 */
/** How long a success notice stays on the op channel before it expires. */
export const SUCCESS_NOTICE_LIFETIME_MS = 3000;

export function NoticeRegion({ notice }: { notice: OpNotice | null }) {
  // A success notice expires on its own; warn and error keep today's
  // lifetime (replaced wholesale by the next op). The hide is local to the
  // region — the parent's state is never touched — and the clock restarts
  // when the notice is replaced. The reset happens during render so a fresh
  // notice shows immediately, and the timer clears on unmount.
  const [timedOut, setTimedOut] = useState(false);
  const [lastNotice, setLastNotice] = useState(notice);
  if (notice !== lastNotice) {
    setLastNotice(notice);
    setTimedOut(false);
  }
  useEffect(() => {
    if (notice?.kind !== "success") return;
    const timer = setTimeout(() => setTimedOut(true), SUCCESS_NOTICE_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice || (notice.kind === "success" && timedOut)) return null;
  return <PageNotice kind={notice.kind} message={notice.message} />;
}

export function LoadingNotice({ locale }: { locale: Locale }) {
  return <p className={styles.status}>{t(locale, "common.loading")}</p>;
}

export function LoadFailedNotice({ locale }: { locale: Locale }) {
  return <PageNotice kind="error" message={t(locale, "common.loadFailed")} />;
}
