'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function CallbackImplicitHandler({ next }: { next: string }) {
  const router = useRouter();
  const [message, setMessage] = useState('Signing you in…');

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      router.replace('/login?error=missing_code');
      return;
    }

    const params = new URLSearchParams(hash);
    const error = params.get('error');
    if (error) {
      const desc = params.get('error_description') ?? error;
      router.replace(`/login?error=${encodeURIComponent(desc)}`);
      return;
    }

    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) {
      router.replace('/login?error=missing_tokens');
      return;
    }

    const supabase = createClient();
    supabase.auth.setSession({ access_token, refresh_token }).then(({ error }) => {
      if (error) {
        router.replace(`/login?error=${encodeURIComponent(error.message)}`);
        return;
      }
      // Strip the hash so it doesn't linger in browser history / referrers.
      window.history.replaceState(null, '', window.location.pathname);
      setMessage('Signed in. Redirecting…');
      router.replace(next);
    });
  }, [router, next]);

  return (
    <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
      <span
        aria-hidden
        className="inline-block size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
      {message}
    </div>
  );
}
