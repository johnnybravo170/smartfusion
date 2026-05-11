'use client';

/**
 * Signup — email + password + business name. This is the ONLY path that
 * provisions a tenant row, per PHASE_1_PLAN Task 1.6. Magic link signup is
 * deferred to Phase 2.
 *
 * `useSearchParams` must live behind a Suspense boundary in Next.js 16 to
 * avoid a CSR bail-out during prerender — the rest of the form is static
 * enough to render statically.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, useTransition } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isBillingCycle, isPlan, PLAN_CATALOG } from '@/lib/billing/plans';
import { signupAction } from '@/server/actions/auth';

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [alreadyRegisteredEmail, setAlreadyRegisteredEmail] = useState<string | null>(null);
  const [acceptedPolicies, setAcceptedPolicies] = useState(false);

  const referralCode = params?.get('ref') ?? undefined;
  const planParam = params?.get('plan');
  const billingParam = params?.get('billing');
  const promoParam = params?.get('promo')?.trim() || undefined;
  const selectedPlan = isPlan(planParam) ? planParam : null;
  const selectedBilling = isBillingCycle(billingParam) ? billingParam : null;

  useEffect(() => {
    if (params?.get('error') === 'no_tenant') {
      setError('Your account is missing a business. Create a new one here or contact support.');
    }
  }, [params]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setAlreadyRegisteredEmail(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    const businessName = String(form.get('businessName') ?? '');
    const phone = String(form.get('phone') ?? '');

    startTransition(async () => {
      const result = await signupAction({
        email,
        password,
        businessName,
        phone,
        acceptedPolicies,
        referralCode,
        plan: selectedPlan ?? undefined,
        billing: selectedBilling ?? undefined,
        promo: promoParam,
      });
      if (result && 'error' in result) {
        if (result.code === 'EMAIL_ALREADY_REGISTERED') {
          setAlreadyRegisteredEmail(email);
          return;
        }
        setError(result.error);
        toast.error(result.error);
        return;
      }
      router.push('/dashboard');
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Get started with HeyHenry</CardTitle>
        <CardDescription>Run your jobs from the truck. We handle the paperwork.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          {referralCode ? (
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              You were referred by a fellow contractor — your trial gets bumped to 14 days.
            </div>
          ) : null}
          {selectedPlan ? (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              You&apos;re starting on{' '}
              <span className="font-medium">{PLAN_CATALOG[selectedPlan].name}</span>
              {selectedBilling ? (
                <span className="text-muted-foreground"> · {selectedBilling}</span>
              ) : null}
              <span className="text-muted-foreground"> · 14-day free trial, no card required</span>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="businessName">Business name</Label>
            <Input
              id="businessName"
              name="businessName"
              type="text"
              autoComplete="organization"
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
            <Label htmlFor="phone">Mobile phone</Label>
            <Input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+1 604 555 1234"
              required
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">We text a 6-digit code to verify it.</p>
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
          <div className="flex items-start gap-2 pt-1">
            <Checkbox
              id="acceptedPolicies"
              checked={acceptedPolicies}
              onCheckedChange={(v) => setAcceptedPolicies(v === true)}
              disabled={pending}
              className="mt-0.5"
              required
            />
            <Label
              htmlFor="acceptedPolicies"
              className="text-xs font-normal leading-snug text-muted-foreground"
            >
              I agree to the{' '}
              <Link
                href="/terms"
                target="_blank"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                href="/privacy"
                target="_blank"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Privacy Policy
              </Link>
              .
            </Label>
          </div>
          {alreadyRegisteredEmail ? (
            <div
              className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
              role="alert"
            >
              <p>An account with this email already exists.</p>
              <Link
                href={`/login?email=${encodeURIComponent(alreadyRegisteredEmail)}`}
                className="inline-block font-medium underline underline-offset-2"
              >
                Sign in instead →
              </Link>
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-col gap-3 pt-2">
          <Button type="submit" className="w-full" disabled={pending || !acceptedPolicies}>
            {pending ? 'Setting things up…' : 'Create my account'}
          </Button>
          <Link
            href="/login"
            className="w-full text-center text-sm text-muted-foreground hover:underline"
          >
            Already have an account? Sign in
          </Link>
          <p className="w-full text-center text-xs text-muted-foreground">
            14-day free trial. Cancel any time — see{' '}
            <Link href="/refund-policy" className="underline underline-offset-2">
              refund policy
            </Link>
            .
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
