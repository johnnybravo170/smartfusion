import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase';
import { RevokeButton } from './revoke-button';

export default async function KeysPage() {
  const service = createServiceClient();
  const { data: keys } = await service
    .schema('ops')
    .from('api_keys')
    .select('id, name, scopes, expires_at, last_used_at, last_used_ip, created_at, revoked_at')
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Agent credentials for `ops.heyhenry.io/api/ops/*`. Raw secret is shown once at creation
            — log it to 1Password immediately.
          </p>
        </div>
        <Link
          href="/admin/keys/new"
          className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)]"
        >
          New key
        </Link>
      </header>

      {keys && keys.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Scopes</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2">Last used</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {keys.map((k) => {
                const expired = new Date(k.expires_at as string).getTime() < Date.now();
                const status = k.revoked_at ? 'revoked' : expired ? 'expired' : 'active';
                return (
                  <tr key={k.id}>
                    <td className="px-3 py-2 font-medium">{k.name}</td>
                    <td className="px-3 py-2 text-xs">
                      {(k.scopes as string[]).join(', ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {new Date(k.expires_at as string).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {k.last_used_at
                        ? `${new Date(k.last_used_at as string).toLocaleString()} · ${k.last_used_ip ?? ''}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          status === 'active'
                            ? 'text-emerald-600'
                            : status === 'expired'
                              ? 'text-amber-600'
                              : 'text-[var(--destructive)]'
                        }
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {status === 'active' ? <RevokeButton id={k.id as string} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
          No keys yet.
        </p>
      )}
    </div>
  );
}
