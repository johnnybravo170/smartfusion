'use client';

/**
 * Worker join page: app.heyhenry.io/join/{code}
 *
 * Three paths:
 *  1. Already signed in → one-click "Join as [email]" (no form).
 *  2. Returning worker → "Sign in to join" tab.
 *  3. New worker       → "Create account" tab (default).
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  joinTenantWithSessionAction,
  workerLoginAndJoinAction,
  workerSignupAction,
} from '@/server/actions/worker-auth';

type InviteInfo = {
  valid: boolean;
  tenantName?: string;
  logoUrl?: string | null;
  /** 'worker' (→ /w), 'bookkeeper' (→ /bk), or 'member' (→ /dashboard). */
  role?: 'worker' | 'bookkeeper' | 'member';
  invitedName?: string | null;
  invitedEmail?: string | null;
};

type Mode = 'new' | 'existing';

export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>('new');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  const code = params.code;

  // Post-join destination varies by role: workers land on /w, bookkeepers
  // on /bk, full team members on the regular dashboard.
  function destinationForRole(): string {
    const role = inviteInfo?.role;
    if (role === 'bookkeeper') return '/bk';
    if (role === 'member') return '/dashboard';
    return '/w';
  }

  useEffect(() => {
    async function init() {
      try {
        // Check invite validity and session in parallel.
        const [inviteRes, { createBrowserClient }] = await Promise.all([
          fetch(`/api/invite/${code}`),
          import('@supabase/ssr'),
        ]);

        const supabase = createBrowserClient(
          // biome-ignore lint/style/noNonNullAssertion: required env vars
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          // biome-ignore lint/style/noNonNullAssertion: required env vars
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        );
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user?.email) setSessionEmail(user.email);

        if (inviteRes.ok) {
          const data = await inviteRes.json();
          setInviteInfo({
            valid: true,
            tenantName: data.tenantName,
            logoUrl: data.logoUrl ?? null,
            role: (data.role as 'worker' | 'bookkeeper' | 'member') ?? 'worker',
            invitedName: data.invitedName ?? null,
            invitedEmail: data.invitedEmail ?? null,
          });
        } else {
          setInviteInfo({ valid: false });
        }
      } catch {
        setInviteInfo({ valid: false });
      } finally {
        setChecking(false);
      }
    }
    init();
  }, [code]);

  // Path 1: already signed in — one-click join.
  function handleJoinWithSession() {
    setError(null);
    startTransition(async () => {
      const result = await joinTenantWithSessionAction(code);
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      router.push(destinationForRole());
    });
  }

  // Path 2: sign in + join.
  function onSignInSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    startTransition(async () => {
      const result = await workerLoginAndJoinAction({ email, password, inviteCode: code });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      router.push(destinationForRole());
    });
  }

  // Path 3: create new account + join.
  function onSignUpSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '');
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    startTransition(async () => {
      const result = await workerSignupAction({ name, email, password, inviteCode: code });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      router.push(destinationForRole());
    });
  }

  if (checking) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Checking invite...</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-20 animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  }

  if (!inviteInfo?.valid) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Invite not valid</CardTitle>
          <CardDescription>
            This invite link is no longer valid. Contact your employer for a new one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { tenantName, logoUrl, invitedName, invitedEmail } = inviteInfo;

  return (
    <Card>
      <CardHeader>
        {logoUrl ? (
          <div className="mb-3 flex h-20 max-w-[280px] items-center justify-center">
            {/* biome-ignore lint/performance/noImgElement: external tenant logo URL */}
            <img
              src={logoUrl}
              alt={`${tenantName} logo`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : null}
        <CardTitle className="text-2xl">Join {tenantName}</CardTitle>
        <CardDescription>
          {tenantName} has invited you to join their team on HeyHenry.
        </CardDescription>
      </CardHeader>

      {/* Path 1: already signed in */}
      {sessionEmail ? (
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            You're signed in as <span className="font-medium text-foreground">{sessionEmail}</span>.
          </p>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button className="w-full" onClick={handleJoinWithSession} disabled={pending}>
            {pending ? 'Joining...' : `Join ${tenantName}`}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Not you?{' '}
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={() => setSessionEmail(null)}
            >
              Sign in with a different account
            </button>
          </p>
        </CardContent>
      ) : (
        <>
          {/* Mode toggle */}
          <CardContent className="pb-0">
            <div className="mb-4 inline-flex w-full rounded-md border bg-muted/40 p-0.5 text-sm">
              <button
                type="button"
                onClick={() => {
                  setMode('new');
                  setError(null);
                }}
                className={`flex-1 rounded py-1.5 text-center transition-colors ${
                  mode === 'new'
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                New account
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('existing');
                  setError(null);
                }}
                className={`flex-1 rounded py-1.5 text-center transition-colors ${
                  mode === 'existing'
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Already have an account
              </button>
            </div>
          </CardContent>

          {/* Path 3: new account */}
          {mode === 'new' ? (
            <form onSubmit={onSignUpSubmit}>
              <CardContent className="space-y-4 pt-0">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    defaultValue={invitedName ?? ''}
                    required
                    disabled={pending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    defaultValue={invitedEmail ?? ''}
                    required
                    disabled={pending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">
                    At least 8 characters with one letter and one number.
                  </p>
                </div>
                {error ? (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
              </CardContent>
              <CardFooter className="pt-2">
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? 'Creating account...' : 'Join team'}
                </Button>
              </CardFooter>
            </form>
          ) : (
            /* Path 2: sign in with existing account */
            <form onSubmit={onSignInSubmit}>
              <CardContent className="space-y-4 pt-0">
                <div className="space-y-2">
                  <Label htmlFor="si-email">Email</Label>
                  <Input
                    id="si-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    defaultValue={invitedEmail ?? ''}
                    required
                    disabled={pending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="si-password">Password</Label>
                  <Input
                    id="si-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    disabled={pending}
                  />
                </div>
                {error ? (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
              </CardContent>
              <CardFooter className="pt-2">
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? 'Signing in...' : 'Sign in & join team'}
                </Button>
              </CardFooter>
            </form>
          )}
        </>
      )}
    </Card>
  );
}
