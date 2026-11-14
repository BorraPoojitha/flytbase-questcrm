import { NextResponse } from "next/server";

import { getDashboardSnapshot } from "@/lib/questathon";

export async function GET() {
  const payload = await getDashboardSnapshot();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
