import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SequenceStatusActions } from '@/components/features/admin/ar/sequence-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getArSequence } from '@/lib/db/queries/ar-admin';

export const dynamic = 'force-dynamic';

function formatHourRange(start: number | null, end: number | null): string {
  if (start === null || end === null) return 'default';
  const p = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return `${p(start)}–${p(end)} quiet`;
}

function formatDelay(minutes: number): string {
  if (minutes === 0) return 'immediately';
  if (minutes < 60) return `+${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem === 0 ? `+${hours}h` : `+${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `+${days}d` : `+${days}d ${remHours}h`;
}

export default async function AdminArSequenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sequence = await getArSequence(id);
  if (!sequence) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/admin/ar/sequences"
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            ← All sequences
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">{sequence.name}</h1>
          {sequence.description ? (
            <p className="text-sm text-muted-foreground">{sequence.description}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={sequence.status === 'active' ? 'default' : 'secondary'}>
              {sequence.status}
            </Badge>
            <span className="text-muted-foreground text-xs">v{sequence.version}</span>
            <span className="text-muted-foreground text-xs">· trigger: {sequence.triggerType}</span>
            <span className="text-muted-foreground text-xs">
              · {sequence.activeEnrollments} active enrollment(s)
            </span>
          </div>
        </div>
        <SequenceStatusActions sequenceId={sequence.id} status={sequence.status} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Email send window</CardDescription>
            <CardTitle className="text-base font-medium">
              {formatHourRange(sequence.emailQuietStart, sequence.emailQuietEnd)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>SMS send window</CardDescription>
            <CardTitle className="text-base font-medium">
              {formatHourRange(sequence.smsQuietStart, sequence.smsQuietEnd)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Steps</CardTitle>
          <CardDescription>
            {sequence.steps.length} step(s) at version {sequence.version}. Edit via the MCP tool{' '}
            <code>ar_set_sequence_steps</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sequence.steps.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No steps yet. Use <code>ar_set_sequence_steps</code> to add them.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Delay</TableHead>
                    <TableHead>Template</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sequence.steps.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="tabular-nums">{s.position}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{s.type}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDelay(s.delayMinutes)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {s.templateId ? (
                          <Link
                            href={`/admin/ar/templates/${s.templateId}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {s.templateName ?? s.templateId}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {sequence.recentSends.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent sends</CardTitle>
            <CardDescription>Last 20 messages from this sequence.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sequence.recentSends.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Intl.DateTimeFormat('en-CA', {
                          // Platform-admin surface — system AR sequences have
                          // no per-tenant tz. Render in HQ-local (Vancouver)
                          // to avoid implicit-UTC drift on Vercel.
                          timeZone: 'America/Vancouver',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        }).format(new Date(r.createdAt))}
                      </TableCell>
                      <TableCell className="text-sm">{r.toAddress}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {r.subject ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.status === 'sent' || r.status === 'delivered'
                              ? 'default'
                              : 'secondary'
                          }
                        >
                          {r.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
