"use client";

import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useReminders } from "@/hooks/useReminders";
import { useNow } from "@/hooks/useNow";
import { resolveReminders, countDueReminders } from "@/lib/reminders";
import { BellIcon } from "@/components/icons";

/**
 * Stage 34 — Header's due-reminder badge, shown on every page. Deliberately
 * resolves from each reminder's own STORED snapshot only
 * (`providerAvailable: false`, no fresh ReleaseEvents) — this renders on
 * every navigation, and triggering a fresh AniList fetch here would be
 * exactly the "polling on a timer" the spec forbids. Only the /reminders
 * page itself performs the one batched, Stage-33-reuse fetch to reconcile
 * fresh schedule data; both call the SAME resolveReminders/
 * countDueReminders (lib/reminders.ts) — they just differ in whether fresh
 * provider data is supplied, so this badge can occasionally lag a release
 * reminder whose schedule just moved earlier by the margin of that
 * unconfirmed change. It never fabricates a count and never disagrees with
 * /reminders about anything a stored snapshot alone can already tell it
 * (due boundary, dismissal, orphan skipping).
 *
 * Uses its own useLibraryItems/useReminders instances rather than
 * threading state down from every page — the same self-contained pattern
 * RecentRecoveryPanel already uses for its own three stores.
 */
export function ReminderBell() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const library = useLibraryItems([], undefined, userId);
  const remindersStore = useReminders(userId);
  const now = useNow();

  const ready = library.isHydrated && remindersStore.isHydrated;
  const dueCount = ready ? countDueReminders(resolveReminders(remindersStore.reminders, library.items, [], false, now)) : 0;

  return (
    <Link
      href="/reminders"
      aria-label={dueCount > 0 ? `Reminders, ${dueCount} due` : "Reminders"}
      className="relative rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <BellIcon width={18} height={18} />
      {dueCount > 0 && (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white"
        >
          {dueCount > 9 ? "9+" : dueCount}
        </span>
      )}
    </Link>
  );
}
