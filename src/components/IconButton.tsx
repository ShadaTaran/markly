import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * UI/UX quality pass — the exact same
 * "rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground
 * focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
 * string was hand-copied across Dialog's close button, ItemActionsMenu's
 * trigger, SearchBar's clear button, the favorite star, and more. `aria-label`
 * is required (not optional) at the type level — an icon-only control with
 * no accessible name is exactly the defect class this primitive exists to
 * prevent from recurring.
 */
interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  "aria-label": string;
  icon: ReactNode;
  /** For a toggleable affordance (e.g. favorite) — tints the icon instead of requiring a one-off override. */
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, active, type = "button", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "rounded p-2.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        active && "text-amber-500 hover:text-amber-500",
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});
