import { createServiceClient } from '@/lib/supabase';
import { fmtDate, fmtDateTime } from '@/lib/tz';
import { RevokeAllButton } from './revoke-all-button';
import { RevokeTokenButton } from './revoke-token-button';

type AuditRow = {
  path: string;
  status: number;
  occurred_at: string;
  key_id: string | null;
};

type TokenRow = {
  id: string;
  client_id: string;
  scopes: string[] | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};

type ClientRow = { client_id: string; client_name: string | null };

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default async function McpAdminPage() {
  const service = createServiceClient();
  const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  const [{ data: auditData }, { data: tokenData }, { data: clientData }] = await Promise.all([
    service
      .schema('ops')
      .from('audit_log')
      .select('path, status, occurred_at, key_id')
      .like('path', '/api/mcp/%')
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(5000),
    service
      .schema('ops')
      .from('oauth_tokens')
      .select('id, client_id, scopes, created_at, expires_at, revoked_at, last_used_at')
      .order('created_at', { ascending: false }),
    service.schema('ops').from('oauth_clients').select('client_id, client_name'),
  ]);

  const audit: AuditRow[] = (auditData ?? []) as AuditRow[];
  const tokens: TokenRow[] = (tokenData ?? []) as TokenRow[];
  const clients: ClientRow[] = (clientData ?? []) as ClientRow[];
  const clientNameById = new Map(clients.map((c) => [c.client_id, c.client_name]));

  // ---- Usage summary ---------------------------------------------------
  const totalCalls = audit.length;
  const successes = audit.filter((r) => r.status >= 200 && r.status < 300).length;
  const failures = totalCalls - successes;

  // Per-day buckets (Pacific days, last 7). Using en-CA locale + Vancouver
  // TZ produces YYYY-MM-DD strings aligned to PT calendar days, so a call
  // at 8pm PT counts under that day instead of bleeding into UTC tomorrow.
  const ptDay = (d: Date): string =>
    d.toLocaleDateString('en-CA', {
      timeZone: 'America/Vancouver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  const dayBuckets: { day: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dayBuckets.push({ day: ptDay(d), count: 0 });
  }
  const dayIndex = new Map(dayBuckets.map((b, i) => [b.day, i]));
  for (const r of audit) {
    const key = ptDay(new Date(r.occurred_at));
    const idx = dayIndex.get(key);
    if (idx !== undefined) dayBuckets[idx].count += 1;
  }
  const maxDay = Math.max(1, ...dayBuckets.map((b) => b.count));

  // Per-tool breakdown.
  const toolCounts = new Map<string, number>();
  for (const r of audit) {
    const tool = r.path.replace(/^\/api\/mcp\//, '').split('?')[0];
    if (!tool) continue;
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Per-token (client_id) breakdown — keyed by token.id when available.
  // audit.key_id stores the OAuth token id for MCP requests (see withAudit).
  const tokenById = new Map(tokens.map((t) => [t.id, t]));
  const perClient = new Map<string, number>();
  for (const r of audit) {
    const tok = r.key_id ? tokenById.get(r.key_id) : null;
    const label = tok ? clientNameById.get(tok.client_id) || tok.client_id : '(unknown)';
    perClient.set(label, (perClient.get(label) ?? 0) + 1);
  }
  const perClientList = [...perClient.entries()].sort((a, b) => b[1] - a[1]);

  const uniqueClientIds = new Set<string>();
  for (const r of audit) {
    const tok = r.key_id ? tokenById.get(r.key_id) : null;
    if (tok) uniqueClientIds.add(tok.client_id);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">MCP</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Remote MCP token observability + bulk controls. Per-token rate limit:{' '}
          {process.env.MCP_RATE_LIMIT_PER_MIN ?? 120} req/min.
        </p>
      </header>

      {/* Usage summary */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Usage (last 7 days)</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Total calls" value={totalCalls} />
          <Stat label="Successes" value={successes} />
          <Stat label="Failures" value={failures} />
          <Stat label="Unique clients" value={uniqueClientIds.size} />
        </div>

        <div className="rounded-md border border-[var(--border)] p-3">
          <div className="mb-2 text-xs text-[var(--muted-foreground)]">Per day</div>
          <div className="flex items-end gap-1 h-24">
            {dayBuckets.map((b) => (
              <div key={b.day} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-full w-full items-end">
                  <div
                    className="w-full rounded-sm bg-[var(--primary)]"
                    style={{ height: `${(b.count / maxDay) * 100}%` }}
                    title={`${b.day}: ${b.count}`}
                  />
                </div>
                <div className="text-[10px] text-[var(--muted-foreground)]">{b.day.slice(5)}</div>
                <div className="text-[10px] font-mono">{b.count}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <BreakdownTable title="Top tools" rows={topTools} />
          <BreakdownTable title="By client" rows={perClientList} />
        </div>
      </section>

      {/* Active tokens */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Tokens</h2>
        {tokens.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
                <tr>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2">Scopes</th>
                  <th className="px-3 py-2">Issued</th>
                  <th className="px-3 py-2">Last used</th>
                  <th className="px-3 py-2">Expires</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {tokens.map((t) => {
                  const expired = new Date(t.expires_at).getTime() < Date.now();
                  const status = t.revoked_at ? 'revoked' : expired ? 'expired' : 'active';
                  const scopes = t.scopes ?? [];
                  const name = clientNameById.get(t.client_id) || t.client_id;
                  return (
                    <tr key={t.id}>
                      <td className="px-3 py-2 font-medium">
                        <div>{name}</div>
                        {name !== t.client_id && (
                          <div className="font-mono text-[10px] text-[var(--muted-foreground)]">
                            {t.client_id}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs" title={scopes.join('\n')}>
                        {scopes.length}
                      </td>
                      <td className="px-3 py-2 text-xs">{fmtDate(t.created_at)}</td>
                      <td className="px-3 py-2 text-xs">
                        {t.last_used_at ? fmtDateTime(t.last_used_at) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">{fmtDate(t.expires_at)}</td>
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
                        {status === 'active' ? <RevokeTokenButton id={t.id} /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
            No tokens issued yet.
          </p>
        )}
      </section>

      {/* Danger zone */}
      <section className="space-y-3 rounded-md border border-[var(--destructive)]/30 p-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--destructive)]">Danger zone</h2>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            Revokes every non-revoked OAuth token. Each connected client will get a 401 on its next
            request and must re-run the authorization flow.
          </p>
        </div>
        <RevokeAllButton />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <div className="text-xs text-[var(--muted-foreground)]">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="rounded-md border border-[var(--border)]">
      <div className="border-b border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-xs font-medium text-[var(--muted-foreground)]">
        {title}
      </div>
      {rows.length > 0 ? (
        <table className="w-full text-xs">
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="px-3 py-1.5 font-mono">{k}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">No data.</div>
      )}
    </div>
  );
}
