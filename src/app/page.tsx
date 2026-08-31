import { DashboardView } from "@/components/DashboardView";
import { starterLibraryItems } from "@/data/library-items";

export default function Home() {
  return <DashboardView items={starterLibraryItems} />;
}
