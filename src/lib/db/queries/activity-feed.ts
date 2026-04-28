/**
 * Unified Recent Activity feed for the dashboard.
 *
 * Reads from 5 source tables and merges at query time — no triggers,
 * no separate audit table. Each row carries `edit_href` so the UI can
 * link directly to the per-item edit surface.
 *
 * Collapse rule: 3+ events of the same kind on the same project on the
 * same day collapse into a single grouped row that links to the
 * project's filtered list. Below the threshold rows stay individual
 * with their per-item link.
 *
 * Sources (last 14 days, capped at 20 rows after collapse):
 *   - expenses               → /expenses/<id>/edit
 *   - photos                 → /projects/<id>?tab=gallery
 *   - project_documents      → /projects/<id>?tab=documents
 *   - invoices (status flip) → /invoices/<id>
 *   - worklog_entries        → existing per-related-type routing
 */

import { createClient } from '@/lib/supabase/server';

export type ActivityEventKind =
  | 'expense_created'
  | 'photo_uploaded'
  | 'document_uploaded'
  | 'invoice_created'
  | 'invoice_sent'
  | 'invoice_paid'
  | 'worklog';

export type ActivityEvent = {
  id: string;
  kind: ActivityEventKind;
  title: string;
  created_at: string;
  project_id: string | null;
  project_name: string | null;
  edit_href: string;
  // Collapsed-group fields:
  is_group?: boolean;
  group_count?: number;
};

const WINDOW_DAYS = 14;
const FEED_CAP = 20;
const COLLAPSE_THRESHOLD = 3;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dateKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

export async function getRecentActivityFeed(): Promise<ActivityEvent[]> {
  const supabase = await createClient();
  const since = daysAgoIso(WINDOW_DAYS);

  const [expRes, photoRes, docRes, invRes, worklogRes] = await Promise.all([
    supabase
      .from('expenses')
      .select('id, project_id, vendor, description, created_at, receipt_storage_path')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('photos')
      .select('id, project_id, caption, ai_caption, created_at')
      .is('deleted_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('project_documents')
      .select('id, project_id, title, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('invoices')
      .select('id, project_id, status, amount_cents, customer_note, created_at, sent_at, paid_at')
      .is('deleted_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('worklog_entries')
      .select('id, entry_type, title, created_at, related_type, related_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(40),
  ]);

  const events: ActivityEvent[] = [];

  for (const e of (expRes.data ?? []) as Array<{
    id: string;
    project_id: string | null;
    vendor: string | null;
    description: string | null;
    created_at: string;
    receipt_storage_path: string | null;
  }>) {
    const verb = e.receipt_storage_path ? 'Receipt added' : 'Expense added';
    const tail = e.vendor ?? e.description ?? 'expense';
    events.push({
      id: `exp:${e.id}`,
      kind: 'expense_created',
      title: `${verb}: ${tail}`,
      created_at: e.created_at,
      project_id: e.project_id,
      project_name: null,
      edit_href: `/expenses/${e.id}/edit`,
    });
  }

  for (const p of (photoRes.data ?? []) as Array<{
    id: string;
    project_id: string | null;
    caption: string | null;
    ai_caption: string | null;
    created_at: string;
  }>) {
    const cap = p.caption ?? p.ai_caption ?? 'photo';
    events.push({
      id: `photo:${p.id}`,
      kind: 'photo_uploaded',
      title: `Photo uploaded: ${cap}`,
      created_at: p.created_at,
      project_id: p.project_id,
      project_name: null,
      edit_href: p.project_id ? `/projects/${p.project_id}?tab=gallery` : '/photos',
    });
  }

  for (const d of (docRes.data ?? []) as Array<{
    id: string;
    project_id: string | null;
    title: string | null;
    created_at: string;
  }>) {
    events.push({
      id: `doc:${d.id}`,
      kind: 'document_uploaded',
      title: `Document uploaded: ${d.title ?? 'untitled'}`,
      created_at: d.created_at,
      project_id: d.project_id,
      project_name: null,
      edit_href: d.project_id ? `/projects/${d.project_id}?tab=documents` : '/projects',
    });
  }

  for (const inv of (invRes.data ?? []) as Array<{
    id: string;
    project_id: string | null;
    status: string;
    amount_cents: number;
    customer_note: string | null;
    created_at: string;
    sent_at: string | null;
    paid_at: string | null;
  }>) {
    // Pick the most recent action for this invoice within the window.
    // paid_at trumps sent_at trumps created_at.
    let kind: ActivityEventKind = 'invoice_created';
    let actedAt = inv.created_at;
    let verb = 'Invoice created';
    if (inv.paid_at && inv.paid_at >= since) {
      kind = 'invoice_paid';
      actedAt = inv.paid_at;
      verb = 'Invoice paid';
    } else if (inv.sent_at && inv.sent_at >= since) {
      kind = 'invoice_sent';
      actedAt = inv.sent_at;
      verb = 'Invoice sent';
    }
    const dollars = `$${(inv.amount_cents / 100).toFixed(2)}`;
    events.push({
      id: `inv:${inv.id}:${kind}`,
      kind,
      title: `${verb} ${dollars}`,
      created_at: actedAt,
      project_id: inv.project_id,
      project_name: null,
      edit_href: `/invoices/${inv.id}`,
    });
  }

  for (const w of (worklogRes.data ?? []) as Array<{
    id: string;
    entry_type: string;
    title: string | null;
    created_at: string;
    related_type: string | null;
    related_id: string | null;
  }>) {
    const href = relatedHrefForWorklog(w.related_type, w.related_id);
    events.push({
      id: `wl:${w.id}`,
      kind: 'worklog',
      title: w.title ?? `${w.entry_type} entry`,
      created_at: w.created_at,
      project_id: w.related_type === 'project' ? w.related_id : null,
      project_name: null,
      edit_href: href ?? '/inbox',
    });
  }

  // Sort newest first.
  events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  // Collapse: same kind, same project, same calendar day, threshold+ events.
  const collapsed = collapseGroups(events);

  // Hydrate project names in one round-trip.
  const projectIds = new Set<string>();
  for (const e of collapsed) if (e.project_id) projectIds.add(e.project_id);
  if (projectIds.size > 0) {
    const { data: projRows } = await supabase
      .from('projects')
      .select('id, name')
      .in('id', Array.from(projectIds));
    const nameById = new Map<string, string>();
    for (const r of (projRows ?? []) as Array<{ id: string; name: string }>) {
      nameById.set(r.id, r.name);
    }
    for (const e of collapsed) {
      if (e.project_id) e.project_name = nameById.get(e.project_id) ?? null;
    }
  }

  return collapsed.slice(0, FEED_CAP);
}

function collapseGroups(events: ActivityEvent[]): ActivityEvent[] {
  // Group key: kind|project_id|YYYY-MM-DD
  const groups = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const key = `${e.kind}|${e.project_id ?? 'none'}|${dateKey(e.created_at)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(e);
  }

  const out: ActivityEvent[] = [];
  for (const e of events) {
    const key = `${e.kind}|${e.project_id ?? 'none'}|${dateKey(e.created_at)}`;
    const group = groups.get(key);
    if (!group) continue;
    if (group.length >= COLLAPSE_THRESHOLD) {
      // Emit the group once at the position of the first event.
      if (group[0]?.id === e.id) {
        out.push({
          id: `group:${key}`,
          kind: e.kind,
          title: groupTitle(e.kind, group.length),
          created_at: e.created_at, // most recent (events sorted desc, first is newest)
          project_id: e.project_id,
          project_name: null,
          edit_href: groupHref(e.kind, e.project_id),
          is_group: true,
          group_count: group.length,
        });
      }
      // Skip individual rows inside collapsed groups.
    } else {
      out.push(e);
    }
  }
  return out;
}

function groupTitle(kind: ActivityEventKind, count: number): string {
  switch (kind) {
    case 'expense_created':
      return `${count} expenses added`;
    case 'photo_uploaded':
      return `${count} photos uploaded`;
    case 'document_uploaded':
      return `${count} documents uploaded`;
    case 'invoice_paid':
      return `${count} invoices paid`;
    case 'invoice_sent':
      return `${count} invoices sent`;
    case 'invoice_created':
      return `${count} invoices created`;
    default:
      return `${count} entries`;
  }
}

function groupHref(kind: ActivityEventKind, projectId: string | null): string {
  if (!projectId) return '/dashboard';
  switch (kind) {
    case 'expense_created':
      return `/projects/${projectId}?tab=costs`;
    case 'photo_uploaded':
      return `/projects/${projectId}?tab=gallery`;
    case 'document_uploaded':
      return `/projects/${projectId}?tab=documents`;
    case 'invoice_paid':
    case 'invoice_sent':
    case 'invoice_created':
      return `/projects/${projectId}?tab=invoices`;
    default:
      return `/projects/${projectId}`;
  }
}

function relatedHrefForWorklog(
  relatedType: string | null,
  relatedId: string | null,
): string | null {
  if (!relatedType || !relatedId) return null;
  switch (relatedType) {
    case 'customer':
      return `/contacts/${relatedId}`;
    case 'project':
      return `/projects/${relatedId}`;
    case 'quote':
      return `/quotes/${relatedId}`;
    case 'job':
      return `/jobs/${relatedId}`;
    case 'invoice':
      return `/invoices/${relatedId}`;
    default:
      return null;
  }
}
