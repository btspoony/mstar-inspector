import { t } from "../../i18n";
import type { SpaBoot } from "../boot";
import styles from "../Home.module.css";
import { AppsPage } from "./AppsPage";
import { InsightsSidebar } from "./InsightsSidebar";

/**
 * `/dashboard` workbench: Apps list as the main column (reuses AppsPage)
 * plus the overall insights sidebar. No new aggregation — both columns
 * call the existing `/dashboard/api/apps` and `/dashboard/api/insights/summary`.
 */
export function HomePage({ boot }: { boot: SpaBoot }) {
  return (
    <div className={styles.home}>
      <section className={styles.main} aria-label={t(boot.locale, "apps.heading")}>
        <AppsPage boot={boot} />
      </section>
      <aside className={styles.sidebar} aria-label={t(boot.locale, "home.insightsHeading")}>
        <InsightsSidebar boot={boot} />
      </aside>
    </div>
  );
}
