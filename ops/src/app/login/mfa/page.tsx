'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

export const dynamic = 'force-dynamic';

function makeClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  );
}

export default function MfaPage() {
  const router = useRouter();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'enroll' | 'challenge' | 'loading'>('loading');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const supabase = makeClient();
    (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp?.find((f) => f.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        setMode('challenge');
        return;
      }
      // No verified TOTP factor yet — enroll one.
      const { data: enrollData, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Ops TOTP',
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      setFactorId(enrollData.id);
      setQrCode(enrollData.totp.qr_code);
      setSecret(enrollData.totp.secret);
      setMode('enroll');
    })();
  }, []);

  async function verifyAndContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    const supabase = makeClient();
    startTransition(async () => {
      if (mode === 'enroll') {
        // Pair the factor, then log the admin in with it.
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success('TOTP enrolled. Save your backup somewhere safe.');
        router.push('/dashboard');
        return;
      }
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (error) {
        toast.error(error.message);
        return;
      }
      router.push('/dashboard');
    });
  }

  if (mode === 'loading') {
    return <div className="p-8 text-sm text-[var(--muted-foreground)]">Loading…</div>;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
      <form onSubmit={verifyAndContinue} className="w-full space-y-4">
        <h1 className="text-2xl font-semibold">
          {mode === 'enroll' ? 'Set up TOTP' : 'Enter TOTP code'}
        </h1>
        {mode === 'enroll' && qrCode ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted-foreground)]">
              Scan this QR code with your authenticator app (1Password, Authy, etc.) then enter the
              6-digit code below to finish enrollment.
            </p>
            {/** biome-ignore lint/performance/noImgElement: inline svg data URL */}
            <img src={qrCode} alt="TOTP QR code" className="mx-auto" />
            {secret ? (
              <p className="break-all rounded-md bg-[var(--muted)] p-2 text-center text-xs">
                Manual key: <code>{secret}</code>
              </p>
            ) : null}
          </div>
        ) : null}
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-center text-lg tracking-[0.3em] outline-none focus:ring-2 focus:ring-[var(--ring)]"
        />
        <button
          type="submit"
          disabled={isPending || code.length !== 6}
          className="w-full rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </div>
  );
}
