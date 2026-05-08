import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type ReferralEntry = {
  id: string;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: string;
};

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  signed_up: 'secondary',
  converted: 'default',
  churned: 'destructive',
};

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

export function ReferralHistory({
  referrals,
  timezone,
}: {
  referrals: ReferralEntry[];
  timezone: string;
}) {
  if (referrals.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Referral history</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No referrals yet. Share your link or send an invite to get started.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Referral history</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {referrals.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-sm">
                  {r.email ?? r.phone ?? 'Link signup'}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant[r.status] ?? 'outline'}>
                    {r.status.replace('_', ' ')}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(r.created_at, timezone)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
