import { DocumentList } from '@/components/features/portal/document-list';
import { DocumentUpload } from '@/components/features/portal/document-upload';
import { listDocumentsForProject } from '@/lib/db/queries/project-documents';

export default async function DocumentsTabServer({ projectId }: { projectId: string }) {
  const documents = await listDocumentsForProject(projectId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">Documents & warranties</h2>
        <p className="text-sm text-muted-foreground">
          Per-project file store — contracts, permits, warranties, manuals, inspections. Visible to
          the homeowner unless you hide them, and rolled into the final Home Record.
        </p>
      </div>
      <DocumentUpload projectId={projectId} />
      <DocumentList documents={documents} projectId={projectId} />
    </div>
  );
}
