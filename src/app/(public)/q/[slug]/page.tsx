import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicQuoteForm } from '@/components/features/lead-gen/public-quote-form';
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

  // Load active catalog entries for this tenant.
  const { data: catalog } = await admin
    .from('service_catalog')
    .select(
      'id, tenant_id, surface_type, label, price_per_sqft_cents, min_charge_cents, is_active, created_at, updated_at',
    )
    .eq('tenant_id', tenant.id)
    .eq('is_active', true)
    .order('label', { ascending: true });

  const catalogEntries = (catalog ?? []) as Array<{
    id: string;
    tenant_id: string;
    surface_type: string;
    label: string;
    price_per_sqft_cents: number;
    min_charge_cents: number;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>;

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
      />
    </div>
  );
}
