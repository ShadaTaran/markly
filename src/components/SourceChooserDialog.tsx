"use client";

import type { ResumeSourceOption } from "@/lib/resume";
import { Dialog } from "@/components/Dialog";
import { ExternalLinkIcon } from "@/components/icons";

interface SourceChooserDialogProps {
  isOpen: boolean;
  onClose: () => void;
  itemTitle: string;
  sources: readonly ResumeSourceOption[];
}

/**
 * Stage 41 — shown only when lib/resume.ts's resolveResumeTarget returns
 * `choose_source`: several linked sources exist and their recency isn't
 * safely comparable enough to silently pick one (see that file's own doc
 * comment on why a manual source's last_seen_at can't be trusted the same
 * way an extension-detected one can). This is an OPENING affordance only
 * — it has no unlink/enable/disable controls, no Add Source entry point,
 * and is not a substitute for Source Hub (ItemTrackingSourcesSection),
 * which remains the one place sources are managed. Selecting a row just
 * opens it externally (plain safe `<a>`, same target="_blank" rel policy
 * every other source-open action in Markly already uses) and closes the
 * dialog — it never mutates auto_track_enabled, never relinks, never
 * writes a "preferred source" anywhere (Stage 41 §6/§8: no such column
 * exists, and this stage doesn't add one).
 */
export function SourceChooserDialog({ isOpen, onClose, itemTitle, sources }: SourceChooserDialogProps) {
  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={`Continue ${itemTitle}`} widthClassName="max-w-sm">
      <p className="mb-3 text-sm text-muted-foreground">More than one source is linked. Choose one to open.</p>
      <ul className="space-y-1.5">
        {sources.map((source) => (
          <li key={source.sourceId}>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-3 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{source.label}</span>
                {source.hostname && <span className="block truncate text-xs text-muted-foreground">{source.hostname}</span>}
                <span className="block truncate text-xs text-muted-foreground">{source.progressText}</span>
              </span>
              <ExternalLinkIcon width={13} height={13} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
