import { CalendarView } from "@/components/CalendarView";
import { starterLibraryItems } from "@/data/library-items";

export default function CalendarPage() {
  return <CalendarView items={starterLibraryItems} />;
}
