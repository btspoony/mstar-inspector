import type { ComponentProps } from "react";
import { Card, CardTitle, cn } from "@design-system";

type SectionTier = "primary" | "secondary";

const TIER_FACES: Record<SectionTier, string> = {
  primary: "border-(--border-strong)",
  secondary: "border-(--border-default)",
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
