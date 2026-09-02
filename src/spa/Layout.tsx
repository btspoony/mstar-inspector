/**
 * Dashboard chrome (plan 29 T3): locked navbar order
 * `[Apps] [Insights] [Members] [EN/中文] {name (login)} [Logout]`.
 */
import type { MouseEvent, ReactNode } from "react";
import type { SpaBoot } from "./boot";
import { buildNavbarModel } from "./navbar";
import { matchSpaRoute } from "./routes";
import { navigate } from "./router";
import styles from "./Layout.module.css";

type LayoutProps = {
  boot: SpaBoot;
  pathname: string;
  children: ReactNode;
};

function Logo() {
  return (
    <svg className={styles.logo} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 4 L13.2 10.2 L20 12 L13.2 13.8 L12 20 L10.8 13.8 L4 12 L10.8 10.2 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function spaClick(href: string, event: MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!matchSpaRoute(href)) return;
  event.preventDefault();
  navigate(href);
}

export function Layout({ boot, pathname, children }: LayoutProps) {
  const nav = buildNavbarModel(boot, pathname);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href="/dashboard">
          <Logo />
          <span>{nav.brand}</span>
        </a>
        <nav className={styles.actions} aria-label={nav.brand}>
          {nav.items.map((item) => (
            <a
              key={item.href}
              className={styles.navBtn}
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              onClick={(event) => spaClick(item.href, event)}
            >
              {item.label}
            </a>
          ))}
          <form className={styles.langForm} method="post" action="/dashboard/locale">
            <input type="hidden" name="locale" value={nav.languageTarget} />
            <button className={styles.langBtn} type="submit">
              {nav.languageLabel}
            </button>
          </form>
          {nav.accountLabel ? <span className={styles.account}>{nav.accountLabel}</span> : null}
          {boot.login ? (
            <a className={styles.navBtn} href="/dashboard/logout">
              {nav.logoutLabel}
            </a>
          ) : null}
        </nav>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
