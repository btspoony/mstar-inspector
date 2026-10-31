/**
 * Class-name composition for the primitive tier.
 *
 * `tailwind-merge` collapses conflicting utilities so a caller's `className`
 * overrides the primitive's own face instead of racing it; `clsx` handles the
 * conditionals. It lives inside the module because every primitive needs it
 * and the module may not depend on the SPA that consumes it.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
