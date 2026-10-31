/**
 * AD-591 section idiom: the two-tier
 * surface system for long settings-style pages, defined ONCE here — a page
 * picks a tier through the `tier` prop and never hand-assembles tier
 * classNames per block. Composes `Card` from `@design-system`: the primitives
 * are module internals, so the barrel is the only door (pinned by
 * `tests/design-system/boundary.test.ts`).
 *
 * The r3 rule the tiers now follow: a hairline plus the card's surface step
 * carries the definition, and elevation is the overlays' job — no inline card
 * lifts off the page. The tiers differ by hairline strength alone:
 *
 * - tier "primary" — identity/status surface: the emphasis hairline.
 * - tier "secondary" — configuration surface: the standard hairline.
 *
 * Each face names its border colour token explicitly. The card primitive's
 * bare `border` carries width only — preflight leaves `border-color` at
 * currentColor — and relying on the primitive's own edge would make the tier
 * distinction depend on a value this file does not state.
 *
 * `SectionCardTitle` upgrades the card title face to the heading-16 token
 * step (DESIGN.md: heading-16 = section/card titles).
 * Both are purely presentational: pages resolve `t()` themselves.
 *
 * A page's own body — a settings tab, a detail page — is a section flow
 * (`FlowSection`), not a stack of these cards: a card frames an object that
 * has to be framed (a table, a form cluster, the operator console's panels).
 */
import type { ComponentProps } from "react";
import { Card, CardTitle, cn } from "@design-system";

type SectionTier = "primary" | "secondary";

/** AD-591 tier faces — the only place tier styling is spelled out. */
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
