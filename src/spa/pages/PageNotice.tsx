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
  return (
    <p className={className} role={kind === "error" ? "alert" : undefined}>
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
