// Root Next.js middleware.
//
// On Next.js 15 (this project), this file must be named `middleware.ts` and
// export `middleware`. It delegates to our session-refresh helper so the
// signed-in user's Supabase auth session is kept fresh on every matched request,
// which is what owner-only RLS relies on. (Next.js 16+ renames this to proxy.ts;
// we are on 15, so middleware.ts is correct.)

import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - image files
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
