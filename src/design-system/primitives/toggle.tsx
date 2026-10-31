// Locally revised shadcn/ui copy-in (motion-token sweep — every
// duration/easing consumes --duration-*/--ease-*, transition properties
// unchanged; a later copy-in supersede — do not regen over).
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import * as TogglePrimitive from "@radix-ui/react-toggle"

import { cn } from "../cn"

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] duration-(--duration-base) ease-(--ease-in-out) outline-none hover:bg-muted hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground",
      },
      // Same three named control heights as the button; `lg` shares `md`.
      size: {
        default: "h-(--control-h-md) min-w-(--control-h-md) px-2",
        sm: "h-(--control-h-sm) min-w-(--control-h-sm) px-1.5",
        lg: "h-(--control-h-md) min-w-(--control-h-md) px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
