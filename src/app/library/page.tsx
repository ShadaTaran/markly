import { LibraryView } from "@/components/LibraryView";
import { starterLibraryItems } from "@/data/library-items";

export default function LibraryPage() {
  return <LibraryView items={starterLibraryItems} />;
}
