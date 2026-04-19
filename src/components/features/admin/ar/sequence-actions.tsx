'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { setArSequenceStatusAction } from '@/server/actions/ar-admin';

type Status = 'draft' | 'active' | 'paused' | 'archived';

const BUTTONS: Array<{
  label: string;
  next: Status;
  show: (current: Status) => boolean;
  variant?: 'default' | 'outline' | 'destructive';
}> = [
  {
    label: 'Activate',
    next: 'active',
    show: (c) => c === 'draft' || c === 'paused',
    variant: 'default',
  },
  { label: 'Pause', next: 'paused', show: (c) => c === 'active', variant: 'outline' },
  { label: 'Archive', next: 'archived', show: (c) => c !== 'archived', variant: 'destructive' },
];

export function SequenceStatusActions({
  sequenceId,
  status,
}: {
  sequenceId: string;
  status: Status;
}) {
  const [pending, startTransition] = useTransition();

  const run = (next: Status) => {
    startTransition(async () => {
      const result = await setArSequenceStatusAction(sequenceId, next);
      if (result.ok) {
        toast.success(`Sequence ${next === 'active' ? 'activated' : next}`);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex gap-2">
      {BUTTONS.filter((b) => b.show(status)).map((b) => (
        <Button
          key={b.next}
          variant={b.variant ?? 'default'}
          size="sm"
          disabled={pending}
          onClick={() => run(b.next)}
        >
          {b.label}
        </Button>
      ))}
    </div>
  );
}
