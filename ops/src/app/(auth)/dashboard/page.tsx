import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase';

export default async function DashboardPage() {
  const service = createServiceClient();
  const { data: recent } = await service
    .schema('ops')
    .from('worklog_entries')
    .select('id, title, actor_name, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(10);

  const { count: keyCount } = await service
    .schema('ops')
    .from('api_keys')
    .select('*', { count: 'exact', head: true })
    .is('revoked_at', null);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card label="Active API keys" value={keyCount ?? 0} href="/admin/keys" />
        <Card label="Worklog entries" value={recent?.length ?? 0} href="/worklog" />
        <Card label="Audit log" value="view" href="/admin/audit" />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent worklog</h2>
          <Link href="/worklog" className="text-xs text-[var(--muted-foreground)] hover:underline">
            All entries →
          </Link>
        </div>
        {recent && recent.length > 0 ? (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {recent.map((e) => (
              <li key={e.id} className="px-4 py-3 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-medium">{e.title ?? '(no title)'}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {e.actor_name} · {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
            No worklog entries yet.
          </p>
        )}
      </section>
    </div>
  );
}

function Card({ label, value, href }: { label: string; value: number | string; href: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-[var(--border)] p-4 hover:border-[var(--foreground)]"
    >
      <div className="text-xs text-[var(--muted-foreground)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </Link>
  );
}
