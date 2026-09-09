import { useEffect } from "react";
import { t } from "../../i18n";
import styles from "../pages.module.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "../components/AppSidebar";
import type { SpaBoot } from "../boot";

// lucide-react ships no GitHub brand mark — inline the octocat silhouette.
// Plan 53: exported for the settings page's avatar placeholder (same mark,
// sized at the usage site via `className`).
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/**
 * Plan 58 A3 login facade (clarify-locked form: centered-card reinforced).
 * The T1 sidebar wordmark echoes above the card (same Logo silhouette +
 * `nav.brand`); the concise card title rides the DESIGN.md heading-32 step
 * ("login wordmark-scale titles"). The GitHub POST, the signed-in redirect,
 * and every dictionary key keep their plan-33 behavior — this is a face
 * change only.
 */
export function LoginPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;

  useEffect(() => {
    if (boot.login) window.location.replace("/dashboard");
  }, [boot.login]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2">
        <Logo />
        <span className="text-sm font-semibold tracking-tight">{t(locale, "nav.brand")}</span>
      </div>
      <Card className={`w-full max-w-sm ${styles.loginEnter}`}>
        <CardHeader>
          <CardTitle className="text-(length:--typo-heading-32-size) leading-(--typo-heading-32-line) tracking-(--typo-heading-32-tracking)">
            {t(locale, "login.heading")}
          </CardTitle>
          <CardDescription>{t(locale, "login.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form method="post" action="/dashboard/login">
            <Button type="submit" size="lg" className="w-full">
              <GitHubMark />
              {t(locale, "login.signIn")}
            </Button>
          </form>
          <p className="text-sm text-muted-foreground">{t(locale, "login.inviteOnly")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
