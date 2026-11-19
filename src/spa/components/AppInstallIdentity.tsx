import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { t } from "../../i18n";
import type { SpaBoot } from "../boot";
import { AppAvatar } from "./AppAvatar";

/** GitHub's install page for an App slug; null when the slug is absent or blank. */
export function appInstallHref(slug: string | null): string | null {
  if (slug === null || slug.trim() === "") return null;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/**
 * The shared App identity row: avatar, name, and (when a slug is known) the
 * link to the GitHub install page. Callers put their own state-specific
 * content — pending binds, claim actions, bound-account notes — in children,
 * rendered after the link.
 */
export function AppInstallIdentity({ locale, name, avatarSrc, appId, href, children }: {
  locale: SpaBoot["locale"];
  name: string;
  avatarSrc: string | null;
  appId?: number;
  href: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <AppAvatar
        src={avatarSrc}
        appId={appId}
        className="h-10 w-10 shrink-0 rounded-full border border-(--border-default) object-cover"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{name}</p>
        {href === null ? null : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
            aria-label={t(locale, "settings.installLinkAria", { name })}
          >
            {t(locale, "settings.installLink")}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </a>
        )}
        {children}
      </div>
    </div>
  );
}
