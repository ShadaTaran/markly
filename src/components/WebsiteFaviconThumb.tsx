"use client";

import { useState } from "react";
import { getFaviconUrl } from "@/lib/website";
import { GlobeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

interface WebsiteFaviconThumbProps {
  domain: string;
  className: string;
  iconSize?: number;
}

/** The one favicon-or-globe renderer shared by Library's Grid, Compact, and List presentations. */
export function WebsiteFaviconThumb({ domain, className, iconSize = 16 }: WebsiteFaviconThumbProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted", className)}>
      {failed ? (
        <GlobeIcon width={iconSize} height={iconSize} className="text-muted-foreground" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- favicons are third-party, per-domain images; next/image's optimizer isn't a good fit here.
        <img src={getFaviconUrl(domain)} alt="" width={iconSize} height={iconSize} onError={() => setFailed(true)} />
      )}
    </div>
  );
}
