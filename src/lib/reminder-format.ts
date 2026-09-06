/**
 * Stage 34 — display-string formatting for reminder timestamps, kept
 * separate from lib/reminders.ts's pure resolution engine, matching the
 * existing activity-format.ts/smart-views.ts split (resolution logic vs.
 * how a resolved value reads on screen).
 */

/**
 * Unlike activity-format.ts's formatRelativeTime (past-only: "3h ago"),
 * reminders routinely describe a FUTURE instant too ("due in 3h" for
 * Upcoming) — this handles both directions with the same granularity.
 */
export function formatDueRelative(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const diffMs = date.getTime() - now.getTime();
  const past = diffMs <= 0;
  const absMinutes = Math.floor(Math.abs(diffMs) / 60_000);

  if (absMinutes < 1) return "Just now";
  if (absMinutes < 60) return past ? `${absMinutes}m ago` : `in ${absMinutes}m`;

  const absHours = Math.floor(absMinutes / 60);
  if (absHours < 24) return past ? `${absHours}h ago` : `in ${absHours}h`;

  const absDays = Math.floor(absHours / 24);
  if (absDays === 1) return past ? "Yesterday" : "Tomorrow";
  return past ? `${absDays}d ago` : `in ${absDays}d`;
}
