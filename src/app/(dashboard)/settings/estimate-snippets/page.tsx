import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EstimateSnippetsManager } from '@/components/features/settings/estimate-snippets-manager';
import { listEstimateSnippets } from '@/lib/db/queries/estimate-snippets';

export const metadata = { title: 'Estimate Snippets — HeyHenry' };

export default async function EstimateSnippetsPage() {
  const snippets = await listEstimateSnippets();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Estimate Snippets</h1>
        <p className="text-sm text-muted-foreground">
          Reusable paragraphs that show up as one-click chips on the estimate editor — exclusions,
          change rates, acceptance terms, whatever you keep retyping. Snippets marked as default
          auto-insert when you start a new project.
        </p>
      </header>

      <EstimateSnippetsManager snippets={snippets} />
    </div>
  );
}
