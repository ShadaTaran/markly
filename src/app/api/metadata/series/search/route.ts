import { NextResponse, type NextRequest } from "next/server";
import { isTmdbConfigured, searchTmdbSeries } from "@/lib/metadata/server/tmdb";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return NextResponse.json({ results: [] });

  if (!isTmdbConfigured()) {
    return NextResponse.json({ error: "Series search is not configured." }, { status: 503 });
  }

  try {
    const results = await searchTmdbSeries(query);
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: "Series search is temporarily unavailable." }, { status: 502 });
  }
}
