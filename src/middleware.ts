import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/middleware";

export async function middleware(request: NextRequest) {
  // old cookie-based auth fallback
  const session = request.cookies.get("session")?.value;
  if (session === "authenticated") return NextResponse.next();

  try {
    const { supabase, supabaseResponse } = createClient(request);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return supabaseResponse;
  } catch { /* fall through to redirect */ }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|_next|api/auth|api/mapbox|_next/static|favicon.ico).*)"],
};
