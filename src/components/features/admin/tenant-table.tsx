import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { TenantListRow } from '@/lib/db/queries/admin';

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // Platform-admin surface — staff in Vancouver. No per-tenant tz applies.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

type Props = {
  tenants: TenantListRow[];
};

export function TenantTable({ tenants }: Props) {
  if (tenants.length === 0) {
    return <p className="text-muted-foreground py-8 text-center">No operators yet.</p>;
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Business</TableHead>
            <TableHead>Owner email</TableHead>
            <TableHead>Signup</TableHead>
            <TableHead className="text-right">Jobs</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead>Last active</TableHead>
            <TableHead>Stripe</TableHead>
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tenants.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{t.ownerEmail ?? '—'}</TableCell>
              <TableCell className="text-sm">{formatDate(t.createdAt)}</TableCell>
              <TableCell className="text-right tabular-nums">{t.jobCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCents(t.revenueCents)}
              </TableCell>
              <TableCell className="text-sm">{formatRelative(t.lastActive)}</TableCell>
              <TableCell>
                <Badge variant={t.stripeConnected ? 'default' : 'secondary'}>
                  {t.stripeConnected ? 'Connected' : 'Not connected'}
                </Badge>
              </TableCell>
              <TableCell>
                <Link
                  href={`/admin/tenants/${t.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
