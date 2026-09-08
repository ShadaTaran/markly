import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label": string;
}

/** The one accessible on/off control — extracted from Auto Tracking's device row, which had this exact shape hand-rolled once already. */
export function Switch({ checked, onChange, disabled, "aria-label": ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        "relative flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:opacity-60",
        checked ? "bg-accent" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 h-5 w-5 rounded-full bg-background transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}
