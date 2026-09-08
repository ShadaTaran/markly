import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * UI/UX quality pass — every dialog/panel previously hand-wrote its own
 * primary/secondary/destructive button className string (confirmed
 * near-identical across ConfirmDialog, DeleteLibraryItemDialog,
 * CollectionDialog, LibraryView's inline buttons, ...). A narrow variant
 * enum, not a giant prop bag — composition (className, onClick, disabled,
 * type, ...) still comes straight from native button props.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-foreground text-background hover:bg-foreground/85",
  secondary: "border border-border text-foreground hover:bg-surface-hover",
  ghost: "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
  destructive: "bg-danger text-white hover:bg-danger-hover",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", type = "button", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
});
