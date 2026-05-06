'use client';

import { Mail, MessageSquare } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sendReferralEmailAction, sendReferralSMSAction } from '@/server/actions/referrals';

/**
 * Normalize a user-typed phone string into E.164. Strips spaces, dashes,
 * parens; assumes North American (+1) when the user types 10 digits with
 * no country code. The server-side schema is the authority — this is just
 * a UX nicety so people don't have to remember the +1 prefix.
 */
function normalizeToE164(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return `+${trimmed.slice(1).replace(/\D/g, '')}`;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export function SendReferralForm() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [pendingEmail, startEmailTransition] = useTransition();
  const [pendingSms, startSmsTransition] = useTransition();

  function handleSendEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    startEmailTransition(async () => {
      const result = await sendReferralEmailAction(email.trim());
      if (result.ok) {
        toast.success('Referral invite sent!');
        setEmail('');
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleSendSms(e: React.FormEvent) {
    e.preventDefault();
    const e164 = normalizeToE164(phone);
    if (!e164) return;

    startSmsTransition(async () => {
      const result = await sendReferralSMSAction(e164);
      if (result.ok) {
        toast.success('Referral SMS sent!');
        setPhone('');
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Send an invite</CardTitle>
        <CardDescription>Invite a fellow contractor by email or SMS.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSendEmail} className="space-y-2">
          <Label htmlFor="referral-email">Email</Label>
          <div className="flex gap-2">
            <Input
              id="referral-email"
              type="email"
              placeholder="contractor@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={pendingEmail}
            />
            <Button type="submit" disabled={pendingEmail || !email.trim()}>
              <Mail className="mr-2 h-4 w-4" />
              {pendingEmail ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </form>

        <form onSubmit={handleSendSms} className="space-y-2">
          <Label htmlFor="referral-phone">SMS</Label>
          <div className="flex gap-2">
            <Input
              id="referral-phone"
              type="tel"
              placeholder="+16045551234"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={pendingSms}
            />
            <Button type="submit" disabled={pendingSms || !phone.trim()}>
              <MessageSquare className="mr-2 h-4 w-4" />
              {pendingSms ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
