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
import type { ArTemplateRow } from '@/lib/db/queries/ar-admin';

export function ArTemplateTable({ templates }: { templates: ArTemplateRow[] }) {
  if (templates.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-muted-foreground">
        No templates yet. Create one via <code>ar_upsert_template</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Subject / Preview</TableHead>
            <TableHead className="text-right">Used in steps</TableHead>
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.name}</TableCell>
              <TableCell>
                <Badge variant="secondary">{t.channel}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground max-w-md truncate text-sm">
                {t.subject ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">{t.usageCount}</TableCell>
              <TableCell>
                <Link
                  href={`/admin/ar/templates/${t.id}`}
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
