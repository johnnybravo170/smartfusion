/**
 * CSV export of the T4A vendor roll-up for a given calendar year.
 * Layout designed to feed straight into Track1099 / Tax1099 bulk upload:
 * vendor name, total paid, over-threshold flag. Tenant info at the top.
 */

import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/auth/helpers';
import { getT4aReport } from '@/lib/db/queries/t4a-vendors';

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function GET(req: Request) {
  const { tenant, user: _user } = await requireTenant();
  // Allow bookkeepers + owners/admins. Workers don't see this.
  if (tenant.member.role === 'worker') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const yearStr = url.searchParams.get('year');
  const year = yearStr ? Number.parseInt(yearStr, 10) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 400 });
  }

  const report = await getT4aReport(tenant.id, year);

  const rows: string[] = [];
  const push = (cols: (string | number)[]) =>
    rows.push(cols.map((c) => csvEscape(String(c))).join(','));

  push(['T4A vendor report']);
  push(['Tenant', tenant.name]);
  push(['Year', String(year)]);
  push(['Total paid', formatCents(report.total_cents)]);
  push(['Vendors over $500', String(report.over_threshold_count)]);
  push([]);
  push(['Vendor', 'Transactions', 'Total paid (CAD)', 'Over $500 threshold']);
  for (const v of report.vendors) {
    push([
      v.display,
      v.transaction_count,
      formatCents(v.amount_cents),
      v.over_threshold ? 'Yes' : '',
    ]);
  }

  const csv = rows.join('\n');
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="t4a-vendors-${year}.csv"`,
    },
  });
}
