/**
 * Project-page banner for intake drafts staged on this project that are
 * awaiting operator confirmation.
 *
 * V2: query intake_drafts joined to inbound_emails (when source='email')
 * for envelope-level from/subject. Legacy V1 inbound_emails rows have
 * NULL intake_draft_id and don't surface here — they were already
 * actioned through the V1 surface.
 */

import { Mail } from 'lucide-react';
import Link from 'next/link';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { StagedEmailsBannerClient } from './staged-emails-banner.client';

export async function StagedEmailsBanner({ projectId }: { projectId: string }) {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data, count } = await supabase
    .from('intake_drafts')
    .select(
      'id, created_at, source, inbound_emails!intake_draft_id ( id, from_address, from_name, subject )',
      { count: 'exact' },
    )
    .eq('tenant_id', tenant.id)
    .eq('disposition', 'pending_review')
    .eq('accepted_project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(3);

  const total = count ?? 0;
  if (total === 0) return null;

  type EnvelopeRow = {
    id: string;
    from_address: string | null;
    from_name: string | null;
    subject: string | null;
  } | null;

  const items = (data ?? []).map((row) => {
    const envRaw = (row.inbound_emails as EnvelopeRow | EnvelopeRow[]) ?? null;
    const env = Array.isArray(envRaw) ? (envRaw[0] ?? null) : envRaw;
    return {
      id: (env?.id as string | undefined) ?? (row.id as string),
      from: env?.from_name ?? env?.from_address ?? '(intake draft)',
      subject: env?.subject ?? '(no subject)',
      receivedAt: row.created_at as string,
      classification: (row.source as string) ?? 'email',
    };
  });

  // Cache key — dismiss state expires the moment a newer forward arrives.
  const dismissKey = `staged-emails-banner:${projectId}:${items[0]?.receivedAt ?? ''}`;

  return (
    <StagedEmailsBannerClient
      projectId={projectId}
      total={total}
      items={items}
      dismissKey={dismissKey}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <Mail className="size-4" />
        {total === 1
          ? '1 forwarded item waiting on you'
          : `${total} forwarded items waiting on you`}
      </span>
      <Link
        href={`/inbox/intake?source=email&project=${projectId}`}
        className="text-xs underline hover:no-underline"
      >
        See all
      </Link>
    </StagedEmailsBannerClient>
  );
}
