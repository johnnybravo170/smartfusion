import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AttentionItem } from '@/lib/db/queries/dashboard';
import { formatCurrency } from '@/lib/pricing/calculator';

const MAX_VISIBLE = 5;

function AttentionRow({ item }: { item: AttentionItem }) {
  switch (item.kind) {
    case 'overdue_todo':
      return (
        <li className="text-sm">
          <span className="font-medium text-destructive">Overdue:</span> {item.title}{' '}
          <span className="text-muted-foreground">
            ({item.daysOverdue} {item.daysOverdue === 1 ? 'day' : 'days'} overdue)
          </span>
        </li>
      );
    case 'stale_quote':
      return (
        <li className="text-sm">
          <Link href={`/quotes/${item.id}`} className="hover:underline">
            Quote for <span className="font-medium">{item.customerName}</span>
          </Link>{' '}
          <span className="text-muted-foreground">
            sent {item.daysSinceSent} {item.daysSinceSent === 1 ? 'day' : 'days'} ago, no response
          </span>
        </li>
      );
    case 'overdue_invoice':
      return (
        <li className="text-sm">
          <Link href={`/invoices/${item.id}`} className="hover:underline">
            Invoice for <span className="font-medium">{item.customerName}</span>{' '}
            <span className="text-muted-foreground">
              ({formatCurrency(item.amountCents + item.taxCents)})
            </span>
          </Link>{' '}
          <span className="text-muted-foreground">
            unpaid for {item.daysSinceSent} {item.daysSinceSent === 1 ? 'day' : 'days'}
          </span>
        </li>
      );
  }
}

export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const hasMore = items.length > MAX_VISIBLE;
  const visible = items.slice(0, MAX_VISIBLE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs Attention</CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">Everything looks good. No overdue items.</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <AttentionRow key={`${item.kind}-${item.id}`} item={item} />
            ))}
          </ul>
        )}
        {hasMore && (
          <Link
            href="/inbox"
            className="mt-3 inline-block text-sm text-primary underline underline-offset-4"
          >
            View all
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
