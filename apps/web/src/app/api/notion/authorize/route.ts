import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "Notion not configured" }, { status: 500 });
  }

  const state = randomBytes(16).toString("hex");
  const callbackUrl = new URL("/api/notion/callback", request.url).toString();

  console.log("[notion/authorize] clientId:", clientId);
  console.log("[notion/authorize] callbackUrl (redirect_uri):", callbackUrl);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    owner: "user",
    state,
  });

  console.log("[notion/authorize] redirecting to Notion OAuth:", `https://api.notion.com/v1/oauth/authorize?${params.toString()}`);

  const response = NextResponse.redirect(
    `https://api.notion.com/v1/oauth/authorize?${params.toString()}`
  );

  response.cookies.set("notion_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}
