import { t, type Locale } from "../../i18n";
import styles from "../pages.module.css";

export type NoticeKind = "success" | "warn" | "error";

export function PageNotice({
  kind,
  message,
}: {
  kind: NoticeKind;
  message: string;
}) {
  const className =
    kind === "error" ? `${styles.notice} ${styles.noticeError}` : kind === "warn" ? `${styles.notice} ${styles.noticeWarn}` : styles.notice;
  // WCAG 4.1.3: errors announce assertively (role=alert); success and warn
  // outcomes announce politely (role=status) instead of staying silent.
  return (
    <p className={className} role={kind === "error" ? "alert" : "status"}>
      {message}
    </p>
  );
}

export function LoadingNotice({ locale }: { locale: Locale }) {
  return <p className={styles.status}>{t(locale, "common.loading")}</p>;
}

export function LoadFailedNotice({ locale }: { locale: Locale }) {
  return <PageNotice kind="error" message={t(locale, "common.loadFailed")} />;
}
