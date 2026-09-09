import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountMenu } from "@/components/AccountMenu";
import { CommandPaletteTriggerButton } from "@/components/CommandPaletteTriggerButton";
import { ArrowLeftIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

interface SecondaryPageHeaderProps {
  /** Each secondary page keeps its own existing content width (e.g. Settings' max-w-2xl vs. Item Detail's max-w-4xl) — only the header chrome itself is shared. */
  maxWidthClassName: string;
}

/**
 * The shared header for every secondary page (Settings, Item Detail) that
 * deliberately does NOT carry the primary Dashboard/Library/Calendar nav:
 * product identity (logo + wordmark) and account chrome (theme + account)
 * stay visible on the right, with a single "Back to Library" link standing
 * in for the primary nav on the left. One definition so these pages can't
 * visually drift apart the way Item Detail previously had (it dropped the
 * logo and account menu entirely).
 *
 * Below `sm` there isn't room for "Markly" + "Back to Library" + theme +
 * account on one row without wrapping, so the wordmark and the back link's
 * label both shrink to their icon/short form there — presentation only,
 * same two links, same /library destination, same accessible name ("Back
 * to Library" stays the back link's aria-label even though its visible
 * mobile text reads "Library").
 */
export function SecondaryPageHeader({ maxWidthClassName }: SecondaryPageHeaderProps) {
  return (
    <header className="border-b border-border">
      <div className={cn("mx-auto flex items-center gap-4 px-4 py-4 sm:px-6 lg:px-8", maxWidthClassName)}>
        <Link
          href="/library"
          className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Logo size={24} />
          <span className="hidden text-base font-semibold tracking-tight sm:inline">Markly</span>
        </Link>
        <Link
          href="/library"
          aria-label="Back to Library"
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ArrowLeftIcon width={16} height={16} className="shrink-0" />
          <span className="sm:hidden" aria-hidden="true">Library</span>
          <span className="hidden sm:inline" aria-hidden="true">Back to Library</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <CommandPaletteTriggerButton />
          <ThemeToggle />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
