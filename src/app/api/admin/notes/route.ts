import { NextResponse } from "next/server";

import { queueNoteWrite } from "@/lib/questathon";

export async function POST(request: Request) {
  const adminHeader = request.headers.get("x-admin-key");
  const expectedKey = process.env.ADMIN_ACCESS_KEY;

  if (!expectedKey || adminHeader !== expectedKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { account?: string; kind?: string; title?: string; text?: string };

    if (!body.account || !body.kind || !body.title || !body.text) {
      return NextResponse.json({ error: "account, kind, title and text are required" }, { status: 400 });
    }

    const result = await queueNoteWrite({
      account: body.account,
      kind: body.kind,
      title: body.title,
      text: body.text,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
