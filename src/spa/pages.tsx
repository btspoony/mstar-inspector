import type { SpaBoot } from "./boot";
import type { ClientRoute } from "./router";
import { t } from "../i18n";
import styles from "./pages.module.css";
import { AppDetailPage } from "./pages/AppDetailPage";
import { BotDetailPage } from "./pages/BotDetailPage";
import { AppsPage } from "./pages/AppsPage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { SupportPage } from "./pages/SupportPage";
import { TargetDetailPage, TargetsPage } from "./pages/TargetsPage";
import { WorkspaceSetupPage } from "./pages/WorkspaceSetupPage";
import { WorkspaceSettingsPage } from "./pages/WorkspaceSettingsPage";

export function DashboardPage({ route, boot }: { route: ClientRoute; boot: SpaBoot }) {
  if (boot.needsWorkspace === true && route.page !== "login") {
    return <WorkspaceSetupPage boot={boot} />;
  }
  if (boot.supportOnly === true && route.page !== "login") {
    return <SupportPage boot={boot} />;
  }
  switch (route.page) {
    case "repos":
      return route.targetId ? (
        <TargetDetailPage boot={boot} targetId={route.targetId} />
      ) : (
        <TargetsPage boot={boot} />
      );
    case "apps":
      return <AppsPage boot={boot} />;
    case "members":
      return <MembersPage boot={boot} />;
    case "settings":
      return <WorkspaceSettingsPage boot={boot} />;
    case "login":
      return <LoginPage boot={boot} />;
    case "app-detail":
      return <AppDetailPage boot={boot} appId={route.appId} />;
    case "bot-detail":
      return <BotDetailPage boot={boot} botId={route.botId} />;
    default:
      return <h1 className={styles.heading}>{t(boot.locale, "nav.brand")}</h1>;
  }
}
