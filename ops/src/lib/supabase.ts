import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { env } from './env';

/**
 * User-bound Supabase client for admin-UI server components and actions.
 * Scoped by the Supabase auth cookie — used to verify WHO is signed in.
 * Because RLS on ops.* tables has no `authenticated` policies, this client
 * CANNOT read/write ops data directly — it's only for auth identity checks.
 */
export async function createAdminClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // No-op in server components (cookies() is read-only there).
        }
      },
    },
  });
}

/**
 * Service-role client — bypasses RLS. Only used AFTER a request has been
 * authenticated by an admin session or a verified API key. Never exposed
 * to the browser.
 */
export function createServiceClient() {
  return createSupabaseClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
