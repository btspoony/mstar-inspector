import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { t, type Locale } from "../../i18n";
import styles from "../pages.module.css";

export type NoticeKind = "success" | "warn" | "error";

/**
 * Plan 59 T3 (A5): the v0.3 notice form — each kind gets its semantic glyph
 * over the tinted token face, so success and error read as distinct states
 * at a glance (DESIGN.md Notice: semantic 100 fill / 400 border / 900 text).
 * The glyph inherits the notice's fg token (currentColor), stays decorative
 * (aria-hidden — the message text is the announcement), and the channel
 * semantics are untouched: op-outcome notices and background-reload failures
 * keep riding this face (plan 38/44; AD-582 boundary).
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

export function LoadingNotice({ locale }: { locale: Locale }) {
  return <p className={styles.status}>{t(locale, "common.loading")}</p>;
}

export function LoadFailedNotice({ locale }: { locale: Locale }) {
  return <PageNotice kind="error" message={t(locale, "common.loadFailed")} />;
}
