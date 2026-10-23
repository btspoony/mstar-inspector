import type { SpaBoot } from "./boot";
import type { ClientRoute } from "./router";
import { t } from "../i18n";
import styles from "./pages.module.css";
import { AppDetailPage } from "./pages/AppDetailPage";
import { AppsPage } from "./pages/AppsPage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { SupportPage } from "./pages/SupportPage";
import { WorkspaceSetupPage } from "./pages/WorkspaceSetupPage";

export function DashboardPage({ route, boot }: { route: ClientRoute; boot: SpaBoot }) {
  // A login with no workspace sees creation, not the workspace pages: its API
  // reads would 404 (sign-in joins nobody).
  if (boot.needsWorkspace === true && route.page !== "login") {
    return <WorkspaceSetupPage boot={boot} />;
  }
  // A platform operator under a support grant sees ONE read-only face, whatever
  // workspace page the URL names: every other page here would only 403 its own
  // data reads. The grant, not the path, decides what an operator may read.
  if (boot.supportOnly === true && route.page !== "login") {
    return <SupportPage boot={boot} />;
  }
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
