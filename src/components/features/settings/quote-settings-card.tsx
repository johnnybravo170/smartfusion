'use client';

import { Clock } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { updateQuoteSettingsAction } from '@/server/actions/settings';

type Props = {
  currentValidityDays: number;
};

export function QuoteSettingsCard({ currentValidityDays }: Props) {
  const [days, setDays] = useState(String(currentValidityDays));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const parsed = parseInt(days, 10);
    if (!parsed || parsed < 1 || parsed > 365) {
      toast.error('Enter a number between 1 and 365.');
      return;
    }

    startTransition(async () => {
      const result = await updateQuoteSettingsAction({ quote_validity_days: parsed });
      if (result.ok) {
        toast.success('Quote settings saved.');
      } else {
        toast.error(result.error ?? 'Failed to save.');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="size-5" />
          <div>
            <CardTitle>Quoting</CardTitle>
            <CardDescription>How long quotes are valid before they expire.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label htmlFor="quote-validity" className="mb-1.5 block text-sm font-medium">
              Quote validity (days)
            </label>
            <Input
              id="quote-validity"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="max-w-32"
            />
          </div>
          <Button onClick={handleSave} disabled={isPending} size="sm">
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
