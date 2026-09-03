import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/shadcn-theme.css";
import { readBoot } from "./boot";
import { Layout } from "./Layout";
import { DashboardPage } from "./pages";
import { Router, matchRoute, usePathname } from "./router";

function App() {
  const boot = readBoot();
  const pathname = usePathname();
  const route = matchRoute(pathname);

  // Plan 33 T3: SPA router fallback guard — the server 302s first; this
  // catches any shell that renders without a session (defense in depth).
  // The login page itself is exempt (no self-loop).
  useEffect(() => {
    if (!boot.login && route.page !== "login") {
      window.location.replace("/dashboard/login");
    }
  }, [boot.login, route.page]);

  return (
    <Layout boot={boot} pathname={pathname}>
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
