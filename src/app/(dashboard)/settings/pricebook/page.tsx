import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PricebookManager } from '@/components/features/settings/pricebook-manager';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listCatalogItems } from '@/lib/db/queries/catalog-items';
import { SUPPORTED_VERTICALS_WITH_SEEDS } from '@/lib/verticals/pricebook-seeds';

export const dynamic = 'force-dynamic';

export default async function PricebookPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return null;
  }

  const items = await listCatalogItems({ activeOnly: false });
  const vertical = tenant.vertical ?? null;
  const hasSeedsForVertical = vertical ? SUPPORTED_VERTICALS_WITH_SEEDS.includes(vertical) : false;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/settings">
            <ArrowLeft className="size-4" />
            Settings
          </Link>
        </Button>
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pricebook</h1>
        <p className="text-sm text-muted-foreground">
          Your services, parts, labour rates, and project-priced work — used on quotes and invoices.
        </p>
      </div>

      <PricebookManager
        items={items}
        vertical={vertical}
        hasSeedsForVertical={hasSeedsForVertical}
      />
    </div>
  );
}
