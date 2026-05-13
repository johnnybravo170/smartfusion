import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDateTime } from '@/lib/date/format';
import { listTenantAuditLog } from '@/lib/db/queries/audit-log-tenant';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit log — Settings' };

type Props = {
  searchParams: Promise<{ prefix?: string; before?: string }>;
};

const PRESETS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'invoice.', label: 'Invoices' },
  { value: 'customer.', label: 'Customers' },
  { value: 'team.', label: 'Team' },
  { value: 'mfa.', label: 'Security' },
  { value: 'stripe.', label: 'Stripe' },
  { value: 'project.', label: 'Projects' },
  { value: 'estimate.', label: 'Estimates' },
  { value: 'tenant.', label: 'Workspace' },
];

export default async function SettingsAuditLogPage({ searchParams }: Props) {
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  const sp = await searchParams;
  const rows = await listTenantAuditLog({
    tenantId: tenant.id,
    actionPrefix: sp.prefix || undefined,
    before: sp.before || undefined,
    limit: 100,
  });

  const nextBefore = rows.length === 100 ? rows[rows.length - 1].createdAt : null;

  return (
    <>
      <SettingsPageHeader
        title="Audit log"
        description="Sensitive changes to your workspace. Append-only — these entries can't be edited or deleted."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {PRESETS.map((p) => {
          const active = (sp.prefix ?? '') === p.value;
          const href = p.value ? `?prefix=${encodeURIComponent(p.value)}` : '?';
          return (
            <Link
              key={p.value || 'all'}
              href={href}
              className={
                active
                  ? 'rounded-full bg-foreground px-3 py-1 text-background'
                  : 'rounded-full border px-3 py-1 text-muted-foreground hover:text-foreground'
              }
            >
              {p.label}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No audit entries{sp.prefix ? ` matching "${sp.prefix}"` : ''} yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2">Resource</th>
                <th className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    {formatDateTime(r.createdAt, { timezone: tenant.timezone ?? 'UTC' })}
                  </td>
                  <td className="px-3 py-2">{r.actorLabel}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {r.resourceType}
                    </span>{' '}
                    {r.resourceId ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.resourceId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {r.metadata ? (
                      <pre className="max-w-md overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                        {JSON.stringify(r.metadata, null, 0)}
                      </pre>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextBefore ? (
        <div className="mt-4">
          <Link
            href={`?${sp.prefix ? `prefix=${encodeURIComponent(sp.prefix)}&` : ''}before=${encodeURIComponent(nextBefore)}`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Older &rarr;
          </Link>
        </div>
      ) : null}
    </>
  );
}
