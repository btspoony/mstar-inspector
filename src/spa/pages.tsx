import { t, type Locale } from "../i18n";
import type { ClientRoute } from "./router";
import styles from "./Layout.module.css";

export function PageStub({ route, locale }: { route: ClientRoute; locale: Locale }) {
  const heading = headingFor(route, locale);
  return <h1 className={styles.heading}>{heading}</h1>;
}

function headingFor(route: ClientRoute, locale: Locale): string {
  switch (route.page) {
    case "apps":
      return t(locale, "apps.heading");
    case "insights":
      return t(locale, "insights.heading");
    case "members":
      return t(locale, "members.heading");
    case "login":
      return t(locale, "login.heading");
    case "settings":
      return `${t(locale, "settings.title")} — ${route.slug}`;
    default:
      return t(locale, "nav.brand");
  }
}
