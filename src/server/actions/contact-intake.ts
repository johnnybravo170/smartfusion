'use server';

/**
 * Universal contact intake for non-customer kinds (vendor, sub, agent,
 * inspector, referral, other).
 *
 * `parseInboundContactAction` runs vision + text over the dropped artifact(s)
 * and returns a ParsedContact (contact fields only, no estimate).
 *
 * `acceptInboundContactAction` takes the edited draft, creates a contact
 * row with the given kind, and seeds the first `contact_notes` entry with
 * the notes extracted from the artifact.
 *
 * Kind=customer does NOT flow through here — that path stays on the lead
 * intake pipeline (intake.ts) which also generates an estimate draft.
 */

import { revalidatePath } from 'next/cache';
import {
  CONTACT_INTAKE_JSON_SCHEMA,
  CONTACT_INTAKE_SYSTEM_PROMPT,
  type ParsedContact,
} from '@/lib/ai/contact-intake-prompt';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { type ContactMatch, findContactMatches } from '@/lib/db/queries/contact-matches';
import { createClient } from '@/lib/supabase/server';
import type { ContactKind } from '@/lib/validators/customer';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 8;
const PARSE_MODEL = 'gpt-4o-mini';

/** Non-customer kinds only — customer kind uses the lead-intake pipeline. */
export type NonCustomerKind = Exclude<ContactKind, 'customer'>;

export type ParseContactResult =
  | { ok: true; draft: ParsedContact; matches: ContactMatch[] }
  | { ok: false; error: string };

export async function parseInboundContactAction(formData: FormData): Promise<ParseContactResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };

  const kind = String(formData.get('kind') ?? '') as NonCustomerKind;
  const pastedText = String(formData.get('pastedText') ?? '').trim();
  const seedName = String(formData.get('name') ?? '').trim();

  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!seedName && !pastedText && files.length === 0) {
    return { ok: false, error: 'Drop an image/PDF, paste text, or type a name first.' };
  }
  if (files.length > MAX_IMAGES) {
    return { ok: false, error: `Too many files (max ${MAX_IMAGES}).` };
  }
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      return { ok: false, error: `${f.name} is larger than 25MB.` };
    }
    const isImage = f.type.startsWith('image/');
    const isPdf = f.type === 'application/pdf';
    if (!isImage && !isPdf) {
      return { ok: false, error: `${f.name} is not an image or PDF (${f.type}).` };
    }
  }

  const userContent: Array<Record<string, unknown>> = [];
  const intro = [
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Contact kind: ${kind}`,
    seedName ? `Operator-supplied name hint: ${seedName}` : '(No name hint provided.)',
    pastedText ? `Pasted text:\n${pastedText}` : '(No pasted text — extract from artifacts.)',
    files.length
      ? `${files.length} artifact(s) follow (images/PDFs), indexed 0..${files.length - 1}.`
      : '(No artifacts.)',
  ].join('\n\n');
  userContent.push({ type: 'text', text: intro });

  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    const b64 = buf.toString('base64');
    if (f.type === 'application/pdf') {
      userContent.push({
        type: 'file',
        file: {
          filename: f.name || 'document.pdf',
          file_data: `data:application/pdf;base64,${b64}`,
        },
      });
    } else {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${f.type};base64,${b64}` },
      });
    }
  }

  const body = {
    model: PARSE_MODEL,
    messages: [
      { role: 'system', content: CONTACT_INTAKE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: CONTACT_INTAKE_JSON_SCHEMA },
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `OpenAI ${res.status}: ${txt || res.statusText}` };
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'OpenAI returned no content.' };

  let draft: ParsedContact;
  try {
    draft = JSON.parse(content) as ParsedContact;
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }

  // Operator-supplied name hint wins over whatever the model pulled.
  if (seedName) draft.name = seedName;

  // Surface any existing contacts that might be the same person so the
  // operator can choose "attach to existing" instead of creating a dupe.
  const matches = await findContactMatches({
    name: draft.name,
    phone: draft.phone,
    email: draft.email,
  });

  return { ok: true, draft, matches };
}

export type AcceptContactResult = { ok: true; contactId: string } | { ok: false; error: string };

export async function acceptInboundContactAction(input: {
  kind: NonCustomerKind;
  draft: ParsedContact;
}): Promise<AcceptContactResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const draft = input.draft;
  const name = draft.name?.trim();
  if (!name) return { ok: false, error: 'Contact name is required.' };

  const supabase = await createClient();
  const { data: contact, error: contactErr } = await supabase
    .from('customers')
    .insert({
      tenant_id: tenant.id,
      kind: input.kind,
      // Non-customer kinds must keep `type` NULL (DB check constraint).
      type: null,
      name,
      email: draft.email?.trim() || null,
      phone: draft.phone?.trim() || null,
      address_line1: draft.address?.trim() || null,
      city: draft.city?.trim() || null,
      province: draft.province?.trim() || null,
      postal_code: draft.postal_code?.trim() || null,
    })
    .select('id')
    .single();
  if (contactErr || !contact) {
    return { ok: false, error: contactErr?.message ?? 'Failed to create contact.' };
  }

  // Seed the notes feed with whatever the AI summarized + any structured
  // fields that don't map onto `customers` columns (website, trade).
  const noteLines: string[] = [];
  if (draft.trade) noteLines.push(`Trade: ${draft.trade}`);
  if (draft.website) noteLines.push(`Website: ${draft.website}`);
  if (draft.notes?.trim()) noteLines.push(draft.notes.trim());
  const body = noteLines.join('\n\n').trim();
  if (body) {
    await supabase.from('contact_notes').insert({
      tenant_id: tenant.id,
      contact_id: contact.id,
      author_type: 'henry',
      body,
      metadata: { source: 'contact_intake' },
    });
  }

  revalidatePath('/contacts');
  revalidatePath(`/contacts/${contact.id}`);
  return { ok: true, contactId: contact.id };
}

/**
 * "Attach to existing" path from the intake review screen. Instead of
 * creating a new contact we merge the parsed draft into the existing
 * record: fill in any blank columns, then drop the captured notes/trade/
 * website into the notes feed as a new entry. Never overwrite operator-
 * entered data.
 */
export async function attachIntakeToContactAction(input: {
  contactId: string;
  draft: ParsedContact;
}): Promise<AcceptContactResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: existing, error: loadErr } = await supabase
    .from('customers')
    .select('id, email, phone, address_line1, city, province, postal_code')
    .eq('id', input.contactId)
    .is('deleted_at', null)
    .single();
  if (loadErr || !existing) {
    return { ok: false, error: loadErr?.message ?? 'Contact not found.' };
  }

  const draft = input.draft;

  // Only fill in fields that are currently blank — never overwrite.
  const patch: Record<string, string> = {};
  if (!existing.email && draft.email?.trim()) patch.email = draft.email.trim();
  if (!existing.phone && draft.phone?.trim()) patch.phone = draft.phone.trim();
  if (!existing.address_line1 && draft.address?.trim()) {
    patch.address_line1 = draft.address.trim();
  }
  if (!existing.city && draft.city?.trim()) patch.city = draft.city.trim();
  if (!existing.province && draft.province?.trim()) patch.province = draft.province.trim();
  if (!existing.postal_code && draft.postal_code?.trim()) {
    patch.postal_code = draft.postal_code.trim();
  }
  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString();
    const { error: patchErr } = await supabase
      .from('customers')
      .update(patch)
      .eq('id', input.contactId);
    if (patchErr) {
      return { ok: false, error: `Failed to update contact: ${patchErr.message}` };
    }
  }

  const noteLines: string[] = [];
  if (draft.trade) noteLines.push(`Trade: ${draft.trade}`);
  if (draft.website) noteLines.push(`Website: ${draft.website}`);
  if (draft.notes?.trim()) noteLines.push(draft.notes.trim());
  const body = noteLines.join('\n\n').trim();
  if (body) {
    await supabase.from('contact_notes').insert({
      tenant_id: tenant.id,
      contact_id: input.contactId,
      author_type: 'henry',
      body,
      metadata: { source: 'contact_intake_attach' },
    });
  }

  revalidatePath(`/contacts/${input.contactId}`);
  return { ok: true, contactId: input.contactId };
}
