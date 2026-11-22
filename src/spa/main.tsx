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

const flash = takeFlash();

function App() {
  const boot = readBoot();
  const pathname = usePathname();
  const route = matchRoute(pathname);

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
