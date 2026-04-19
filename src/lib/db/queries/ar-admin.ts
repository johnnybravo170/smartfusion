/**
 * Autoresponder admin queries (platform scope: tenant_id IS NULL).
 *
 * Mirrors the pattern in `admin.ts`: service-role Supabase client, no RLS.
 * Only consumed by server components under `/admin/ar/*`.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type ArContactRow = {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  emailSubscribed: boolean;
  smsSubscribed: boolean;
  unsubscribedAt: string | null;
  createdAt: string;
  tags: string[];
};

export type ArSequenceRow = {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  version: number;
  triggerType: string;
  stepCount: number;
  activeEnrollments: number;
  createdAt: string;
  updatedAt: string;
};

export type ArSequenceDetail = ArSequenceRow & {
  allowReenrollment: boolean;
  emailQuietStart: number | null;
  emailQuietEnd: number | null;
  smsQuietStart: number | null;
  smsQuietEnd: number | null;
  steps: Array<{
    id: string;
    position: number;
    type: string;
    delayMinutes: number;
    templateId: string | null;
    templateName: string | null;
    config: Record<string, unknown>;
  }>;
  recentSends: Array<{
    id: string;
    toAddress: string;
    status: string;
    subject: string | null;
    createdAt: string;
  }>;
};

export type ArTemplateRow = {
  id: string;
  name: string;
  channel: 'email' | 'sms';
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  updatedAt: string;
  usageCount: number;
};

export type ArTemplateDetail = ArTemplateRow & {
  bodyHtml: string | null;
  bodyText: string | null;
  replyTo: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function listArContacts(limit = 100): Promise<ArContactRow[]> {
  const admin = createAdminClient();
  const { data: contacts, error } = await admin
    .from('ar_contacts')
    .select(
      'id, email, phone, first_name, last_name, email_subscribed, sms_subscribed, unsubscribed_at, created_at',
    )
    .is('tenant_id', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listArContacts: ${error.message}`);
  if (!contacts || contacts.length === 0) return [];

  const { data: tagRows } = await admin
    .from('ar_contact_tags')
    .select('contact_id, tag')
    .in(
      'contact_id',
      contacts.map((c) => c.id as string),
    );

  const tagsByContact = new Map<string, string[]>();
  for (const t of tagRows ?? []) {
    const arr = tagsByContact.get(t.contact_id as string) ?? [];
    arr.push(t.tag as string);
    tagsByContact.set(t.contact_id as string, arr);
  }

  return contacts.map((c) => ({
    id: c.id as string,
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    firstName: (c.first_name as string | null) ?? null,
    lastName: (c.last_name as string | null) ?? null,
    emailSubscribed: Boolean(c.email_subscribed),
    smsSubscribed: Boolean(c.sms_subscribed),
    unsubscribedAt: (c.unsubscribed_at as string | null) ?? null,
    createdAt: c.created_at as string,
    tags: tagsByContact.get(c.id as string) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

export async function listArSequences(): Promise<ArSequenceRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ar_sequences')
    .select('*')
    .is('tenant_id', null)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`listArSequences: ${error.message}`);
  if (!data || data.length === 0) return [];

  const ids = data.map((s) => s.id as string);

  const [{ data: stepCounts }, { data: enrollCounts }] = await Promise.all([
    admin.from('ar_steps').select('sequence_id, version').in('sequence_id', ids),
    admin
      .from('ar_enrollments')
      .select('sequence_id, status')
      .in('sequence_id', ids)
      .eq('status', 'active'),
  ]);

  const stepCountMap = new Map<string, number>();
  for (const s of data) {
    const count =
      stepCounts?.filter((r) => r.sequence_id === s.id && r.version === s.version).length ?? 0;
    stepCountMap.set(s.id as string, count);
  }

  const enrollMap = new Map<string, number>();
  for (const e of enrollCounts ?? []) {
    enrollMap.set(e.sequence_id as string, (enrollMap.get(e.sequence_id as string) ?? 0) + 1);
  }

  return data.map((s) => ({
    id: s.id as string,
    name: s.name as string,
    description: (s.description as string | null) ?? null,
    status: s.status as ArSequenceRow['status'],
    version: s.version as number,
    triggerType: s.trigger_type as string,
    stepCount: stepCountMap.get(s.id as string) ?? 0,
    activeEnrollments: enrollMap.get(s.id as string) ?? 0,
    createdAt: s.created_at as string,
    updatedAt: s.updated_at as string,
  }));
}

export async function getArSequence(id: string): Promise<ArSequenceDetail | null> {
  const admin = createAdminClient();
  const { data: seq, error } = await admin
    .from('ar_sequences')
    .select('*')
    .eq('id', id)
    .is('tenant_id', null)
    .maybeSingle();
  if (error) throw new Error(`getArSequence: ${error.message}`);
  if (!seq) return null;

  const [{ data: steps }, { data: sends }, { data: enrollments }] = await Promise.all([
    admin
      .from('ar_steps')
      .select('id, position, type, delay_minutes, template_id, config')
      .eq('sequence_id', id)
      .eq('version', seq.version)
      .order('position', { ascending: true }),
    admin
      .from('ar_send_log')
      .select('id, to_address, status, subject, created_at, step_id')
      .in(
        'step_id',
        // placeholder: will re-filter below once we know step ids
        [] as string[],
      ),
    admin
      .from('ar_enrollments')
      .select('sequence_id, status')
      .eq('sequence_id', id)
      .eq('status', 'active'),
  ]);

  const stepIds = (steps ?? []).map((s) => s.id as string);
  const templateIds = (steps ?? [])
    .map((s) => s.template_id as string | null)
    .filter((v): v is string => Boolean(v));

  const [{ data: templateRows }, { data: recentSends }] = await Promise.all([
    templateIds.length > 0
      ? admin.from('ar_templates').select('id, name').in('id', templateIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    stepIds.length > 0
      ? admin
          .from('ar_send_log')
          .select('id, to_address, status, subject, created_at')
          .in('step_id', stepIds)
          .order('created_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
  ]);

  const tplName = new Map<string, string>();
  for (const t of templateRows ?? []) tplName.set(t.id as string, t.name as string);

  // sends is an unused placeholder from the parallel fetch; ignore it.
  void sends;

  return {
    id: seq.id as string,
    name: seq.name as string,
    description: (seq.description as string | null) ?? null,
    status: seq.status as ArSequenceRow['status'],
    version: seq.version as number,
    triggerType: seq.trigger_type as string,
    stepCount: steps?.length ?? 0,
    activeEnrollments: enrollments?.length ?? 0,
    createdAt: seq.created_at as string,
    updatedAt: seq.updated_at as string,
    allowReenrollment: Boolean(seq.allow_reenrollment),
    emailQuietStart: (seq.email_quiet_start as number | null) ?? null,
    emailQuietEnd: (seq.email_quiet_end as number | null) ?? null,
    smsQuietStart: (seq.sms_quiet_start as number | null) ?? null,
    smsQuietEnd: (seq.sms_quiet_end as number | null) ?? null,
    steps: (steps ?? []).map((s) => ({
      id: s.id as string,
      position: s.position as number,
      type: s.type as string,
      delayMinutes: s.delay_minutes as number,
      templateId: (s.template_id as string | null) ?? null,
      templateName: s.template_id ? (tplName.get(s.template_id as string) ?? null) : null,
      config: (s.config as Record<string, unknown>) ?? {},
    })),
    recentSends: (recentSends ?? []).map((r) => ({
      id: r.id as string,
      toAddress: r.to_address as string,
      status: r.status as string,
      subject: (r.subject as string | null) ?? null,
      createdAt: r.created_at as string,
    })),
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listArTemplates(): Promise<ArTemplateRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ar_templates')
    .select('id, name, channel, subject, from_name, from_email, updated_at')
    .is('tenant_id', null)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`listArTemplates: ${error.message}`);
  if (!data || data.length === 0) return [];

  const { data: stepRows } = await admin
    .from('ar_steps')
    .select('template_id')
    .in(
      'template_id',
      data.map((t) => t.id as string),
    );

  const usage = new Map<string, number>();
  for (const s of stepRows ?? []) {
    if (!s.template_id) continue;
    usage.set(s.template_id as string, (usage.get(s.template_id as string) ?? 0) + 1);
  }

  return data.map((t) => ({
    id: t.id as string,
    name: t.name as string,
    channel: t.channel as 'email' | 'sms',
    subject: (t.subject as string | null) ?? null,
    fromName: (t.from_name as string | null) ?? null,
    fromEmail: (t.from_email as string | null) ?? null,
    updatedAt: t.updated_at as string,
    usageCount: usage.get(t.id as string) ?? 0,
  }));
}

export async function getArTemplate(id: string): Promise<ArTemplateDetail | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ar_templates')
    .select('*')
    .eq('id', id)
    .is('tenant_id', null)
    .maybeSingle();
  if (error) throw new Error(`getArTemplate: ${error.message}`);
  if (!data) return null;

  const { data: stepRows } = await admin.from('ar_steps').select('id').eq('template_id', id);

  return {
    id: data.id as string,
    name: data.name as string,
    channel: data.channel as 'email' | 'sms',
    subject: (data.subject as string | null) ?? null,
    fromName: (data.from_name as string | null) ?? null,
    fromEmail: (data.from_email as string | null) ?? null,
    replyTo: (data.reply_to as string | null) ?? null,
    bodyHtml: (data.body_html as string | null) ?? null,
    bodyText: (data.body_text as string | null) ?? null,
    updatedAt: data.updated_at as string,
    createdAt: data.created_at as string,
    usageCount: stepRows?.length ?? 0,
  };
}
