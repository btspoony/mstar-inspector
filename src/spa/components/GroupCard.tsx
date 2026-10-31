/**
 * Group card (DESIGN.md ### group-card): a set of children under one parent
 * object. The surface, hairline colour and container radius are ui/card's
 * `Card` — nothing is restated there; only Card's symmetric 24px padding is
 * split into the header band (`14px 16px`) and the body (`0 16px 14px`). No
 * divider sits under the header: the separation is carried by the caller's
 * list-row container. Purely presentational — the caller passes the
 * localized strings/nodes in.
 */
import type { ComponentProps, ReactNode } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
} from "@design-system";

export function GroupCard({ className, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card
      data-slot="group-card"
      className={cn("gap-0 p-0", className)}
      {...props}
    />
  );
}

export function GroupCardHeader({
  title,
  badge,
  summary,
  actions,
}: {
  title: ReactNode;
  /** The caller's StatusBadge — this shell adds no status face of its own. */
  badge?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <CardHeader className="px-4 py-3.5">
      <CardTitle className="flex items-center gap-2 text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
        {title}
        {badge}
      </CardTitle>
      {summary ? (
        <CardDescription className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--gray-700)">
          {summary}
        </CardDescription>
      ) : null}
      {actions ? <CardAction>{actions}</CardAction> : null}
    </CardHeader>
  );
}

export function GroupCardBody({ children }: { children: ReactNode }) {
  return <CardContent className="px-4 pt-0 pb-3.5">{children}</CardContent>;
}
