import { MessagesThread } from '@/components/features/messages/messages-thread';
import { createClient } from '@/lib/supabase/server';
import type { MessageRow } from '@/server/actions/project-messages';

export default async function MessagesTabServer({ projectId }: { projectId: string }) {
  const supabase = await createClient();

  const [{ data: messages }, { data: portalData }] = await Promise.all([
    supabase
      .from('project_messages')
      .select(
        'id, sender_kind, sender_label, channel, direction, body, created_at, read_by_operator_at, read_by_customer_at',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase
      .from('projects')
      .select('portal_slug, portal_enabled, customers:customer_id (name)')
      .eq('id', projectId)
      .single(),
  ]);

  const initialMessages = (messages ?? []) as MessageRow[];
  const portalEnabled = Boolean(portalData?.portal_enabled);
  const portalSlug = (portalData?.portal_slug as string | null) ?? null;
  const customerRaw = portalData?.customers as
    | { name?: string }
    | { name?: string }[]
    | null
    | undefined;
  const customer = Array.isArray(customerRaw) ? (customerRaw[0] ?? null) : (customerRaw ?? null);
  const customerName = customer?.name ?? 'Customer';

  return (
    <div className="space-y-4">
      {!portalEnabled ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The customer portal is disabled. Messages still send notifications, but the customer can't
          read them on the portal until you enable it on the Portal tab.
        </div>
      ) : null}
      <MessagesThread
        projectId={projectId}
        initialMessages={initialMessages}
        customerName={customerName}
        portalSlug={portalSlug}
      />
    </div>
  );
}
