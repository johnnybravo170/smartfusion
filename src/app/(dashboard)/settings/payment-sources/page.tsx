import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PaymentSourcesManager } from '@/components/features/settings/payment-sources-manager';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listPaymentSources } from '@/lib/db/queries/payment-sources';

export const metadata = {
  title: 'Payment sources — HeyHenry',
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function resolveBack(from: string | string[] | undefined): { href: string; label: string } {
  const key = typeof from === 'string' ? from : null;
  switch (key) {
    case 'expenses':
      return { href: '/expenses', label: 'Expenses' };
    default:
      return { href: '/settings', label: 'Settings' };
  }
}

export default async function PaymentSourcesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/settings/payment-sources');

  const resolved = await searchParams;
  const back = resolveBack(resolved.from);

  const sources = await listPaymentSources();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link
        href={back.href}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {back.label}
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Payment sources</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The cards and accounts you pay with. Henry auto-tags receipts by the last 4 of the card.
          The default source is used when no card is detected on the receipt.
        </p>
      </header>

      <PaymentSourcesManager sources={sources} />
    </div>
  );
}
