import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  type PublicQuoteCatalogEntry,
  PublicQuoteForm,
} from '@/components/features/lead-gen/public-quote-form';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const admin = createAdminClient();

  const { data: tenant } = await admin.from('tenants').select('name').eq('slug', slug).single();

  if (!tenant) {
    return { title: 'Quote — HeyHenry' };
  }

  return {
    title: `Get a Quote — ${tenant.name}`,
    description: `Get an instant estimate from ${tenant.name}.`,
  };
}

export default async function PublicQuotePage({ params }: Props) {
  const { slug } = await params;

  if (!slug) {
    notFound();
  }

  const admin = createAdminClient();

  // Load tenant by slug.
  const { data: tenant, error: tenantErr } = await admin
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', slug)
    .single();

  if (tenantErr || !tenant) {
    notFound();
  }

  // Load per_unit/sqft catalog items for this tenant. The public widget
  // only handles map-style per-sqft pricing — flat-rate, hourly, and T&M
  // items live in /settings/pricebook but aren't quotable through this
  // public page.
  const { data: catalog } = await admin
    .from('catalog_items')
    .select('id, name, surface_type, unit_price_cents, min_charge_cents, unit_label')
    .eq('tenant_id', tenant.id)
    .eq('is_active', true)
    .eq('pricing_model', 'per_unit')
    .not('surface_type', 'is', null)
    .order('name', { ascending: true });

  type Row = {
    id: string;
    name: string;
    surface_type: string | null;
    unit_price_cents: number | null;
    min_charge_cents: number | null;
    unit_label: string | null;
  };
  const catalogEntries: PublicQuoteCatalogEntry[] = ((catalog ?? []) as Row[])
    .filter((row): row is Row & { surface_type: string } => row.surface_type !== null)
    .map((row) => ({
      id: row.id,
      surface_type: row.surface_type,
      label: row.name,
      pricing_model: 'per_unit' as const,
      unit_price_cents: row.unit_price_cents ?? 0,
      min_charge_cents: row.min_charge_cents ?? 0,
      unit_label: row.unit_label,
    }));

  if (catalogEntries.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">{tenant.name as string}</h1>
        <p className="text-muted-foreground">
          This operator hasn&apos;t set up pricing yet. Please check back later or contact them
          directly.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 md:py-12">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight">{tenant.name as string}</h1>
        <p className="mt-2 text-muted-foreground">Get an instant estimate</p>
      </div>

      <PublicQuoteForm
        tenantId={tenant.id as string}
        businessName={tenant.name as string}
        catalog={catalogEntries}
        taxRate={(await canadianTax.getCustomerFacingContext(tenant.id as string)).totalRate}
      />
    </div>
  );
}
