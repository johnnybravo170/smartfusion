'use server';

/**
 * Commit a reviewed quote extraction: creates the customer, the project,
 * and the cost buckets in one server round-trip. Used by the PDF-drop
 * flow on /projects/new.
 *
 * Skips the default-bucket seeding in createProjectAction — the whole
 * point is to use the buckets extracted from the quote.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type QuoteImportInput = {
  customer: {
    id?: string; // if set, use existing customer
    type: 'residential' | 'commercial' | 'agent';
    name: string;
    address?: string;
  };
  project: {
    name: string;
    description?: string;
    start_date?: string;
    management_fee_rate: number;
  };
  buckets: {
    section: string;
    name: string;
    description: string;
    estimate_cents: number;
    display_order: number;
  }[];
};

export type QuoteImportResult = { ok: true; projectId: string } | { ok: false; error: string };

export async function commitQuoteImportAction(input: QuoteImportInput): Promise<QuoteImportResult> {
  if (!input.project.name.trim()) return { ok: false, error: 'Project name is required.' };
  if (!input.customer.id && !input.customer.name.trim()) {
    return { ok: false, error: 'Customer name is required.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  // 1. Customer: reuse if id given, else create
  let customerId = input.customer.id ?? '';
  if (!customerId) {
    const { data: c, error: cErr } = await supabase
      .from('customers')
      .insert({
        tenant_id: tenant.id,
        type: input.customer.type,
        name: input.customer.name.trim(),
        address_line1: input.customer.address?.trim() || null,
      })
      .select('id')
      .single();
    if (cErr || !c) {
      return { ok: false, error: `Failed to create customer: ${cErr?.message ?? 'unknown'}` };
    }
    customerId = c.id as string;
  }

  // 2. Project (without seeding default buckets)
  const { data: p, error: pErr } = await supabase
    .from('projects')
    .insert({
      tenant_id: tenant.id,
      customer_id: customerId,
      name: input.project.name.trim(),
      description: input.project.description?.trim() || null,
      start_date: input.project.start_date || null,
      management_fee_rate: input.project.management_fee_rate,
    })
    .select('id')
    .single();
  if (pErr || !p) {
    return { ok: false, error: `Failed to create project: ${pErr?.message ?? 'unknown'}` };
  }
  const projectId = p.id as string;

  // 3. Buckets from the extraction
  if (input.buckets.length > 0) {
    const bucketRows = input.buckets.map((b, i) => ({
      project_id: projectId,
      tenant_id: tenant.id,
      name: b.name.trim(),
      section: b.section.trim(),
      description: b.description?.trim() || null,
      estimate_cents: Math.max(0, Math.round(b.estimate_cents)),
      display_order: b.display_order ?? i,
    }));
    const { error: bErr } = await supabase.from('project_cost_buckets').insert(bucketRows);
    if (bErr) {
      // Project exists; surface the error but don't roll back.
      return {
        ok: false,
        error: `Project created but bucket insert failed: ${bErr.message}. Project id ${projectId}.`,
      };
    }
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project created from quote PDF',
    body: `Project "${input.project.name}" created via quote import (${input.buckets.length} buckets).`,
    related_type: 'project',
    related_id: projectId,
  });

  revalidatePath('/projects');
  return { ok: true, projectId };
}
