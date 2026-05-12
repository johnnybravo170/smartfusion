import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { QboImportHistory } from '@/components/features/settings/qbo-import-history';
import { Button } from '@/components/ui/button';
import { listImportHistoryAction } from '@/server/actions/qbo-import-rollback';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'QuickBooks import history — HeyHenry',
};

export default async function QboImportHistoryPage() {
  const result = await listImportHistoryAction();
  const jobs = result.ok ? result.jobs : [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/settings">
            <ArrowLeft className="size-4" />
            Settings
          </Link>
        </Button>
      </div>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">QuickBooks import history</h1>
        <p className="text-sm text-muted-foreground">
          Every import run lands here with its entity counts. Roll back a job to undo every record
          it inserted — useful for redoing an import after fixing source data.
        </p>
      </div>

      <QboImportHistory jobs={jobs} />
    </div>
  );
}
