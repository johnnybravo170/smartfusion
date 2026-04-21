'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OperatorProfile } from '@/lib/db/queries/profile';
import { updateOperatorProfileAction } from '@/server/actions/profile';

export function OperatorProfileForm({ profile }: { profile: OperatorProfile }) {
  const [firstName, setFirstName] = useState(profile.firstName ?? '');
  const [lastName, setLastName] = useState(profile.lastName ?? '');
  const [title, setTitle] = useState(profile.title ?? '');
  const [notificationPhone, setNotificationPhone] = useState(profile.notificationPhone ?? '');
  const [notifyEmail, setNotifyEmail] = useState(profile.notifyCustomerFeedbackEmail);
  const [notifySms, setNotifySms] = useState(profile.notifyCustomerFeedbackSms);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await updateOperatorProfileAction({
        firstName,
        lastName,
        title,
        notificationPhone,
        notifyCustomerFeedbackEmail: notifyEmail,
        notifyCustomerFeedbackSms: notifySms,
      });
      if (result.ok) toast.success('Your info saved.');
      else toast.error(result.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="op-first" className="mb-1.5 block text-sm">
            First name
          </Label>
          <Input id="op-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="op-last" className="mb-1.5 block text-sm">
            Last name
          </Label>
          <Input id="op-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>

      <div>
        <Label htmlFor="op-title" className="mb-1.5 block text-sm">
          Title
        </Label>
        <Input
          id="op-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Owner, Estimator, Lead Tech…"
        />
        <p className="mt-1 text-xs text-muted-foreground">Shown on emails and PDFs.</p>
      </div>

      {profile.email ? (
        <div>
          <Label className="mb-1.5 block text-sm">Sign-in email</Label>
          <div className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {profile.email}
          </div>
        </div>
      ) : null}

      <div className="mt-2 rounded-lg border p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">Notifications</h3>
          <p className="text-xs text-muted-foreground">
            Choose how you'd like to be notified when a customer leaves feedback on an estimate.
          </p>
        </div>

        <div className="mb-4">
          <Label htmlFor="op-notify-phone" className="mb-1.5 block text-sm">
            SMS phone number
          </Label>
          <Input
            id="op-notify-phone"
            value={notificationPhone}
            onChange={(e) => setNotificationPhone(e.target.value)}
            placeholder="+1 555 123 4567"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Only used for SMS alerts. Leave blank to disable SMS.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Customer feedback on estimates
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.checked)}
              className="size-4"
            />
            Email me
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={notifySms}
              onChange={(e) => setNotifySms(e.target.checked)}
              className="size-4"
              disabled={!notificationPhone.trim()}
            />
            Text me
            {!notificationPhone.trim() ? (
              <span className="text-xs text-muted-foreground">(add a phone number first)</span>
            ) : null}
          </label>
        </div>
      </div>

      <div className="pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save your info'}
        </Button>
      </div>
    </form>
  );
}
