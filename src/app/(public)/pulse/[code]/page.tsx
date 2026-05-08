import { notFound } from 'next/navigation';
import { formatDate } from '@/lib/date/format';
import { createAdminClient } from '@/lib/supabase/admin';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const admin = createAdminClient();
  const { data } = await admin
    .from('pulse_updates')
    .select('title, tenants:tenant_id (name)')
    .eq('public_code', code)
    .not('sent_at', 'is', null)
    .maybeSingle();

  if (!data) return { title: 'Project Update — HeyHenry' };
  const tenant = (data as Record<string, unknown>).tenants as { name?: string } | null;
  return { title: `${data.title} — ${tenant?.name ?? 'HeyHenry'}` };
}

type PulsePayload = {
  waiting_on_you?: { title: string; action_url?: string; deadline?: string }[];
};

function relativeTime(iso: string, tz: string | undefined): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(iso, { timezone: tz, style: 'long' });
}

export default async function PulsePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const admin = createAdminClient();

  const { data: row } = await admin
    .from('pulse_updates')
    .select('id, title, body_md, payload, sent_at, tenants:tenant_id (name, timezone)')
    .eq('public_code', code)
    .not('sent_at', 'is', null)
    .maybeSingle();

  if (!row) notFound();

  const tenantRaw = (row as Record<string, unknown>).tenants as
    | { name?: string; timezone?: string | null }
    | { name?: string; timezone?: string | null }[]
    | null;
  const tenant = Array.isArray(tenantRaw) ? tenantRaw[0] : tenantRaw;
  const businessName = tenant?.name ?? 'Your Contractor';
  const tenantTz = tenant?.timezone ?? undefined;
  const payload = ((row as Record<string, unknown>).payload as PulsePayload) ?? {};
  const waiting = payload.waiting_on_you ?? [];
  const sentAt = (row as Record<string, unknown>).sent_at as string;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{row.title as string}</h1>
      </header>

      <article className="rounded-xl border bg-card p-6">
        <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
          {row.body_md as string}
        </pre>

        {waiting.length > 0 ? (
          <div className="mt-6 space-y-3 border-t pt-6">
            {waiting.map((w) =>
              w.action_url ? (
                <a
                  key={`${w.title}-${w.action_url}`}
                  href={w.action_url}
                  className="inline-flex w-full items-center justify-center rounded-md bg-amber-500 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-amber-600"
                >
                  {w.title}
                </a>
              ) : null,
            )}
          </div>
        ) : null}
      </article>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Last updated: {relativeTime(sentAt, tenantTz)}
      </p>
    </div>
  );
}
