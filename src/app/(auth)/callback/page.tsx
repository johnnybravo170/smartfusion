/**
 * OAuth + magic-link callback.
 *
 * Supabase email flows redirect here in one of two shapes:
 *   - PKCE flow:     ?code=...&next=...                (handled server-side)
 *   - Implicit flow: #access_token=...&refresh_token=... (handled client-side
 *                                                        — fragments aren't
 *                                                        sent to the server)
 *
 * `admin.auth.admin.generateLink({ type: 'magiclink' })` returns implicit-flow
 * links, so the client fallback is required for any admin-generated link
 * (signup verification, resend, etc.) to actually create a session.
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { CallbackImplicitHandler } from './implicit-handler';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  code?: string;
  next?: string;
  error?: string;
  error_description?: string;
}>;

export default async function CallbackPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = params.next ?? '/dashboard';
  const target = next.startsWith('/') ? next : `/${next}`;

  if (params.error) {
    redirect(`/login?error=${encodeURIComponent(params.error_description ?? params.error)}`);
  }

  if (params.code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) {
      redirect(`/login?error=${encodeURIComponent(error.message)}`);
    }

    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1') {
      redirect('/login/mfa');
    }

    redirect(target);
  }

  return <CallbackImplicitHandler next={target} />;
}
