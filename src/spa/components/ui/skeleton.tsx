// Locally revised shadcn/ui copy-in (plan 57 T3 v0.3 restyle; 018 copy-in supersede — do not regen over).
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    // The pulse is a semantic loading indicator (allowed infinite loop), and
    // motion-reduce:animate-none folds it under prefers-reduced-motion —
    // the token-level duration fold cannot cover this raw-duration keyframe.
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
