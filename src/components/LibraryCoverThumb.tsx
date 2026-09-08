"use client";

import { useState } from "react";
import type { LibraryItemType } from "@/types/library-item";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { cn } from "@/lib/utils";

interface LibraryCoverThumbProps {
  imageUrl?: string;
  type: LibraryItemType;
  /** Controls size/aspect/rounding per view mode — the one thing that varies between Grid/Compact/List. */
  className: string;
  iconSize?: number;
}

/**
 * The one cover-or-fallback renderer shared by Library's Grid, Compact, and
 * List presentations (round 6) — previously each view would have hand-
 * rolled its own copy of "show the image, or fall back to a muted
 * ItemTypeIcon tile" the way MediaItemCard/ItemCover/ContinueCard/
 * CalendarView's EventRow each independently do today. New Library
 * surfaces consolidate on this one instead of adding a fourth or fifth copy.
 */
export function LibraryCoverThumb({ imageUrl, type, className, iconSize = 18 }: LibraryCoverThumbProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !imageFailed;

  return (
    <div className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted", className)}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- user-provided cover art from arbitrary hosts; next/image's optimizer isn't a good fit for this.
        <img src={imageUrl} alt="" className="h-full w-full object-cover" onError={() => setImageFailed(true)} />
      ) : (
        <ItemTypeIcon type={type} width={iconSize} height={iconSize} className="text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}
