'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { resumeSubscriptionAction } from '@/server/actions/billing-management';

export function ResumeSubscriptionButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      const r = await resumeSubscriptionAction();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success('Subscription resumed.');
      router.refresh();
    });
  }

  return (
    <Button type="button" size="sm" onClick={handleClick} disabled={pending}>
      {pending ? 'Resuming…' : 'Resume now'}
    </Button>
  );
}
