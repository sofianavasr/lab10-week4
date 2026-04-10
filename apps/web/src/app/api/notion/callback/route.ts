import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, upsertIntegration } from "@agents/db";
import { encrypt } from "@/lib/crypto";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  console.log("[notion/callback] received - code:", !!code, "state:", !!state, "error:", errorParam);

  if (errorParam) {
    console.log("[notion/callback] Notion returned error:", errorParam);
    return NextResponse.redirect(`${origin}/settings?notion=error`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    console.log("[notion/callback] no authenticated user, redirecting to login");
    return NextResponse.redirect(`${origin}/login`);
  }

  const cookies = request.headers.get("cookie") ?? "";
  const stateMatch = cookies.match(/notion_oauth_state=([^;]+)/);
  const savedState = stateMatch?.[1];

  console.log("[notion/callback] state check - received:", state, "saved:", savedState, "match:", state === savedState);

  if (!code || !state || state !== savedState) {
    console.log("[notion/callback] state mismatch or missing code - code:", !!code, "state:", state, "savedState:", savedState);
    return NextResponse.redirect(`${origin}/settings?notion=error`);
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.log("[notion/callback] missing env vars - clientId:", !!clientId, "clientSecret:", !!clientSecret);
    return NextResponse.redirect(`${origin}/settings?notion=error`);
  }

  const callbackUrl = new URL("/api/notion/callback", request.url).toString();
  console.log("[notion/callback] exchanging code for token, redirect_uri:", callbackUrl);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
    }),
  });

  console.log("[notion/callback] token exchange status:", tokenRes.status);

  const tokenData = await tokenRes.json().catch(() => null) as
    | { access_token?: string; refresh_token?: string; error?: string; message?: string }
    | null;

  console.log("[notion/callback] token response - has access_token:", !!tokenData?.access_token, "error:", (tokenData as Record<string, unknown> | null)?.error, "message:", (tokenData as Record<string, unknown> | null)?.message);

  if (!tokenData?.access_token) {
    console.log("[notion/callback] no access_token, full response:", JSON.stringify(tokenData));
    return NextResponse.redirect(`${origin}/settings?notion=error`);
  }

  const encryptedTokens = encrypt(
    JSON.stringify({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
    })
  );
  const db = createServerClient();
  await upsertIntegration(
    db,
    user.id,
    "notion",
    ["read_content", "insert_content"],
    encryptedTokens
  );

  console.log("[notion/callback] integration saved successfully for user:", user.id);

  const response = NextResponse.redirect(`${origin}/settings?notion=connected`);
  response.cookies.set("notion_oauth_state", "", { maxAge: 0, path: "/" });
  return response;
}
