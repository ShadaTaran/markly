interface ProgressBarProps {
  percent: number;
  className?: string;
}

/** Thin, non-animated progress indicator shared by cards and the detail view. */
export function ProgressBar({ percent, className }: ProgressBarProps) {
  return (
    <div
      role="img"
      aria-label={`${Math.round(percent)}% complete`}
      className={`h-1 w-full overflow-hidden rounded-full bg-border ${className ?? ""}`}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}
