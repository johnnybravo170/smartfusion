/**
 * Project-page banner for forwarded emails staged on this project that
 * are awaiting operator confirmation.
 *
 * Server-component that queries inbound_emails for needs_review items on
 * this project. Renders nothing if there are zero. Otherwise hands off
 * to a small client wrapper for the dismiss-per-session affordance.
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
    .from('inbound_emails')
    .select('id, from_address, from_name, subject, received_at, classification', {
      count: 'exact',
    })
    .eq('tenant_id', tenant.id)
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .order('received_at', { ascending: false })
    .limit(3);

  const total = count ?? 0;
  if (total === 0) return null;

  const items = (data ?? []).map((e) => ({
    id: e.id as string,
    from: (e.from_name as string | null) ?? (e.from_address as string),
    subject: (e.subject as string | null) ?? '(no subject)',
    receivedAt: e.received_at as string,
    classification: e.classification as string,
  }));

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
        href={`/inbox/email?project=${projectId}`}
        className="text-xs underline hover:no-underline"
      >
        See all
      </Link>
    </StagedEmailsBannerClient>
  );
}
