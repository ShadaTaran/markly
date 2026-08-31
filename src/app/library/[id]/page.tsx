"use client";

import { useParams } from "next/navigation";
import { ItemDetailView } from "@/components/ItemDetailView";

export default function ItemDetailPage() {
  const params = useParams<{ id: string }>();
  return <ItemDetailView itemId={params.id} />;
}
