import { LibraryDashboard } from "@/components/LibraryDashboard";
import { starterLibraryItems } from "@/data/library-items";

export default function Home() {
  return <LibraryDashboard items={starterLibraryItems} />;
}
