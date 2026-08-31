"use client";

import { useState } from "react";
import type { MediaItem } from "@/types/library-item";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";

interface ItemCoverProps {
  item: MediaItem;
}

export function ItemCover({ item }: ItemCoverProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(item.imageUrl) && !imageFailed;

  return (
    <div className="aspect-[2/3] w-full max-w-[200px] overflow-hidden rounded-lg border border-border bg-surface sm:max-w-[220px]">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- saved cover art from arbitrary hosts; next/image's optimizer isn't a good fit here.
        <img
          src={item.imageUrl}
          alt={`${item.title} cover`}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <ItemTypeIcon type={item.type} width={44} height={44} className="text-muted-foreground" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
