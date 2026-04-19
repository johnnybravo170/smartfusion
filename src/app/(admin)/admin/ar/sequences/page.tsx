import { ArSequenceTable } from '@/components/features/admin/ar/sequence-table';
import { listArSequences } from '@/lib/db/queries/ar-admin';

export const dynamic = 'force-dynamic';

export default async function AdminArSequencesPage() {
  const sequences = await listArSequences();
  const active = sequences.filter((s) => s.status === 'active').length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Sequences</h1>
        <p className="text-sm text-muted-foreground">
          {sequences.length} total · {active} active.
        </p>
      </div>
      <ArSequenceTable sequences={sequences} />
    </div>
  );
}
