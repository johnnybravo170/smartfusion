'use client';

/**
 * Onboarding verify screen — two cards (email + phone) with their own
 * action buttons. Once both are confirmed, the user lands on /dashboard.
 *
 * Email verification happens via the link in the inbox; this page polls
 * router.refresh() after a re-send so the email card flips to "Verified"
 * once the user clicks through (the /callback route refreshes the
 * session). Phone verification is in-page: send code → enter code →
 * verify.
 */

import { CheckCircle2, Mail, MessageSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { logoutAction } from '@/server/actions/auth';
import {
  resendEmailVerificationAction,
  sendPhoneVerificationAction,
  verifyPhoneAction,
} from '@/server/actions/onboarding-verification';

export function VerifyOnboarding({
  email,
  emailVerified,
  phone,
  phoneVerified,
}: {
  email: string;
  emailVerified: boolean;
  phone: string;
  phoneVerified: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [phoneInput, setPhoneInput] = useState(phone);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');

  function handleResendEmail() {
    startTransition(async () => {
      const res = await resendEmailVerificationAction();
      if (!res.ok) toast.error(res.error);
      else toast.success('Verification email sent. Check your inbox.');
    });
  }

  function handleSendCode() {
    startTransition(async () => {
      const res = await sendPhoneVerificationAction({ phone: phoneInput });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCodeSent(true);
      toast.success('Code sent — check your messages.');
    });
  }

  function handleVerifyCode() {
    startTransition(async () => {
      const res = await verifyPhoneAction({ code });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Phone verified.');
      router.refresh();
      // If email is also verified, the server-side redirect will land on
      // /dashboard on the next render.
    });
  }

  function handleRefresh() {
    router.refresh();
  }

  function handleLogout() {
    startTransition(async () => {
      await logoutAction();
    });
  }

  return (
    <div className="w-full max-w-md space-y-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Verify your account</h1>
        <p className="text-sm text-muted-foreground">
          Confirm your email and phone to unlock HeyHenry.
        </p>
      </div>

      {/* Email card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            {emailVerified ? (
              <CheckCircle2 className="size-5 text-emerald-600" />
            ) : (
              <Mail className="size-5" />
            )}
            <div>
              <CardTitle className="text-base">
                {emailVerified ? 'Email verified' : 'Verify your email'}
              </CardTitle>
              <CardDescription>{email}</CardDescription>
            </div>
          </div>
        </CardHeader>
        {!emailVerified ? (
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              We sent a confirmation link to your inbox. Click it, then come back here and refresh.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResendEmail}
                disabled={pending}
              >
                Resend email
              </Button>
              <Button type="button" size="sm" onClick={handleRefresh} disabled={pending}>
                I clicked the link
              </Button>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* Phone card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            {phoneVerified ? (
              <CheckCircle2 className="size-5 text-emerald-600" />
            ) : (
              <MessageSquare className="size-5" />
            )}
            <div>
              <CardTitle className="text-base">
                {phoneVerified ? 'Phone verified' : 'Verify your phone'}
              </CardTitle>
              <CardDescription>
                {phoneVerified ? phoneInput : 'We text a 6-digit code.'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        {!phoneVerified ? (
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="onboard-phone">Mobile phone</Label>
              <Input
                id="onboard-phone"
                type="tel"
                placeholder="+1 604 555 1234"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                disabled={pending}
              />
            </div>
            {!codeSent ? (
              <Button
                type="button"
                onClick={handleSendCode}
                disabled={pending || phoneInput.trim().length < 7}
              >
                Send code
              </Button>
            ) : (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <Label htmlFor="onboard-code">6-digit code</Label>
                <Input
                  id="onboard-code"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={pending}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={handleVerifyCode}
                    disabled={pending || code.length !== 6}
                  >
                    Verify
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleSendCode}
                    disabled={pending}
                  >
                    Resend code
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        ) : null}
      </Card>

      {emailVerified && phoneVerified ? (
        <Button className="w-full" onClick={() => router.push('/dashboard')}>
          Continue to dashboard
        </Button>
      ) : null}

      <div className="text-center">
        <button
          type="button"
          onClick={handleLogout}
          className="text-xs text-muted-foreground hover:underline"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
