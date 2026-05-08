import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { TenantDetailData } from '@/lib/db/queries/admin';

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

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

type Props = {
  tenant: TenantDetailData;
};

export function TenantDetail({ tenant }: Props) {
  const stripeConnected = !!tenant.stripeAccountId;

  return (
    <div className="flex flex-col gap-6">
      {/* Business info */}
      <Card>
        <CardHeader>
          <CardTitle>{tenant.name}</CardTitle>
          <CardDescription>Tenant ID: {tenant.id}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Owner email</dt>
              <dd className="font-medium">{tenant.ownerEmail ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Signup date</dt>
              <dd className="font-medium">{formatDate(tenant.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Timezone</dt>
              <dd className="font-medium">{tenant.timezone}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Currency</dt>
              <dd className="font-medium">{tenant.currency}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Province</dt>
              <dd className="font-medium">{tenant.province ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Stripe</dt>
              <dd>
                <Badge variant={stripeConnected ? 'default' : 'secondary'}>
                  {stripeConnected ? 'Connected' : 'Not connected'}
                </Badge>
                {tenant.stripeOnboardedAt && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    since {formatDate(tenant.stripeOnboardedAt)}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
        {Object.entries(tenant.stats).map(([key, count]) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardDescription className="capitalize">{key}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{count}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent activity</CardTitle>
          <CardDescription>Last 20 worklog entries</CardDescription>
        </CardHeader>
        <CardContent>
          {tenant.recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity recorded.</p>
          ) : (
            <ul className="divide-y">
              {tenant.recentActivity.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <Badge variant="outline" className="mt-0.5 shrink-0 text-xs">
                    {entry.entryType}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{entry.title ?? 'Untitled'}</p>
                    {entry.body && (
                      <p className="text-sm text-muted-foreground line-clamp-2">{entry.body}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatRelative(entry.createdAt)}
                      {entry.relatedType && (
                        <span className="ml-2 capitalize">{entry.relatedType}</span>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
