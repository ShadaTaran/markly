import { cn } from "@/lib/utils";

interface LogoProps {
  size?: number;
  className?: string;
}

/** The Markly mark — a simple bookmark ribbon, the one deliberate use of the accent color as brand identity rather than UI state. */
export function Logo({ size = 28, className }: LogoProps) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-md bg-accent text-background", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 2a2 2 0 0 0-2 2v17a1 1 0 0 0 1.55.83L12 17.9l5.45 3.93A1 1 0 0 0 19 21V4a2 2 0 0 0-2-2H7z" />
      </svg>
    </span>
  );
}
