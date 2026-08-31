import { NextResponse, type NextRequest } from "next/server";
import { getRawgGameDetails, isRawgConfigured } from "@/lib/metadata/server/rawg";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  if (!isRawgConfigured()) {
    return NextResponse.json({ error: "Game details are not configured." }, { status: 503 });
  }

  try {
    const details = await getRawgGameDetails(id);
    return NextResponse.json(details);
  } catch {
    return NextResponse.json({ error: "Game details are temporarily unavailable." }, { status: 502 });
  }
}
