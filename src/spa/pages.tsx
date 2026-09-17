import type { SpaBoot } from "./boot";
import type { ClientRoute } from "./router";
import { t } from "../i18n";
import styles from "./pages.module.css";
import { AppDetailPage } from "./pages/AppDetailPage";
import { AppsPage } from "./pages/AppsPage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";

export function DashboardPage({ route, boot }: { route: ClientRoute; boot: SpaBoot }) {
  switch (route.page) {
    case "apps":
      return <AppsPage boot={boot} />;
    case "members":
      return <MembersPage boot={boot} />;
    case "login":
      return <LoginPage boot={boot} />;
    case "app-detail":
      return <AppDetailPage boot={boot} slug={route.slug} />;
    default:
      return <h1 className={styles.heading}>{t(boot.locale, "nav.brand")}</h1>;
  }
}
