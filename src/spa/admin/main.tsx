import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/shadcn-theme.css";
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
 * `SCREENS` is keyed by the page id union, so a screen without a page (or a
 * page without a screen) is a compile error rather than a blank route.
 */
const SCREENS: Record<AdminPageId, ReactElement> = {
  flags: <FlagsPage />,
  workspaces: <WorkspacesPage />,
  users: <UsersPage />,
  "support-grants": <SupportGrantsPage />,
};

function App() {
  const boot = readBoot();
  const segment = window.location.pathname.split("/").filter(Boolean)[1];
  const page = ADMIN_PAGES.find((entry) => entry.id === segment) ?? ADMIN_PAGES[0];

  return (
    <div className="admin">
      <header className="admin-header">
        <div>
          <h1>Platform operations</h1>
          <p className="muted">{boot.login ?? "signed out"}</p>
        </div>
        <a href="/dashboard">Workspace dashboard</a>
      </header>
      <nav className="admin-nav">
        {ADMIN_PAGES.map((entry) => (
          <a
            key={entry.id}
            href={`/_internal_admin/${entry.id}`}
            aria-current={entry.id === page.id ? "page" : undefined}
          >
            {entry.label}
          </a>
        ))}
      </nav>
      <main className="admin-main">{SCREENS[page.id]}</main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("admin document root #root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
