import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InvoiceStatusBadge } from '@/components/features/worker/worker-invoice-status-badge';
import { WorkerInvoiceWithdrawButton } from '@/components/features/worker/worker-invoice-withdraw-button';
import { requireWorker } from '@/lib/auth/helpers';
import { getInvoice, getInvoiceLines } from '@/lib/db/queries/worker-invoices';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { formatCurrency } from '@/lib/pricing/calculator';

export const dynamic = 'force-dynamic';

export default async function WorkerInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const invoice = await getInvoice(tenant.id, id);
  if (!invoice || invoice.worker_profile_id !== profile.id) notFound();

  const { time, expenses } = await getInvoiceLines(tenant.id, id);
  const canWithdraw = invoice.status === 'submitted' || invoice.status === 'rejected';
  const ratePct = (invoice.tax_rate * 100).toFixed(2).replace(/\.00$/, '');

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/w/invoices"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-3.5" /> Invoices
      </Link>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <InvoiceStatusBadge status={invoice.status} />
          <h1 className="text-xl font-semibold">{formatCurrency(invoice.total_cents)}</h1>
        </div>
        {canWithdraw ? <WorkerInvoiceWithdrawButton id={invoice.id} /> : null}
      </div>

      <div className="text-sm text-muted-foreground">
        {invoice.period_start} → {invoice.period_end}
        {invoice.project_name ? ` · ${invoice.project_name}` : ''}
      </div>

      {invoice.rejection_reason ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-medium">Rejected</div>
          <div>{invoice.rejection_reason}</div>
        </div>
      ) : null}

      <div className="rounded-lg border">
        <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium">Lines</div>
        {time.length === 0 && expenses.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No lines.</p>
        ) : (
          <div className="divide-y text-sm">
            {time.map((t) => (
              <div key={`t-${t.id}`} className="flex items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div>
                    {t.entry_date} · {t.hours.toFixed(2)}h
                    {t.project_name ? ` · ${t.project_name}` : ''}
                    {t.budget_category_name ? ` · ${t.budget_category_name}` : ''}
                  </div>
                  {t.notes ? <div className="text-xs text-muted-foreground">{t.notes}</div> : null}
                </div>
                <div>{formatCurrency(t.amount_cents)}</div>
              </div>
            ))}
            {expenses.map((x) => (
              <div key={`x-${x.id}`} className="flex items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div>
                    {x.expense_date} · expense
                    {x.vendor ? ` · ${x.vendor}` : ''}
                    {x.project_name ? ` · ${x.project_name}` : ''}
                  </div>
                  {x.description ? (
                    <div className="text-xs text-muted-foreground">{x.description}</div>
                  ) : null}
                </div>
                <div>{formatCurrency(x.amount_cents)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-muted/20 p-3 text-sm">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatCurrency(invoice.subtotal_cents)}</span>
        </div>
        <div className="flex justify-between">
          <span>Tax ({ratePct}%)</span>
          <span>{formatCurrency(invoice.tax_cents)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
          <span>Total</span>
          <span>{formatCurrency(invoice.total_cents)}</span>
        </div>
      </div>

      {invoice.notes ? (
        <div className="rounded-lg border p-3 text-sm">
          <div className="text-xs font-medium text-muted-foreground">Notes</div>
          <div className="whitespace-pre-wrap">{invoice.notes}</div>
        </div>
      ) : null}
    </div>
  );
}
