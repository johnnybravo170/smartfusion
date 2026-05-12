import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { QboClassMapping } from '@/components/features/settings/qbo-class-mapping';
import { Button } from '@/components/ui/button';
import { listClassMappingsAction } from '@/server/actions/qbo-class-mapping';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'QuickBooks Class mapping — HeyHenry',
};

export default async function QboClassMappingPage() {
  const result = await listClassMappingsAction();
  const classes = result.ok ? result.classes : [];
  const projects = result.ok ? result.projects : [];

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
        <h1 className="text-2xl font-semibold tracking-tight">Map QBO Classes to projects</h1>
        <p className="text-sm text-muted-foreground">
          QuickBooks Class is the standard job-costing tag. Pick which HeyHenry project each one
          maps to — bills and expenses get tagged in bulk so spend rolls up under the right project.
        </p>
      </div>

      <QboClassMapping classes={classes} projects={projects} />
    </div>
  );
}
