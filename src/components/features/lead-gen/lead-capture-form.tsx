'use client';

/**
 * Step 2 of the public lead-gen flow: contact info capture.
 *
 * Collects name, email, phone, and optional notes from the homeowner.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Wording shown next to the marketing opt-in checkbox. Captured verbatim
 * into `consent_events.wording_shown` at submission time so a CASL audit
 * can prove what the recipient agreed to.
 */
export const MARKETING_OPT_IN_WORDING =
  'Yes, send me occasional tips, seasonal reminders, and special offers. (Optional — your quote does not depend on this.)';

type LeadCaptureFormProps = {
  onSubmit: (data: {
    name: string;
    email: string;
    phone: string;
    notes: string;
    marketingOptIn: boolean;
    marketingWording: string;
  }) => void;
  pending: boolean;
  error: string | null;
};

export function LeadCaptureForm({ onSubmit, pending, error }: LeadCaptureFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (!name.trim()) {
      setLocalError('Please enter your name.');
      return;
    }
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) {
      setLocalError('Please enter a valid email address.');
      return;
    }
    if (!phone.trim() || phone.trim().length < 7) {
      setLocalError('Please enter a valid phone number.');
      return;
    }

    onSubmit({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      notes: notes.trim(),
      marketingOptIn,
      marketingWording: MARKETING_OPT_IN_WORDING,
    });
  }

  const displayError = error || localError;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="lead-name" className="mb-1 block text-sm font-medium">
          Name *
        </label>
        <Input
          id="lead-name"
          type="text"
          placeholder="Your full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="name"
        />
      </div>

      <div>
        <label htmlFor="lead-email" className="mb-1 block text-sm font-medium">
          Email *
        </label>
        <Input
          id="lead-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </div>

      <div>
        <label htmlFor="lead-phone" className="mb-1 block text-sm font-medium">
          Phone *
        </label>
        <Input
          id="lead-phone"
          type="tel"
          placeholder="(555) 123-4567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          autoComplete="tel"
        />
      </div>

      <div>
        <label htmlFor="lead-notes" className="mb-1 block text-sm font-medium">
          Message <span className="text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="lead-notes"
          rows={3}
          placeholder="Anything we should know? Access instructions, special requests, etc."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5">
        <Checkbox
          id="lead-marketing-optin"
          checked={marketingOptIn}
          onCheckedChange={(v) => setMarketingOptIn(v === true)}
          className="mt-0.5"
        />
        <Label
          htmlFor="lead-marketing-optin"
          className="flex-1 cursor-pointer text-xs font-normal text-muted-foreground"
        >
          {MARKETING_OPT_IN_WORDING}
        </Label>
      </div>

      {displayError ? (
        <p className="text-sm text-destructive" role="alert">
          {displayError}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? 'Submitting...' : 'Submit'}
      </Button>
    </form>
  );
}
