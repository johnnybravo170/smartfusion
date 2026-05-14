import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { StaleQuotesList } from '@/components/features/quotes/stale-quotes-list';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { hasFeature } from '@/lib/billing/features';
import { formatCurrency } from '@/lib/pricing/calculator';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const STALE_DAYS = 7;

export default async function StaleQuotesPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login');

  const featureUnlocked = hasFeature(
    { plan: tenant.plan, subscriptionStatus: tenant.subscriptionStatus },
    'customers.followup_sequences',
  );

  const supabase = await createClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Project-based estimates that have been sent but not yet acted on.
  const { data: projects } = await supabase
    .from('projects')
    .select(
      'id, name, estimate_status, estimate_sent_at, customers:customer_id (id, name, email, phone, do_not_auto_message)',
    )
    .eq('estimate_status', 'pending_approval')
    .lte('estimate_sent_at', cutoff)
    .is('deleted_at', null)
    .order('estimate_sent_at', { ascending: true });

  // Pull cost lines for total; cheap loop, low row count.
  // Customer-facing: this total mirrors the quote the customer signed.
  const taxCtx = await canadianTax.getCustomerFacingContext(tenant.id);
  const rows = await Promise.all(
    (projects ?? []).map(async (p) => {
      const proj = p as Record<string, unknown>;
      const customer = proj.customers as Record<string, unknown> | null;
      const { data: lines } = await supabase
        .from('project_cost_lines')
        .select('line_price_cents')
        .eq('project_id', proj.id as string);
      const subtotal = (lines ?? []).reduce(
        (s, l) => s + ((l as { line_price_cents: number }).line_price_cents ?? 0),
        0,
      );
      const total = Math.round(subtotal * (1 + taxCtx.totalRate));
      const sentAt = proj.estimate_sent_at as string;
      const daysStale = Math.floor(
        (Date.now() - new Date(sentAt).getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        projectId: proj.id as string,
        projectName: (proj.name as string) ?? 'Untitled project',
        customerId: (customer?.id as string) ?? null,
        customerName: (customer?.name as string) ?? 'Customer',
        customerEmail: (customer?.email as string | null) ?? null,
        customerHasKillSwitch: Boolean(customer?.do_not_auto_message),
        totalFormatted: formatCurrency(total),
        sentAt,
        daysStale,
      };
    }),
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div>
        <Link
          href="/quotes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to quotes
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stale quotes</h1>
        <p className="text-sm text-muted-foreground">
          Estimates you sent {STALE_DAYS}+ days ago that haven't been accepted yet. Pick the ones
          you want Henry to follow up on — SMS at 24h, email at 48h.
        </p>
      </div>

      <StaleQuotesList rows={rows} featureUnlocked={featureUnlocked} />
    </div>
  );
}
