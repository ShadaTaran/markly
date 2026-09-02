"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";

export function AccountMenu() {
  const { user, loading, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  if (loading) {
    return <div aria-hidden="true" className="h-8 w-16 shrink-0 animate-pulse rounded-md bg-surface-hover" />;
  }

  if (!user) {
    return (
      <Link
        href="/login"
        className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Sign In
      </Link>
    );
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">
          {user.email?.[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="hidden max-w-[9rem] truncate sm:inline">{user.email}</span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close account menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1.5 w-52 rounded-md border border-border bg-surface p-1 shadow-sm">
            <p className="truncate px-2.5 py-1.5 text-xs text-muted-foreground">{user.email}</p>
            <Link
              href="/settings/connections"
              onClick={() => setOpen(false)}
              className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
            >
              Connections
            </Link>
            <Link
              href="/settings/tracking"
              onClick={() => setOpen(false)}
              className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
            >
              Auto Tracking
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
              className="w-full rounded px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
            >
              Sign Out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
