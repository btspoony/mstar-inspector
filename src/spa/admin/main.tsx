import { StrictMode, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/shadcn-theme.css";
import { t, type Locale } from "../../i18n";
import { otherLocale } from "../shell";
import { readBoot } from "../boot";
import { FlagsPage } from "./FlagsPage";
import { SupportGrantsPage } from "./SupportGrantsPage";
import { UsersPage } from "./UsersPage";
import { WorkspacesPage } from "./WorkspacesPage";
import { ADMIN_PAGES, type AdminPageId } from "./pages";

/**
 * The console's own document entry (`src/spa/admin.html`, a second Vite input).
 *
 * Deliberately NOT the workspace shell (`../main.tsx`, `../Layout`): that shell
 * carries workspace chrome, workspace boot reads and the workspace router, and
 * reusing it would put admin paths into `src/spa/routes.ts`. Navigation here is
 * the local matcher over `ADMIN_PAGES`; the Worker serves this same document
 * for every page path, after the operator gate — so nothing renders for an
 * outsider, and the document's existence is never confirmed.
 *
 * Bilingual like the workspace shell: `readBoot()` carries `boot.locale`
 * (falling back to `en` when the boot was never injected), the header/nav copy
 * resolves through `t(locale, …)`, and the locale switch is the SAME zero-JS
 * form the workspace shell uses (`../Layout.tsx`) — one POST to
 * `/dashboard/locale`, the 302 re-GETs this document with the new cookie, and
 * the server re-injects the boot. No SPA locale state.
 *
 * `SCREENS` is keyed by the page id union, so a screen without a page (or a
 * page without a screen) is a compile error rather than a blank route.
 */
const SCREENS: Record<AdminPageId, ComponentType<{ locale: Locale }>> = {
  flags: FlagsPage,
  workspaces: WorkspacesPage,
  users: UsersPage,
  "support-grants": SupportGrantsPage,
};

export function App() {
  const boot = readBoot();
  const locale = boot.locale;
  const segment = window.location.pathname.split("/").filter(Boolean)[1];
  const page = ADMIN_PAGES.find((entry) => entry.id === segment) ?? ADMIN_PAGES[0];

  return (
    <div className="admin">
      <header className="admin-header">
        <div>
          <h1>{t(locale, "admin.header.title")}</h1>
          <p className="muted">{boot.login ?? t(locale, "admin.header.signedOut")}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/dashboard">{t(locale, "admin.header.dashboardLink")}</a>
          {/*
           * Zero-JS locale switch — same form as the workspace shell: POST
           * /dashboard/locale sets the cookie and 302s back here; the
           * re-GETted document carries the new boot.locale.
           */}
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
      <main className="admin-main">{createElement(SCREENS[page.id], { locale })}</main>
    </div>
  );
}

// Guarded so the module can be imported by tests before a DOM exists; in the
// real document #root is always present.
const root = typeof document === "undefined" ? null : document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
