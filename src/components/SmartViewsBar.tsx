"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { MoreHorizontalIcon, PencilIcon, TrashIcon } from "@/components/icons";

export interface SmartViewBarEntry {
  id: string;
  name: string;
  count: number;
}

interface SmartViewsBarProps {
  builtInViews: SmartViewBarEntry[];
  customViews: SmartViewBarEntry[];
  allLibraryCount: number;
  activeViewId: string | null;
  onSelect: (id: string | null) => void;
  onRenameRequest: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}

const COLLAPSE_THRESHOLD = 5;

/** Stage 31 §40 — Smart Views + My Views, collapsed once "My Views" gets long rather than growing into an unbounded list. Counts are computed by the caller from the same engine every render (§42) — never stored. */
export function SmartViewsBar({ builtInViews, customViews, allLibraryCount, activeViewId, onSelect, onRenameRequest, onDeleteRequest }: SmartViewsBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const visibleCustomViews = expanded ? customViews : customViews.slice(0, COLLAPSE_THRESHOLD);

  return (
    <nav aria-label="Smart Views" className="space-y-3">
      <ViewButtonRow
        entries={[{ id: "__all__", name: "All Library", count: allLibraryCount }, ...builtInViews]}
        activeViewId={activeViewId ?? "__all__"}
        onSelect={(id) => onSelect(id === "__all__" ? null : id)}
      />

      {customViews.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">My Views</p>
          <ul className="flex flex-wrap items-center gap-1.5">
            {visibleCustomViews.map((view) => (
              <li key={view.id} className="relative">
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium transition-colors",
                    activeViewId === view.id ? "border-accent bg-accent/5 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <button type="button" onClick={() => onSelect(view.id)} className="flex items-center gap-1.5">
                    {view.name}
                    <span className="text-xs text-muted-foreground/80">{view.count}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenuOpenId((current) => (current === view.id ? null : view.id))}
                    aria-label={`Options for ${view.name}`}
                    aria-expanded={menuOpenId === view.id}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <MoreHorizontalIcon width={14} height={14} />
                  </button>
                </div>
                {menuOpenId === view.id && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-36 rounded-md border border-border bg-surface py-1 shadow-md">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpenId(null);
                        onRenameRequest(view.id);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover"
                    >
                      <PencilIcon width={14} height={14} />
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpenId(null);
                        onDeleteRequest(view.id);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-surface-hover"
                    >
                      <TrashIcon width={14} height={14} />
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
            {customViews.length > COLLAPSE_THRESHOLD && (
              <li>
                <button type="button" onClick={() => setExpanded((current) => !current)} className="text-xs font-medium text-accent hover:underline">
                  {expanded ? "Show less" : `Show ${customViews.length - COLLAPSE_THRESHOLD} more`}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </nav>
  );
}

function ViewButtonRow({ entries, activeViewId, onSelect }: { entries: SmartViewBarEntry[]; activeViewId: string; onSelect: (id: string) => void }) {
  return (
    <ul className="no-scrollbar flex items-center gap-1.5 overflow-x-auto">
      {entries.map((entry) => {
        const isActive = entry.id === activeViewId;
        return (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onSelect(entry.id)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-sm font-medium transition-colors",
                isActive ? "border-accent bg-accent/5 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.name}
              <span className="text-xs text-muted-foreground/80">{entry.count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
