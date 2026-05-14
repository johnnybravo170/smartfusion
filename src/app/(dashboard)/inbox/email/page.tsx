import { Mail } from 'lucide-react';
import Link from 'next/link';
import {
  InboundEmailCard,
  type InboundEmailRow,
} from '@/components/features/inbox/inbound-email-card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Email Inbox — HeyHenry' };

type FilterTab = 'review' | 'applied' | 'all';

export default async function InboundEmailInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const tab = (resolved.tab as FilterTab) || 'review';
  const projectFilter = typeof resolved.project === 'string' ? resolved.project : null;

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return <p className="text-sm text-muted-foreground">Not signed in.</p>;
  }

  const supabase = await createClient();

  let query = supabase
    .from('inbound_emails')
    .select(
      'id, from_address, from_name, subject, received_at, classification, confidence, extracted, classifier_notes, project_id, project_match_confidence, status, error_message, attachments, intake_draft_id',
    )
    .eq('tenant_id', tenant.id)
    .order('received_at', { ascending: false })
    .limit(100);

  if (tab === 'review') {
    query = query.in('status', ['needs_review', 'pending', 'processing', 'error']);
  } else if (tab === 'applied') {
    query = query.in('status', ['applied', 'auto_applied']);
  }

  if (projectFilter) {
    query = query.eq('project_id', projectFilter);
  }

  const { data: emails } = await query;

  const rows: InboundEmailRow[] = (emails ?? []).map((e) => ({
    id: e.id as string,
    from_address: e.from_address as string,
    from_name: (e.from_name as string | null) ?? null,
    subject: (e.subject as string | null) ?? null,
    received_at: e.received_at as string,
    classification: e.classification as string,
    confidence: (e.confidence as number | null) ?? null,
    extracted: (e.extracted as Record<string, unknown> | null) ?? null,
    classifier_notes: (e.classifier_notes as string | null) ?? null,
    project_id: (e.project_id as string | null) ?? null,
    project_match_confidence: (e.project_match_confidence as number | null) ?? null,
    status: e.status as string,
    error_message: (e.error_message as string | null) ?? null,
    attachment_names: ((e.attachments as { filename: string }[] | null) ?? []).map(
      (a) => a.filename,
    ),
    intake_draft_id: (e.intake_draft_id as string | null) ?? null,
  }));

  const { data: projectsRaw } = await supabase
    .from('projects')
    .select('id, name')
    .eq('tenant_id', tenant.id)
    .is('deleted_at', null)
    .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active'])
    .order('name');

  const projects = (projectsRaw ?? []).map((p) => ({ id: p.id as string, name: p.name as string }));

  const inboundAddress = 'henry@inbound.heyhenry.io';

  const filteredProjectName = projectFilter
    ? (projects.find((p) => p.id === projectFilter)?.name ?? 'Unknown project')
    : null;

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'review', label: 'Needs review' },
    { key: 'applied', label: 'Applied' },
    { key: 'all', label: 'All' },
  ];

  function tabHref(t: FilterTab): string {
    const params = new URLSearchParams({ tab: t });
    if (projectFilter) params.set('project', projectFilter);
    return `/inbox/email?${params.toString()}`;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Email Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Forward bills and sub-quotes to <code className="font-mono">{inboundAddress}</code> from
          your account email — Henry parses and stages them for your confirmation. Nothing reaches
          the project until you click confirm.
        </p>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <Mail className="size-4 text-muted-foreground" />
          <code className="font-mono">{inboundAddress}</code>
        </div>
        {filteredProjectName && (
          <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30">
            <span>
              Filtered to project: <strong>{filteredProjectName}</strong>
            </span>
            <Link
              href={`/inbox/email?tab=${tab}`}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Clear filter
            </Link>
          </div>
        )}
      </header>

      {/* Tab bar */}
      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No emails in this view.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <InboundEmailCard key={row.id} email={row} projects={projects} />
          ))}
        </div>
      )}
    </div>
  );
}
