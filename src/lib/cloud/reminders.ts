import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderInsert, ReminderRow } from "@/lib/supabase/database.types";
import type { Reminder } from "@/types/reminder";

/**
 * Thrown when an insert/update violates one of 0016's two partial unique
 * indexes (Postgres error code 23505) — i.e. an active reminder with the
 * same logical identity already exists. Callers (useReminders) catch this
 * specifically to resolve a duplicate-create race to one logical reminder,
 * or to surface "a reminder already exists for that time" on an edit,
 * rather than a generic save failure.
 */
export class ReminderConflictError extends Error {
  constructor() {
    super("An active reminder with this identity already exists.");
    this.name = "ReminderConflictError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

function toReminderRow(reminder: Reminder, userId: string): ReminderInsert {
  const base = {
    id: reminder.id,
    user_id: userId,
    library_item_id: reminder.libraryItemId,
    kind: reminder.kind,
    dismissed_at: reminder.dismissedAt ?? null,
    created_at: reminder.createdAt,
    updated_at: reminder.updatedAt ?? null,
  };
  if (reminder.kind === "release") {
    return {
      ...base,
      provider: reminder.provider,
      external_media_id: reminder.externalMediaId,
      episode: reminder.episode,
      scheduled_for: reminder.scheduledFor,
      remind_before_minutes: reminder.remindBeforeMinutes,
      remind_at: null,
    };
  }
  return {
    ...base,
    provider: null,
    external_media_id: null,
    episode: null,
    scheduled_for: null,
    remind_before_minutes: null,
    remind_at: reminder.remindAt,
  };
}

function fromReminderRow(row: ReminderRow): Reminder | null {
  const base = {
    id: row.id,
    libraryItemId: row.library_item_id,
    dismissedAt: row.dismissed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
  if (row.kind === "release") {
    if (row.provider !== "anilist" || !row.external_media_id || row.episode === null || !row.scheduled_for || row.remind_before_minutes === null) {
      return null;
    }
    return {
      ...base,
      kind: "release",
      provider: "anilist",
      externalMediaId: row.external_media_id,
      episode: row.episode,
      scheduledFor: row.scheduled_for,
      remindBeforeMinutes: row.remind_before_minutes,
    };
  }
  if (row.kind === "continue") {
    if (!row.remind_at) return null;
    return { ...base, kind: "continue", remindAt: row.remind_at };
  }
  return null;
}

export async function fetchReminders(supabase: SupabaseClient, userId: string): Promise<Reminder[]> {
  const { data, error } = await supabase.from("reminders").select("*").eq("user_id", userId).returns<ReminderRow[]>();
  if (error) throw error;

  const reminders: Reminder[] = [];
  (data ?? []).forEach((row) => {
    const reminder = fromReminderRow(row);
    if (reminder) reminders.push(reminder);
  });
  return reminders;
}

export async function insertReminder(supabase: SupabaseClient, reminder: Reminder, userId: string): Promise<Reminder> {
  const { data, error } = await supabase.from("reminders").insert(toReminderRow(reminder, userId)).select().returns<ReminderRow[]>();
  if (error) {
    if (isUniqueViolation(error)) throw new ReminderConflictError();
    throw error;
  }
  const inserted = data?.[0] ? fromReminderRow(data[0]) : null;
  if (!inserted) throw new Error("Reminder was saved but couldn't be read back.");
  return inserted;
}

export async function updateReminderRow(supabase: SupabaseClient, reminder: Reminder, userId: string): Promise<void> {
  const { error } = await supabase.from("reminders").update(toReminderRow(reminder, userId)).eq("id", reminder.id);
  if (error) {
    if (isUniqueViolation(error)) throw new ReminderConflictError();
    throw error;
  }
}

export async function deleteReminderRow(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("reminders").delete().eq("id", id);
  if (error) throw error;
}
