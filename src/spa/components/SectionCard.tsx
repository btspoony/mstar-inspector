/**
 * AD-591 section idiom (plan 59 T1, consumed by plan 60): the two-tier
 * surface system for long settings-style pages, defined ONCE here — a page
 * picks a tier through the `tier` prop and never hand-assembles tier
 * classNames per block. Composes the copy-in `ui/card.tsx` primitives (the
 * sanctioned wrapper extension surface; the copy-in files stay untouched).
 *
 * - tier "primary" — identity/status surface: the card primitive's resting
 *   elevation (`shadow-card`) over a one-step-tinted border.
 * - tier "secondary" — configuration surface: flat (no elevation) on the
 *   token hairline (`border-border` → `--border` = gray-alpha-400). The
 *   card primitive's bare `border` carries width only — preflight leaves
 *   border-color at currentColor — so the tier face must supply the color.
 *
 * `SectionCardTitle` upgrades the card title face to the heading-16 token
 * step (DESIGN.md: heading-16 = section/card titles). `SectionGroup` carries
 * the group rhythm: an eyebrow label above a card stack — spacing-6 inside a
 * group, groups separated by spacing-8 (DESIGN.md Spacing & Layout).
 * All three are purely presentational: pages resolve `t()` themselves.
 */
import type { ComponentProps, ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SectionTier = "primary" | "secondary";

/** AD-591 tier faces — the only place tier styling is spelled out. */
const TIER_FACES: Record<SectionTier, string> = {
  primary: "border-(--gray-alpha-500)",
  secondary: "shadow-none border-border",
};

export function SectionCard({
  tier,
  className,
  ...props
}: ComponentProps<typeof Card> & { tier: SectionTier }) {
  return (
    <Card data-tier={tier} className={cn(TIER_FACES[tier], className)} {...props} />
  );
}

export function SectionCardTitle({ className, ...props }: ComponentProps<typeof CardTitle>) {
  return (
    <CardTitle
      className={cn(
        "text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)",
        className,
      )}
      {...props}
    />
  );
}

export function SectionGroup({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div data-slot="section-group" className={cn("flex flex-col gap-6", className)}>
      {/* Rhythm label, not a heading: the zone's own title (e.g. the App
          slug row) stays the heading tree's owner — no level interleave. */}
      <p
        data-slot="section-group-eyebrow"
        className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-muted-foreground"
      >
        {label}
      </p>
      {children}
    </div>
  );
}
