import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/shadcn-theme.css";
import { readBoot } from "../boot";
import { ADMIN_PAGES } from "./pages";

/**
 * The console's own document entry (`src/spa/admin.html`, a second Vite input).
 *
 * Deliberately NOT the workspace shell (`../main.tsx`, `../Layout`): that shell
 * carries workspace chrome, workspace boot reads and the workspace router, and
 * reusing it would put admin paths into `src/spa/routes.ts`. Navigation here is
 * the local matcher over `ADMIN_PAGES`; the Worker serves this same document
 * for every page path, after the operator gate — so nothing renders for an
 * outsider, and the document's existence is never confirmed.
 */
function App() {
  const boot = readBoot();
  const segment = window.location.pathname.split("/").filter(Boolean)[1];
  const page = ADMIN_PAGES.find((entry) => entry.id === segment) ?? ADMIN_PAGES[0];
  const [apiLogin, setApiLogin] = useState<string | null>(null);

  // The API round-trip is the wiring proof: the same per-request gate guards
  // it, so a rendered document with no answering API means the gate leaked.
  useEffect(() => {
    fetch("/_internal_admin/api/me")
      .then((res) => (res.ok ? (res.json() as Promise<{ login: string }>) : null))
      .then((body) => setApiLogin(body?.login ?? null))
      .catch(() => setApiLogin(null));
  }, []);

  return (
    <div className="admin">
      <header className="admin-header">
        <div>
          <h1>Platform operations</h1>
          <p className="muted">
            {boot.login ?? "signed out"} · API {apiLogin ?? "—"}
          </p>
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
      <main className="admin-main">
        <h2>{page.label}</h2>
        <p className="muted">Wired end to end; this screen's data arrives in the next tasks of plan 116.</p>
      </main>
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
