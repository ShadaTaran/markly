import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * UI/UX quality pass — before this, page shells each hand-wrote their own
 * `mx-auto max-w-{6xl,4xl,3xl,2xl} px-4 py-6 sm:px-6 lg:px-8` string, so the
 * four widths in use across the app were an accident of copy-paste rather
 * than a deliberate choice. Naming them by INTENT instead of by raw
 * Tailwind scale value means a page's width is now a legible decision:
 *
 *   - "wide": grid/browse pages showing multi-column cards (Dashboard, Library).
 *   - "detail": a two-column cover+info layout (Item Detail).
 *   - "narrow": a single-column list/agenda (Calendar, Reminders).
 *   - "settings": a simple, form-shaped page (Settings).
 *
 * No numeric value changed by introducing this — every page keeps the
 * exact width it already had. Calendar/Reminders deliberately stay
 * narrower than Dashboard/Library's shared Header bar above them: a
 * narrower reading column for list-shaped content is a common, legible
 * pattern (not a bug), so it's kept rather than force-widened to match.
 */
const PAGE_WIDTH_CLASSES = {
  wide: "max-w-6xl",
  detail: "max-w-4xl",
  narrow: "max-w-3xl",
  settings: "max-w-2xl",
} as const;

export type PageWidth = keyof typeof PAGE_WIDTH_CLASSES;

interface PageContainerProps {
  width?: PageWidth;
  /** A dedicated prop rather than folding this into `className` — two conflicting `py-*` utilities in one class list have no reliable winner under Tailwind's own ordering, so vertical padding gets exactly one place to be set. Defaults to every page's existing value except Settings (py-8). */
  paddingY?: string;
  className?: string;
  children: ReactNode;
}

export function PageContainer({ width = "wide", paddingY = "py-6", className, children }: PageContainerProps) {
  return <main className={cn("mx-auto px-4 sm:px-6 lg:px-8", PAGE_WIDTH_CLASSES[width], paddingY, className)}>{children}</main>;
}
