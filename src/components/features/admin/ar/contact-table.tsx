import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ArContactRow } from '@/lib/db/queries/ar-admin';

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function ArContactTable({ contacts }: { contacts: ArContactRow[] }) {
  if (contacts.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-muted-foreground">
        No contacts yet. Create one via the MCP tool <code>ar_upsert_contact</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Added</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contacts.map((c) => {
            const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
            return (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{c.email ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{c.phone ?? '—'}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {c.tags.length === 0 ? (
                      <span className="text-muted-foreground text-xs">—</span>
                    ) : (
                      c.tags.map((t) => (
                        <Badge key={t} variant="secondary" className="text-xs">
                          {t}
                        </Badge>
                      ))
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {c.unsubscribedAt ? (
                    <Badge variant="secondary">Unsubscribed</Badge>
                  ) : !c.emailSubscribed ? (
                    <Badge variant="secondary">Email off</Badge>
                  ) : (
                    <Badge variant="default">Subscribed</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm">{formatRelative(c.createdAt)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
