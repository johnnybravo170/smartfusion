'use client';

import { Download, FileArchive, Loader2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { formatDate } from '@/lib/date/format';
import { requestExportAction } from '@/server/actions/export';

type Props = {
  lastExportUrl: string | null;
  lastExportDate: string | null;
};

export function DataExportCard({ lastExportUrl, lastExportDate }: Props) {
  const timezone = useTenantTimezone();
  const [isPending, startTransition] = useTransition();

  function handleExport() {
    startTransition(async () => {
      const result = await requestExportAction();
      if (result.ok) {
        toast.success('Export ready! Starting download.');
        window.open(result.downloadUrl, '_blank');
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileArchive className="size-5" />
          <div>
            <CardTitle>Data Export</CardTitle>
            <CardDescription>
              Download all your data as a ZIP file (PIPEDA compliance).
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button onClick={handleExport} disabled={isPending} data-testid="export-data-btn">
          {isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Download className="mr-2 size-4" />
          )}
          {isPending ? 'Generating export...' : 'Export all my data'}
        </Button>
        {lastExportUrl && lastExportDate && (
          <p className="text-sm text-muted-foreground">
            Last export:{' '}
            <a
              href={lastExportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              data-testid="last-export-link"
            >
              {formatDate(lastExportDate, { timezone })}
            </a>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
