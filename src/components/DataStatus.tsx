interface DataErrorBannerProps {
  message: string;
  onRetry: () => void;
}

export function DataErrorBanner({ message, onRetry }: DataErrorBannerProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-foreground">
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md px-2.5 py-1 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
      >
        Retry
      </button>
    </div>
  );
}

export function DataLoadingPlaceholder({ label }: { label: string }) {
  return <p className="py-16 text-center text-sm text-muted-foreground">{label}</p>;
}
