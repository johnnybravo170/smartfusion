'use client';

import { CreditCard } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UpdateCardDialog } from '@/components/features/billing/update-card-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function PaymentMethodCard({
  card,
}: {
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start gap-2">
            <CreditCard className="size-5 mt-0.5" />
            <div>
              <CardTitle>Payment method</CardTitle>
              <CardDescription>Used for renewals and any plan changes.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3 flex-wrap">
          {card ? (
            <div className="text-sm">
              <span className="font-medium capitalize">{card.brand}</span>{' '}
              <span className="text-muted-foreground">•••• {card.last4}</span>
              <span className="text-muted-foreground">
                {' '}
                · expires {String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No card on file.</p>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {card ? 'Update card' : 'Add card'}
          </Button>
        </CardContent>
      </Card>

      <UpdateCardDialog open={open} onOpenChange={setOpen} onUpdated={() => router.refresh()} />
    </>
  );
}
