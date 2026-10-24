import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/shadcn-theme.css";
import { readBoot } from "./boot";
import { takeFlash } from "./flash";
import { Layout } from "./Layout";
import { DashboardPage } from "./pages";
import { Router, matchRoute, usePathname } from "./router";

/**
 * One-shot outcome carried over from the previous page (the delete flow).
 * Read and cleared once per page load, before React mounts — a render-time
 * read would be re-run by StrictMode's development double-invoke and lose it.
 */
const flash = takeFlash();

function App() {
  const boot = readBoot();
  const pathname = usePathname();
  const route = matchRoute(pathname);

  // SPA router fallback guard — the server 302s first; this
  // catches any shell that renders without a session (defense in depth).
  // The login page itself is exempt (no self-loop).
  useEffect(() => {
    if (!boot.login && route.page !== "login") {
      window.location.replace("/dashboard/login");
    }
  }, [boot.login, route.page]);

  return (
    <Layout boot={boot} pathname={pathname} flash={flash}>
      <Router>{(route) => <DashboardPage route={route} boot={boot} />}</Router>
    </Layout>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("SPA root #root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
