import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityEventInsert, ActivityEventRow } from "@/lib/supabase/database.types";
import type { ActivityEvent, ProgressKind } from "@/types/activity";
import { MAX_ACTIVITY_EVENTS, PROGRESS_KINDS } from "@/lib/activity-storage";
import { normalizeStatus } from "@/lib/tracking";

type EventData = Record<string, unknown>;

function readNumber(data: EventData, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(data: EventData, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function readProgressKind(data: EventData): ProgressKind | undefined {
  const value = data.progressKind;
  return typeof value === "string" && (PROGRESS_KINDS as readonly string[]).includes(value)
    ? (value as ProgressKind)
    : undefined;
}

export function toActivityEventRow(event: ActivityEvent, userId: string): ActivityEventInsert {
  let data: EventData;

  switch (event.type) {
    case "progress_updated":
      data = { progressKind: event.progressKind, previousValue: event.previousValue, newValue: event.newValue };
      break;
    case "rating_updated":
      data = { previousValue: event.previousValue, newValue: event.newValue };
      break;
    case "status_updated":
      data = { previousValue: event.previousValue, newValue: event.newValue };
      break;
    case "item_added":
      data = {};
      break;
  }

  return {
    id: event.id,
    user_id: userId,
    item_id: event.itemId,
    type: event.type,
    data,
    created_at: event.timestamp,
  };
}

function fromActivityEventRow(row: ActivityEventRow): ActivityEvent | null {
  const data: EventData = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
  const base = { id: row.id, itemId: row.item_id, timestamp: row.created_at };

  switch (row.type) {
    case "progress_updated": {
      const progressKind = readProgressKind(data);
      const newValue = readNumber(data, "newValue");
      if (!progressKind || newValue === undefined) return null;
      return { ...base, type: "progress_updated", progressKind, previousValue: readNumber(data, "previousValue"), newValue };
    }
    case "rating_updated":
      return { ...base, type: "rating_updated", previousValue: readNumber(data, "previousValue"), newValue: readNumber(data, "newValue") };
    case "status_updated": {
      const newValueRaw = readString(data, "newValue");
      if (newValueRaw === undefined) return null;
      const previousValueRaw = readString(data, "previousValue");
      return {
        ...base,
        type: "status_updated",
        previousValue: previousValueRaw !== undefined ? normalizeStatus(previousValueRaw) : undefined,
        newValue: normalizeStatus(newValueRaw),
      };
    }
    case "item_added":
      return { ...base, type: "item_added" };
    default:
      return null;
  }
}

export async function fetchActivityEvents(supabase: SupabaseClient, userId: string): Promise<ActivityEvent[]> {
  const { data, error } = await supabase
    .from("activity_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_ACTIVITY_EVENTS)
    .returns<ActivityEventRow[]>();

  if (error) throw error;

  const events: ActivityEvent[] = [];
  (data ?? []).forEach((row) => {
    const event = fromActivityEventRow(row);
    if (event) events.push(event);
  });
  return events;
}

export async function insertActivityEvent(supabase: SupabaseClient, event: ActivityEvent, userId: string): Promise<void> {
  const { error } = await supabase.from("activity_events").upsert(toActivityEventRow(event, userId));
  if (error) throw error;
}

export async function deleteActivityEventsForItem(supabase: SupabaseClient, itemId: string): Promise<void> {
  const { error } = await supabase.from("activity_events").delete().eq("item_id", itemId);
  if (error) throw error;
}
