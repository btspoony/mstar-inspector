import { useEffect } from "react";
import { t } from "../../i18n";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";

export function LoginPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;

  useEffect(() => {
    if (boot.login) window.location.replace("/dashboard");
  }, [boot.login]);

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <h1 className={styles.heading}>{t(locale, "login.heading")}</h1>
        <p className={styles.lede}>{t(locale, "login.description")}</p>
        <form method="post" action="/dashboard/login">
          <button className={styles.btnPrimary} type="submit">
            {t(locale, "login.signIn")}
          </button>
        </form>
        <p className={styles.status}>{t(locale, "login.inviteOnly")}</p>
      </section>
    </div>
  );
}
