import { NextResponse, type NextRequest } from "next/server";
import { getTmdbSeriesEpisodeCount, isTmdbConfigured } from "@/lib/metadata/server/tmdb";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  if (!isTmdbConfigured()) {
    return NextResponse.json({ error: "Series details are not configured." }, { status: 503 });
  }

  try {
    const totalEpisodes = await getTmdbSeriesEpisodeCount(id);
    return NextResponse.json({ totalEpisodes });
  } catch {
    return NextResponse.json({ error: "Series details are temporarily unavailable." }, { status: 502 });
  }
}
