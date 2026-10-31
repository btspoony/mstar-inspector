// Locally revised shadcn/ui copy-in (v0.3 restyle; a later copy-in supersede — do not regen over).
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "../cn"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-(--duration-base) ease-(--ease-in-out) outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-hover focus-visible:ring-destructive/20",
        outline:
          "border border-(--border-default) bg-background shadow-xs hover:border-(--border-strong) hover:bg-accent hover:text-accent-foreground active:border-(--border-strong) active:bg-accent active:text-accent-foreground",
        "destructive-outline":
          "border border-destructive bg-background text-destructive shadow-xs hover:bg-destructive/10 focus-visible:border-destructive focus-visible:ring-destructive/20",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-hover",
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground",
        link: "text-(--focus-ring) underline-offset-4 hover:underline",
      },
      // Heights are the three named control heights. `lg`/`icon-lg` keep their
      // call sites and share the `md` face (40px) — the system declares no
      // fourth height.
      size: {
        default: "h-(--control-h-md) px-4 py-2 has-[>svg]:px-3",
        xs: "h-(--control-h-xs) gap-1 rounded-sm px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--control-h-sm) gap-1.5 rounded-sm px-3 has-[>svg]:px-2.5",
        lg: "h-(--control-h-md) rounded-sm px-6 has-[>svg]:px-4",
        icon: "size-(--control-h-md)",
        "icon-xs": "size-(--control-h-xs) rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-(--control-h-sm)",
        "icon-lg": "size-(--control-h-md)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
