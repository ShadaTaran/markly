import { ReminderCenterView } from "@/components/ReminderCenterView";
import { starterLibraryItems } from "@/data/library-items";

export default function RemindersPage() {
  return <ReminderCenterView items={starterLibraryItems} />;
}
