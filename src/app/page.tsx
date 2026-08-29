import { BookmarkDashboard } from "@/components/BookmarkDashboard";
import { mockBookmarks } from "@/data/bookmarks";

export default function Home() {
  return <BookmarkDashboard bookmarks={mockBookmarks} />;
}
