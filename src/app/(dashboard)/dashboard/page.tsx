import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const supabase = await createClient();
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [quotesWeek, openJobs, unpaidInvoices] = await Promise.all([
    supabase.from('quotes').select('*', { count: 'exact', head: true }).gte('sent_at', sinceIso),
    supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .in('status', ['booked', 'in_progress']),
    supabase
      .from('invoices')
      .select('*', { count: 'exact', head: true })
      .in('status', ['draft', 'sent']),
  ]);

  const stats = [
    {
      label: 'Quotes this week',
      value: quotesWeek.count ?? 0,
      detail: quotesWeek.count === 0 ? 'None sent in the last 7 days.' : 'Sent in the last 7 days.',
    },
    {
      label: 'Open jobs',
      value: openJobs.count ?? 0,
      detail: openJobs.count === 0 ? 'No active work right now.' : 'Booked or in progress.',
    },
    {
      label: 'Unpaid invoices',
      value: unpaidInvoices.count ?? 0,
      detail: unpaidInvoices.count === 0 ? 'Everything caught up.' : 'Draft or awaiting payment.',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">A snapshot of your business this week.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-3xl font-semibold tabular-nums">{stat.value}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{stat.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
