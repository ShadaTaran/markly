import type { ReactNode } from "react";
import { Button } from "@/components/Button";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2.5 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-xs text-sm text-muted-foreground">{description}</p>
      )}
      {action && (
        <Button variant="secondary" onClick={action.onClick} className="mt-1.5">
          {action.label}
        </Button>
      )}
    </div>
  );
}
