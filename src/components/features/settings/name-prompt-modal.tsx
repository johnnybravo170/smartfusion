'use client';

/**
 * Soft-blocking "What should we call you?" prompt.
 *
 * Rendered from the dashboard layout when the current operator's
 * tenant_members row has no first_name. Signup didn't require a name until
 * 2026-05, so existing operators land with blank names — which surfaces as
 * "Owner/admin" on expenses, time entries, and activity feeds. The modal
 * has no close affordance and ignores escape / outside-click: the only way
 * out is to submit a first + last name.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setOperatorNameAction } from '@/server/actions/profile';

export function NamePromptModal() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const firstName = String(form.get('firstName') ?? '');
    const lastName = String(form.get('lastName') ?? '');

    startTransition(async () => {
      const result = await setOperatorNameAction({ firstName, lastName });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>What should we call you?</DialogTitle>
          <DialogDescription>
            Add your name so your team and customers see who logged what — it shows up on expenses,
            time entries, and the emails you send.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="firstName">First name</Label>
              <Input
                id="firstName"
                name="firstName"
                type="text"
                autoComplete="given-name"
                required
                disabled={pending}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last name</Label>
              <Input
                id="lastName"
                name="lastName"
                type="text"
                autoComplete="family-name"
                required
                disabled={pending}
              />
            </div>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
