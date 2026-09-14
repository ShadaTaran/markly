"use client";

import { useEffect, useState } from "react";
import { DashboardView } from "@/components/DashboardView";
import { LandingPage } from "@/components/LandingPage";
import { starterLibraryItems } from "@/data/library-items";
import { readOnboardingStorage } from "@/lib/onboarding";

/**
 * Stage 45 §2 — Phase 0 found that a signed-out `/` always rendered the
 * full Dashboard seeded with generic demo bookmarks, which is genuinely
 * confusing for a brand-new stranger (the demo data reads like real
 * content, not a placeholder) but is exactly the right page for a
 * *returning* local-mode user, whose Dashboard already shows their own
 * real local library, not the demo data (see useLibraryItems — the seed
 * is only ever used to initialize an empty localStorage). Swapping every
 * signed-out visit for a landing page would have silently taken that view
 * away from existing local-mode users. `hasEverHadLibraryItems` (the same
 * flag DashboardView/LibraryView already use for onboarding) is exactly
 * the signal that distinguishes the two cases, so this reuses it rather
 * than inventing a second one. Only reachable when the server-rendered
 * root page has already confirmed the visitor is signed out — a signed-in
 * user's Dashboard is decided server-side and never passes through here.
 */
export function SignedOutHomeGate() {
  const [hasLocalHistory, setHasLocalHistory] = useState<boolean | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync: localStorage can't be read during SSR/first render, so this resolves the initial "which view" decision exactly once on mount (same pattern as AuthProvider's own initial-session check).
    setHasLocalHistory(readOnboardingStorage().hasEverHadLibraryItems);
  }, []);

  if (hasLocalHistory === null) return null;
  return hasLocalHistory ? <DashboardView items={starterLibraryItems} /> : <LandingPage />;
}
