'use client';

/**
 * Worker join page: app.heyhenry.io/join/{code}
 *
 * Shows the invite details and a signup form. Workers join an existing
 * tenant (no business name field). The invite code is validated server-side
 * on form submission.
 *
 * This is a client component because it needs useTransition for the form
 * submission and useParams for the invite code.
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
import { workerSignupAction } from '@/server/actions/worker-auth';

type InviteInfo = {
  valid: boolean;
  tenantName?: string;
  logoUrl?: string | null;
};

export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [checking, setChecking] = useState(true);

  const code = params.code;

  // Validate the invite code on mount via a lightweight server action call.
  useEffect(() => {
    async function checkInvite() {
      try {
        const res = await fetch(`/api/invite/${code}`);
        if (res.ok) {
          const data = await res.json();
          setInviteInfo({
            valid: true,
            tenantName: data.tenantName,
            logoUrl: data.logoUrl ?? null,
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
    checkInvite();
  }, [code]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
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
      router.push('/dashboard');
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

  return (
    <Card>
      <CardHeader>
        {inviteInfo.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={inviteInfo.logoUrl}
            alt={`${inviteInfo.tenantName} logo`}
            className="mb-3 h-16 w-auto object-contain"
          />
        ) : null}
        <CardTitle className="text-2xl">Join {inviteInfo.tenantName}</CardTitle>
        <CardDescription>
          {inviteInfo.tenantName} has invited you to join their team on HeyHenry.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
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
    </Card>
  );
}
