import { StrictMode, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/shadcn-theme.css";
import { t, type Locale } from "../../i18n";
import { otherLocale } from "../shell";
import { readBoot } from "../boot";
import { BotsPage } from "./BotsPage";
import { DataUpgradePage } from "./DataUpgradePage";
import { FlagsPage } from "./FlagsPage";
import { RuntimePage } from "./RuntimePage";
import { QuotaVersionsPage } from "./QuotaVersionsPage";
import { SupportGrantsPage } from "./SupportGrantsPage";
import { UsagePage } from "./UsagePage";
import { UsersPage } from "./UsersPage";
import { WorkspacesPage } from "./WorkspacesPage";
import { ADMIN_PAGES, type AdminPageId } from "./pages";

const SCREENS: Record<AdminPageId, ComponentType<{ locale: Locale }>> = {
  flags: FlagsPage,
  runtime: RuntimePage,
  workspaces: WorkspacesPage,
  bots: BotsPage,
  usage: UsagePage,
  "quota-versions": QuotaVersionsPage,
  users: UsersPage,
  "support-grants": SupportGrantsPage,
  "data-upgrades": DataUpgradePage,
};

export function App() {
  const boot = readBoot();
  const locale = boot.locale;
  const segment = window.location.pathname.split("/").filter(Boolean)[1];
  const page = ADMIN_PAGES.find((entry) => entry.id === segment) ?? ADMIN_PAGES[0];

  return (
    <div className="admin">
      <header className="admin-header border-b border-(--border-default)">
        <div>
          <h1>{t(locale, "admin.header.title")}</h1>
          <p className="muted">{boot.login ?? t(locale, "admin.header.signedOut")}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/dashboard">{t(locale, "admin.header.dashboardLink")}</a>
          <form className="m-0" method="post" action="/dashboard/locale">
            <input type="hidden" name="locale" value={otherLocale(locale)} />
            <button type="submit" className="admin-locale-switch">
              {t(locale, "nav.language")}
            </button>
          </form>
        </div>
      </header>
      <nav className="admin-nav">
        {ADMIN_PAGES.map((entry) => (
          <a
            key={entry.id}
            href={`/_internal_admin/${entry.id}`}
            aria-current={entry.id === page.id ? "page" : undefined}
          >
            {t(locale, entry.labelKey)}
          </a>
        ))}
      </nav>
      <main className="admin-main rounded-(--radius-container) border border-(--border-default)">
        {createElement(SCREENS[page.id], { locale })}
      </main>
    </div>
  );
}

const root = typeof document === "undefined" ? null : document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
