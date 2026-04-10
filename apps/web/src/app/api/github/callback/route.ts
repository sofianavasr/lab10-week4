import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { upsertIntegration } from "@agents/db";
import { encrypt } from "@/lib/crypto";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  if (errorParam) {
    return NextResponse.redirect(`${origin}/settings?github=error`);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const cookies = request.headers.get("cookie") ?? "";
  const stateMatch = cookies.match(/github_oauth_state=([^;]+)/);
  const savedState = stateMatch?.[1];

  if (!code || !state || state !== savedState) {
    return NextResponse.redirect(`${origin}/settings?github=error`);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return NextResponse.redirect(`${origin}/settings?github=error`);
  }

  const encryptedToken = encrypt(tokenData.access_token);
  const db = createServerClient();
  await upsertIntegration(db, user.id, "github", ["repo"], encryptedToken);

  const response = NextResponse.redirect(`${origin}/settings?github=connected`);
  response.cookies.set("github_oauth_state", "", { maxAge: 0, path: "/" });
  return response;
}
