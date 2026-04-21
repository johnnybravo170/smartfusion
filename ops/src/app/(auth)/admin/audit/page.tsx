import { createServiceClient } from '@/lib/supabase';

export default async function AuditPage() {
  const service = createServiceClient();
  const { data: rows } = await service
    .schema('ops')
    .from('audit_log')
    .select('id, key_id, admin_user_id, method, path, status, ip, reason, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(200);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Every authenticated request + every auth failure. Immutable.
        </p>
      </header>

      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--muted)] text-left text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Path</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">IP</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] font-mono">
              {rows.map((r) => (
                <tr key={r.id} className={r.status >= 400 ? 'bg-red-50' : ''}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(r.occurred_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    {r.admin_user_id
                      ? 'admin'
                      : r.key_id
                        ? `key:${(r.key_id as string).slice(0, 8)}`
                        : '—'}
                  </td>
                  <td className="px-3 py-2">{r.method}</td>
                  <td className="px-3 py-2 max-w-xs truncate">{r.path}</td>
                  <td className="px-3 py-2">{r.status}</td>
                  <td className="px-3 py-2">{r.ip ?? '—'}</td>
                  <td className="px-3 py-2 max-w-xs truncate">{r.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
          No audit entries yet.
        </p>
      )}
    </div>
  );
}
