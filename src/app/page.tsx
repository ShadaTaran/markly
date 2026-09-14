import { createClient } from "@/lib/supabase/server";
import { DashboardView } from "@/components/DashboardView";
import { SignedOutHomeGate } from "@/components/SignedOutHomeGate";
import { starterLibraryItems } from "@/data/library-items";

/**
 * Stage 45 §2 — signed-in `/` is unchanged (the existing Dashboard, SSR'd
 * exactly as before). Signed-out `/` now defers to SignedOutHomeGate, which
 * decides landing-page vs. Dashboard client-side (see its own doc comment
 * for why that decision can't be made here on the server).
 */
export default async function Home() {
  let signedIn = false;
  try {
    const supabase = await createClient();
    if (supabase) {
      const { data } = await supabase.auth.getUser();
      signedIn = Boolean(data.user);
    }
  } catch {
    // Supabase not configured, or the session check failed — treat as
    // signed out; SignedOutHomeGate's own local-mode check still applies.
  }

  if (signedIn) return <DashboardView items={starterLibraryItems} />;
  return <SignedOutHomeGate />;
}
