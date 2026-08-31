import { NextResponse, type NextRequest } from "next/server";
import { isRawgConfigured, searchRawgGames } from "@/lib/metadata/server/rawg";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return NextResponse.json({ results: [] });

  if (!isRawgConfigured()) {
    return NextResponse.json({ error: "Game search is not configured." }, { status: 503 });
  }

  try {
    const results = await searchRawgGames(query);
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: "Game search is temporarily unavailable." }, { status: 502 });
  }
}
