import { ArTemplateTable } from '@/components/features/admin/ar/template-table';
import { listArTemplates } from '@/lib/db/queries/ar-admin';

export const dynamic = 'force-dynamic';

export default async function AdminArTemplatesPage() {
  const templates = await listArTemplates();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Templates</h1>
        <p className="text-sm text-muted-foreground">
          {templates.length} {templates.length === 1 ? 'template' : 'templates'}.
        </p>
      </div>
      <ArTemplateTable templates={templates} />
    </div>
  );
}
