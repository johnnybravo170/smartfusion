import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ArSequenceRow } from '@/lib/db/queries/ar-admin';

const statusVariant: Record<ArSequenceRow['status'], 'default' | 'secondary'> = {
  active: 'default',
  draft: 'secondary',
  paused: 'secondary',
  archived: 'secondary',
};

export function ArSequenceTable({ sequences }: { sequences: ArSequenceRow[] }) {
  if (sequences.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-muted-foreground">
        No sequences yet. Create one via <code>ar_create_sequence</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead className="text-right">Steps</TableHead>
            <TableHead className="text-right">Active enrollments</TableHead>
            <TableHead>Version</TableHead>
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sequences.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">
                <div>{s.name}</div>
                {s.description ? (
                  <div className="text-muted-foreground text-xs">{s.description}</div>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant[s.status]}>{s.status}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{s.triggerType}</TableCell>
              <TableCell className="text-right tabular-nums">{s.stepCount}</TableCell>
              <TableCell className="text-right tabular-nums">{s.activeEnrollments}</TableCell>
              <TableCell className="text-muted-foreground text-sm">v{s.version}</TableCell>
              <TableCell>
                <Link
                  href={`/admin/ar/sequences/${s.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
