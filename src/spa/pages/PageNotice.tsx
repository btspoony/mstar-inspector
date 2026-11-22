import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { t, type Locale } from "../../i18n";
import styles from "../pages.module.css";

export type NoticeKind = "success" | "warn" | "error";

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

export const SUCCESS_NOTICE_LIFETIME_MS = 3000;

export function NoticeRegion({ notice }: { notice: OpNotice | null }) {
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

/**
 * The in-flight face of a status-driving save button. While the button shows
 * its spinner the glyph is aria-hidden, so without this region the write
 * would be silent between submit and outcome — the success and error faces
 * keep their own announcements. The region is the announcement channel
 * precisely BECAUSE the submitting control disables itself while busy: a
 * disabled, unfocused element's name change is not reliably announced
 * (submit-by-click blurs it, submit-by-Enter leaves focus in an input), so
 * the busy face a button swaps into its own label is not a channel. The
 * invariant for callers: `message` must match the busy face of the button
 * this region sits beside — a "Verify" face passes the verifying copy, a
 * "Save" face takes the default. Renders nothing in every other face.
 */
export function SaveInFlight({
  show,
  locale,
  message,
}: {
  show: boolean;
  locale: Locale;
  message?: string;
}) {
  if (!show) return null;
  return (
    <span role="status" className="sr-only">
      {message ?? t(locale, "common.saving")}
    </span>
  );
}

export function LoadFailedNotice({ locale }: { locale: Locale }) {
  return <PageNotice kind="error" message={t(locale, "common.loadFailed")} />;
}
