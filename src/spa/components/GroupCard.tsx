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
  badge?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <CardHeader className="min-h-(--row-h-comfort) items-center px-4 py-2">
      <CardTitle className="flex items-center gap-2 text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
        {title}
        {badge}
      </CardTitle>
      {summary ? (
        <CardDescription className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--text-muted)">
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
