// shortcut: Locally revised shadcn/ui copy-in (v0.3 restyle; a later copy-in supersede — do not regen over); removal tracked in tests/spa/tokens.test.ts.
import { cn } from "../cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
