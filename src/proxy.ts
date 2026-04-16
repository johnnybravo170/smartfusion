/**
 * Route-protection proxy (Next.js 16 `proxy.ts`, formerly `middleware.ts`).
 *
 * Duties per PHASE_1_PLAN §13.9 and §8 Task 1.6:
 *   1. Keep the Supabase auth cookies fresh by running `getUser()` on
 *      every matched request (this triggers `setAll` if the token needs
 *      a refresh).
 *   2. Redirect unauthenticated visits to `/dashboard/*` → `/login`.
 *   3. Redirect authenticated visits to `/login`, `/signup`, `/magic-link`
 *      → `/dashboard`.
 *   4. Tenant-orphan check: authenticated user with no `tenant_members`
 *      row is signed out and bounced to `/signup?error=no_tenant`.
 *
 * Important: we also cover Server Function POSTs. Per the Next.js 16 proxy
 * docs, `use server` actions are dispatched to the route where the form
 * was mounted, so any matcher that covers our routes will also cover
 * their Server Actions.
 */

import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

const PROTECTED_PREFIXES = ['/dashboard'];
const AUTH_ROUTES = new Set(['/login', '/signup', '/magic-link']);

export async function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const pathname = url.pathname;

  // Always let the callback route through without any Supabase calls; it
  // has its own session-exchange logic.
  if (pathname.startsWith('/callback') || pathname.startsWith('/check-email')) {
    return NextResponse.next();
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  const isAuthRoute = AUTH_ROUTES.has(pathname);

  // Short-circuit routes that don't need auth context.
  if (!isProtected && !isAuthRoute) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    // Fail open in local dev without env — the page will crash with a
    // clearer error on render. Middleware isn't the right layer for
    // env validation.
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Authenticated user hitting /login, /signup, or /magic-link → push
  // them to /dashboard (they're already in).
  if (user && isAuthRoute) {
    const dest = url.clone();
    dest.pathname = '/dashboard';
    dest.search = '';
    return NextResponse.redirect(dest);
  }

  // Unauthenticated visit to a protected route → /login.
  if (!user && isProtected) {
    const dest = url.clone();
    dest.pathname = '/login';
    dest.search = '';
    return NextResponse.redirect(dest);
  }

  // Authenticated visit to a protected route → verify they have a tenant.
  if (user && isProtected) {
    const { data: member } = await supabase
      .from('tenant_members')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!member) {
      await supabase.auth.signOut();
      const dest = url.clone();
      dest.pathname = '/signup';
      dest.search = '?error=no_tenant';
      return NextResponse.redirect(dest);
    }
  }

  return response;
}

export const config = {
  // Match everything except Next internals, static assets, and favicons.
  // Server Actions share the route they were mounted on, so this matcher
  // also covers our `'use server'` actions.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
