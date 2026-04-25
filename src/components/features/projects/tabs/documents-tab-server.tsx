import { DocumentList } from '@/components/features/portal/document-list';
import { DocumentUpload } from '@/components/features/portal/document-upload';
import { HomeRecordButton } from '@/components/features/portal/home-record-button';
import { getHomeRecordForProject } from '@/lib/db/queries/home-records';
import { listDocumentsForProject } from '@/lib/db/queries/project-documents';

export default async function DocumentsTabServer({ projectId }: { projectId: string }) {
  const [documents, homeRecord] = await Promise.all([
    listDocumentsForProject(projectId),
    getHomeRecordForProject(projectId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">Documents & warranties</h2>
        <p className="text-sm text-muted-foreground">
          Per-project file store — contracts, permits, warranties, manuals, inspections. Visible to
          the homeowner unless you hide them, and rolled into the final Home Record.
        </p>
      </div>

      <div className="rounded-lg border border-dashed bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Home Record</h3>
            <p className="text-xs text-muted-foreground">
              The permanent handoff package — phases, photos, selections, decisions, COs, warranties
              — frozen and shareable. Regenerate anytime; the link stays the same.
            </p>
            {homeRecord ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Last generated{' '}
                {new Date(homeRecord.generated_at).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            ) : null}
          </div>
          <HomeRecordButton
            projectId={projectId}
            existingSlug={homeRecord?.slug ?? null}
            hasPdf={Boolean(homeRecord?.pdf_path)}
          />
        </div>
      </div>

      <DocumentUpload projectId={projectId} />
      <DocumentList documents={documents} projectId={projectId} />
    </div>
  );
}
