'use client';

/**
 * Request a magic link for an existing account.
 *
 * Only existing users can sign in this way — `shouldCreateUser: false` in
 * the server action prevents magic-link signups from skipping the tenant
 * bootstrap. Phase 2 can extend this if we want to add magic-link signup
 * with a post-confirm onboarding step.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
import { requestMagicLinkAction } from '@/server/actions/auth';

export default function MagicLinkPage() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');

    startTransition(async () => {
      const result = await requestMagicLinkAction({ email });
      if ('error' in result) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      router.push(`/check-email?email=${encodeURIComponent(result.email)}`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Magic link</CardTitle>
        <CardDescription>We&apos;ll email you a one-click sign-in link.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
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
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-col gap-3 pt-2">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Sending…' : 'Send me a magic link'}
          </Button>
          <Link
            href="/login"
            className="w-full text-center text-sm text-muted-foreground hover:underline"
          >
            Back to password sign-in
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
