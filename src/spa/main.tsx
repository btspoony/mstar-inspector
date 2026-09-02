import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import { readBoot } from "./boot";
import { Layout } from "./Layout";
import { PageStub } from "./pages";
import { Router, usePathname } from "./router";

function App() {
  const boot = readBoot();
  const pathname = usePathname();
  return (
    <Layout boot={boot} pathname={pathname}>
      <Router>{(route) => <PageStub route={route} locale={boot.locale} />}</Router>
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
