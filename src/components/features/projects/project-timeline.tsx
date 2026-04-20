import type { ProjectEventRow } from '@/lib/db/queries/project-events';

const KIND_LABELS: Record<string, string> = {
  estimate_sent: 'Estimate sent',
  estimate_viewed: 'Customer viewed estimate',
  estimate_approved: 'Estimate approved',
  estimate_declined: 'Estimate declined',
  estimate_reset: 'Estimate reset to draft',
  invoice_created: 'Invoice created',
  invoice_sent: 'Invoice sent',
  invoice_paid: 'Invoice paid',
};

function describe(ev: ProjectEventRow): string {
  const base = KIND_LABELS[ev.kind] ?? ev.kind;
  const meta = ev.meta ?? {};
  if (ev.kind === 'estimate_approved' && meta.approved_by) return `${base} by ${meta.approved_by}`;
  if (ev.kind === 'estimate_declined' && meta.reason) return `${base} — ${meta.reason}`;
  if (ev.kind === 'estimate_sent' && meta.to) return `${base} to ${meta.to}`;
  return base;
}

export function ProjectTimeline({ events }: { events: ProjectEventRow[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">Timeline</h3>
      <ol className="space-y-2">
        {events.map((ev) => (
          <li key={ev.id} className="flex items-start gap-3 text-sm">
            <span className="mt-1.5 inline-block size-2 flex-shrink-0 rounded-full bg-muted-foreground/40" />
            <div className="flex-1">
              <p>{describe(ev)}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(ev.occurred_at).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
