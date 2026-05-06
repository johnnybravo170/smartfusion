'use server';

/**
 * Phase C of the onboarding import wizard. Invoices, with the historical
 * money math FROZEN at whatever the source recorded.
 *
 * Two compounding wrinkles vs Phase B:
 *
 *   1. **Dual FK resolution.** Each invoice row carries a customer ref
 *      (required) and an optional project ref. Both can be matched,
 *      created-as-side-effect, or unattached. Side-effect rows are
 *      tagged with the SAME invoices-kind batch so a rollback removes
 *      everything from this operation in one click.
 *
 *   2. **Frozen tax math.** amount_cents and tax_cents on imported
 *      invoices land EXACTLY as the source had them — no recomputation
 *      against today's customer-facing rate. Imagine a contractor
 *      moved provinces between when an invoice was sent and today: re-
 *      deriving tax would silently rewrite history. The
 *      `import_batch_id IS NOT NULL` flag on the invoice is the
 *      contract that downstream code must honor.
 *
 * Sent / paid / void invoices are normal in QB exports. We accept all
 * four statuses (`draft`, `sent`, `paid`, `void`) on import. The
 * historical sent_at / paid_at timestamps come through as recorded.
 *
 * See:
 *   - migration 0187_invoices_import_batch.sql
 *   - src/lib/invoices/dedup.ts
 *   - PATTERNS.md §16
 */

import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import {
  type ExistingCustomer,
  findMatch as findCustomerMatch,
  normalizeName,
} from '@/lib/customers/dedup';
import {
  type ExistingInvoice,
  findInvoiceMatch,
  type InvoiceMatchTier,
  invoiceTierLabel,
  parseDollarTextToCents,
} from '@/lib/invoices/dedup';
import { type ExistingProject, findProjectMatch } from '@/lib/projects/dedup';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const MAX_PASTE_BYTES = 25 * 1024 * 1024;
const MAX_LLM_SLICE_CHARS = 800_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProposedInvoice = {
  customerName: string;
  /** Optional — operator's project label from the source row. Resolved
   *  against the existing project list (and the customer FK once we know
   *  it). null = invoice not associated with a project. */
  projectName?: string | null;
  invoiceDateIso: string | null; // YYYY-MM-DD
  /** Source-text amounts, parsed lazily so we can show the operator
   *  exactly what was on the row even if we couldn't parse it. */
  subtotalText?: string | null;
  taxText?: string | null;
  totalText?: string | null;
  /** Resolved cents. Null when the source row didn't carry a parseable
   *  number; the wizard surfaces those for manual entry. */
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  status: 'draft' | 'sent' | 'paid' | 'void';
  sentAtIso: string | null;
  paidAtIso: string | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  customerNote?: string | null;
};

export type CustomerResolution =
  | {
      kind: 'matched';
      existingId: string;
      existingName: string;
      tier: 'email' | 'phone' | 'name+city' | 'name';
    }
  | { kind: 'create'; newName: string };

export type ProjectResolution =
  | {
      kind: 'matched';
      existingId: string;
      existingName: string;
    }
  | { kind: 'create'; newName: string }
  | { kind: 'unattached' };

export type InvoiceImportProposalRow = {
  rowKey: string;
  proposed: ProposedInvoice;
  customer: CustomerResolution;
  project: ProjectResolution;
  invoiceMatch: {
    tier: InvoiceMatchTier;
    label: string;
    existingId: string | null;
  };
};

export type ParseInvoiceImportResult =
  | {
      ok: true;
      sourceFilename: string | null;
      sourceStoragePath: string | null;
      rows: InvoiceImportProposalRow[];
      summary: {
        proposed: number;
        customersToCreate: number;
        projectsToCreate: number;
        invoiceMatches: number;
      };
    }
  | { ok: false; error: string };

// ─── Parse: file/paste → proposed invoices ──────────────────────────────────

const INVOICE_PARSE_PROMPT = `You are reading a list of invoices a Canadian renovation contractor wants to import. The input may be a QuickBooks export, a Jobber CSV, an Excel sheet, or a plain text list. Each row is ONE invoice.

Rules:
- "customer_name" is required (exactly as written).
- "project_name" — if the source has a project/job label distinct from the customer, capture it. null otherwise.
- "invoice_date" — YYYY-MM-DD. Look for "Invoice Date", "Date", "Issued". If only one date is on the row, use it.
- Money: the source might give you any TWO of (subtotal, tax, total) and we can derive the third. Capture all three text values exactly as written ("$5,672.40", "1,234", etc.) so the operator can verify. The system parses these lazily; do NOT reformat.
- "status" — one of "draft" | "sent" | "paid" | "void":
    paid / closed / completed → "paid"
    sent / outstanding / open / pending payment → "sent"
    void / cancelled / refunded → "void"
    everything else (or unclear) → "draft"
- "sent_at" — YYYY-MM-DD if there's a clear "sent" / "issued" date distinct from invoice_date. null otherwise.
- "paid_at" — YYYY-MM-DD if status is paid AND there's a clear paid date column. null otherwise.
- "payment_method" — if printed (cheque, e-transfer, cash, credit). null otherwise.
- "payment_reference" — cheque number, e-transfer ref, etc. Capture as written. null otherwise.
- "customer_note" — short single-line description of what was billed for, drawn from any free-form column. null when absent.
- Skip rows that are clearly subtotals, headers, or blanks.

Return ONLY JSON matching the schema. No prose, no markdown.`;

const INVOICE_PARSE_SCHEMA = {
  type: 'object',
  properties: {
    invoices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          customer_name: { type: 'string' },
          project_name: { type: ['string', 'null'] },
          invoice_date: { type: ['string', 'null'] },
          subtotal_text: { type: ['string', 'null'] },
          tax_text: { type: ['string', 'null'] },
          total_text: { type: ['string', 'null'] },
          status: {
            type: 'string',
            enum: ['draft', 'sent', 'paid', 'void'],
          },
          sent_at: { type: ['string', 'null'] },
          paid_at: { type: ['string', 'null'] },
          payment_method: { type: ['string', 'null'] },
          payment_reference: { type: ['string', 'null'] },
          customer_note: { type: ['string', 'null'] },
        },
        required: ['customer_name', 'status'],
      },
    },
  },
  required: ['invoices'],
};

type RawProposedInvoice = {
  customer_name: unknown;
  project_name?: unknown;
  invoice_date?: unknown;
  subtotal_text?: unknown;
  tax_text?: unknown;
  total_text?: unknown;
  status: unknown;
  sent_at?: unknown;
  paid_at?: unknown;
  payment_method?: unknown;
  payment_reference?: unknown;
  customer_note?: unknown;
};

function userSafeError(err: unknown): string {
  if (isAiError(err)) {
    if (err.kind === 'quota')
      return 'Henry is temporarily unavailable. Please try again in a few minutes.';
    if (err.kind === 'overload' || err.kind === 'rate_limit')
      return 'Henry is busy right now. Please try again in a moment.';
    if (err.kind === 'timeout') return 'That took too long. Try with fewer rows or split the file.';
  }
  return 'Could not parse the file. Try pasting a smaller sample or a different format.';
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function pickStatus(v: unknown): ProposedInvoice['status'] {
  return v === 'sent' || v === 'paid' || v === 'void' ? v : 'draft';
}

function pickDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

/** Reconcile (subtotal, tax, total) — fill in whichever is missing if
 *  the other two are present. Returns nulls when the math is inconsistent
 *  (operator can fix in the preview). */
function reconcileMoney(
  subtotal: number | null,
  tax: number | null,
  total: number | null,
): { subtotal: number | null; tax: number | null; total: number | null } {
  const have = [subtotal, tax, total].filter((n): n is number => n !== null).length;
  if (have === 3) {
    // Trust the source even if there's a 1-cent rounding drift.
    return { subtotal, tax, total };
  }
  if (have === 2) {
    if (subtotal === null && tax !== null && total !== null) {
      return { subtotal: total - tax, tax, total };
    }
    if (tax === null && subtotal !== null && total !== null) {
      return { subtotal, tax: total - subtotal, total };
    }
    if (total === null && subtotal !== null && tax !== null) {
      return { subtotal, tax, total: subtotal + tax };
    }
  }
  // 0 or 1 known — leave alone, operator types it in or skips.
  return { subtotal, tax, total };
}

export async function parseInvoiceImportAction(
  formData: FormData,
): Promise<ParseInvoiceImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = formData.get('file');
  const text = formData.get('text');

  let payload: string;
  let sourceFilename: string | null = null;
  let sourceStoragePath: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_PASTE_BYTES) {
      return { ok: false, error: 'File is larger than 25MB. Try splitting it up.' };
    }
    sourceFilename = file.name;
    const buf = Buffer.from(await file.arrayBuffer());
    payload = buf.toString('utf8');

    const admin = createAdminClient();
    const stamp = Date.now();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    sourceStoragePath = `${tenant.id}/${stamp}-${safeName}`;
    const { error: uploadErr } = await admin.storage
      .from('imports')
      .upload(sourceStoragePath, buf, { contentType: file.type || 'text/plain' });
    if (uploadErr) {
      console.error('[onboarding-import-invoices] source archive failed:', uploadErr.message);
      sourceStoragePath = null;
    }
  } else if (typeof text === 'string' && text.trim()) {
    if (text.length > MAX_PASTE_BYTES) {
      return { ok: false, error: 'Pasted text is larger than 25MB. Try splitting it up.' };
    }
    payload = text;
  } else {
    return { ok: false, error: 'Upload a file or paste your invoice list.' };
  }

  const promptInput =
    payload.length > MAX_LLM_SLICE_CHARS
      ? `${payload.slice(0, MAX_LLM_SLICE_CHARS)}\n[...truncated — too large for one pass; split the file]`
      : payload;

  let raw: { invoices: RawProposedInvoice[] };
  try {
    const res = await gateway().runStructured<{ invoices: RawProposedInvoice[] }>({
      kind: 'structured',
      task: 'onboarding_invoice_classify',
      tenant_id: tenant.id,
      prompt: `${INVOICE_PARSE_PROMPT}\n\nINPUT:\n${promptInput}`,
      schema: INVOICE_PARSE_SCHEMA,
      temperature: 0.1,
    });
    raw = res.data;
  } catch (err) {
    return { ok: false, error: userSafeError(err) };
  }

  const proposals: ProposedInvoice[] = (raw.invoices ?? [])
    .map((r): ProposedInvoice | null => {
      const customerName = pickString(r.customer_name);
      if (!customerName) return null;
      const subRaw = parseDollarTextToCents(pickString(r.subtotal_text));
      const taxRaw = parseDollarTextToCents(pickString(r.tax_text));
      const totalRaw = parseDollarTextToCents(pickString(r.total_text));
      const reconciled = reconcileMoney(subRaw, taxRaw, totalRaw);
      return {
        customerName,
        projectName: pickString(r.project_name),
        invoiceDateIso: pickDate(r.invoice_date),
        subtotalText: pickString(r.subtotal_text),
        taxText: pickString(r.tax_text),
        totalText: pickString(r.total_text),
        subtotalCents: reconciled.subtotal,
        taxCents: reconciled.tax,
        totalCents: reconciled.total,
        status: pickStatus(r.status),
        sentAtIso: pickDate(r.sent_at),
        paidAtIso: pickDate(r.paid_at),
        paymentMethod: pickString(r.payment_method),
        paymentReference: pickString(r.payment_reference),
        customerNote: pickString(r.customer_note),
      };
    })
    .filter((p): p is ProposedInvoice => p !== null);

  // Pull existing rosters in parallel for FK resolution + dedup.
  const supabase = await createClient();
  const [
    { data: existingCustRaw, error: custErr },
    { data: existingProjRaw, error: projErr },
    { data: existingInvRaw, error: invErr },
  ] = await Promise.all([
    supabase.from('customers').select('id, name, email, phone, city').is('deleted_at', null),
    supabase
      .from('projects')
      .select('id, name, customer_id, customers:customer_id (name)')
      .is('deleted_at', null),
    supabase
      .from('invoices')
      .select('id, customer_id, amount_cents, tax_cents, sent_at, paid_at, created_at')
      .is('deleted_at', null),
  ]);
  if (custErr) return { ok: false, error: custErr.message };
  if (projErr) return { ok: false, error: projErr.message };
  if (invErr) return { ok: false, error: invErr.message };

  const existingCustomers: ExistingCustomer[] = (existingCustRaw ?? []).map((c) => ({
    id: c.id as string,
    name: (c.name as string) ?? '',
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    city: (c.city as string | null) ?? null,
  }));
  const existingProjects: ExistingProject[] = (existingProjRaw ?? []).map((p) => {
    const cust = (p as Record<string, unknown>).customers as { name?: string } | null;
    return {
      id: p.id as string,
      name: (p.name as string) ?? '',
      customer_id: (p.customer_id as string | null) ?? null,
      customer_name: cust?.name ?? null,
    };
  });
  const existingInvoices: ExistingInvoice[] = (existingInvRaw ?? []).map((i) => ({
    id: i.id as string,
    customer_id: (i.customer_id as string | null) ?? null,
    amount_cents: (i.amount_cents as number) ?? 0,
    tax_cents: (i.tax_cents as number) ?? 0,
    anchor_date:
      (i.sent_at as string | null) ?? (i.paid_at as string | null) ?? (i.created_at as string),
  }));

  const rows: InvoiceImportProposalRow[] = proposals.map((p, i) => {
    const customer = resolveCustomer(p.customerName, existingCustomers);
    const project = resolveProject(
      p.projectName,
      customer.kind === 'matched' ? customer.existingId : null,
      existingProjects,
    );
    const invoiceMatch =
      p.totalCents !== null && p.invoiceDateIso && customer.kind === 'matched'
        ? findInvoiceMatch(
            {
              customerId: customer.existingId,
              totalCents: p.totalCents,
              invoiceDateIso: p.invoiceDateIso,
            },
            existingInvoices,
          )
        : { tier: null, existing: null };
    return {
      rowKey: `i${i}`,
      proposed: p,
      customer,
      project,
      invoiceMatch: {
        tier: invoiceMatch.tier,
        label: invoiceTierLabel(invoiceMatch.tier),
        existingId: invoiceMatch.existing?.id ?? null,
      },
    };
  });

  return {
    ok: true,
    sourceFilename,
    sourceStoragePath,
    rows,
    summary: {
      proposed: rows.length,
      customersToCreate: rows.filter((r) => r.customer.kind === 'create').length,
      projectsToCreate: rows.filter((r) => r.project.kind === 'create').length,
      invoiceMatches: rows.filter((r) => r.invoiceMatch.tier !== null).length,
    },
  };
}

function resolveCustomer(customerName: string, existing: ExistingCustomer[]): CustomerResolution {
  const m = findCustomerMatch({ name: customerName }, existing);
  if (m.tier && m.existing) {
    return {
      kind: 'matched',
      existingId: m.existing.id,
      existingName: m.existing.name,
      tier: m.tier,
    };
  }
  return { kind: 'create', newName: customerName };
}

function resolveProject(
  projectName: string | null | undefined,
  customerId: string | null,
  existing: ExistingProject[],
): ProjectResolution {
  if (!projectName) return { kind: 'unattached' };
  const m = findProjectMatch({ name: projectName, customerId }, existing);
  if (m.existing) {
    return { kind: 'matched', existingId: m.existing.id, existingName: m.existing.name };
  }
  return { kind: 'create', newName: projectName };
}

// ─── Commit ─────────────────────────────────────────────────────────────────

export type CommitInvoiceImportRow = {
  rowKey: string;
  decision: 'create' | 'merge' | 'skip';
  /** Resolved at commit time on the client (operator may have flipped). */
  proposed: ProposedInvoice;
  customer: CustomerResolution;
  project: ProjectResolution;
};

export type CommitInvoiceImportResult =
  | {
      ok: true;
      batchId: string;
      created: number;
      merged: number;
      skipped: number;
      customersCreated: number;
      projectsCreated: number;
    }
  | { ok: false; error: string };

export async function commitInvoiceImportAction(input: {
  rows: CommitInvoiceImportRow[];
  sourceFilename: string | null;
  sourceStoragePath: string | null;
  note: string | null;
}): Promise<CommitInvoiceImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const user = await getCurrentUser();

  const toCreate = input.rows.filter((r) => r.decision === 'create');
  const merged = input.rows.filter((r) => r.decision === 'merge').length;
  const skipped = input.rows.filter((r) => r.decision === 'skip').length;

  // Reject rows missing the bare-minimum money math — better to skip
  // than write a $0 invoice the operator didn't notice.
  const insufficient = toCreate.filter(
    (r) => r.proposed.subtotalCents === null || r.proposed.taxCents === null,
  );
  if (insufficient.length > 0) {
    return {
      ok: false,
      error: `${insufficient.length} row${insufficient.length === 1 ? ' has' : 's have'} missing subtotal or tax. Fix or skip those rows.`,
    };
  }

  if (toCreate.length === 0 && merged === 0) {
    return { ok: false, error: 'Nothing to commit — every row is set to skip.' };
  }

  // Step 1: open the batch.
  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenant.id,
      kind: 'invoices',
      source_filename: input.sourceFilename,
      source_storage_path: input.sourceStoragePath,
      summary: {},
      note: input.note?.trim() || null,
      created_by: user?.id ?? null,
    })
    .select('id')
    .single();
  if (batchErr || !batch)
    return { ok: false, error: batchErr?.message ?? 'Could not start batch.' };
  const batchId = batch.id as string;

  // Step 2: side-effect customers (deduped by normalized name within
  // this import).
  const customerNameToId = new Map<string, string>();
  for (const r of toCreate) {
    if (r.customer.kind === 'matched') {
      customerNameToId.set(normalizeName(r.customer.existingName), r.customer.existingId);
    }
  }
  const newCustomerNames = Array.from(
    new Set(
      toCreate
        .filter((r) => r.customer.kind === 'create')
        .map((r) => (r.customer.kind === 'create' ? r.customer.newName.trim() : ''))
        .filter(Boolean),
    ),
  );
  let customersCreated = 0;
  if (newCustomerNames.length > 0) {
    const { data: insertedCustomers, error: custInsErr } = await supabase
      .from('customers')
      .insert(
        newCustomerNames.map((name) => ({
          tenant_id: tenant.id,
          name,
          kind: 'customer',
          import_batch_id: batchId,
        })),
      )
      .select('id, name');
    if (custInsErr) {
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: custInsErr.message };
    }
    for (const c of insertedCustomers ?? []) {
      customerNameToId.set(normalizeName(c.name as string), c.id as string);
    }
    customersCreated = (insertedCustomers ?? []).length;
  }

  // Step 3: side-effect projects (keyed by customerName + projectName so
  // two invoice rows referencing the same project share a single new
  // project row).
  const projectKey = (customerName: string, projectName: string) =>
    `${normalizeName(customerName)}::${normalizeName(projectName)}`;
  const projectKeyToId = new Map<string, string>();
  // Pre-populate matched.
  for (const r of toCreate) {
    if (r.project.kind === 'matched' && r.customer.kind !== 'create') {
      const cName = r.customer.kind === 'matched' ? r.customer.existingName : '';
      projectKeyToId.set(projectKey(cName, r.project.existingName), r.project.existingId);
    } else if (r.project.kind === 'matched' && r.customer.kind === 'create') {
      projectKeyToId.set(
        projectKey(r.customer.newName, r.project.existingName),
        r.project.existingId,
      );
    }
  }
  const projectsToCreate = toCreate
    .filter((r) => r.project.kind === 'create')
    .map((r) => {
      const cName =
        r.customer.kind === 'matched'
          ? r.customer.existingName
          : r.customer.kind === 'create'
            ? r.customer.newName
            : '';
      return {
        key: projectKey(cName, r.project.kind === 'create' ? r.project.newName : ''),
        name: r.project.kind === 'create' ? r.project.newName : '',
        customerId: customerNameToId.get(normalizeName(cName)) ?? null,
      };
    });
  // Dedupe within import.
  const uniqueProjectInserts = Array.from(
    new Map(projectsToCreate.map((p) => [p.key, p])).values(),
  );
  let projectsCreated = 0;
  if (uniqueProjectInserts.length > 0) {
    const { data: insertedProjects, error: projInsErr } = await supabase
      .from('projects')
      .insert(
        uniqueProjectInserts.map((p) => ({
          tenant_id: tenant.id,
          customer_id: p.customerId,
          name: p.name,
          lifecycle_stage: 'active', // imported invoices imply the project ran
          import_batch_id: batchId,
        })),
      )
      .select('id, name, customer_id');
    if (projInsErr) {
      await supabase.from('customers').delete().eq('import_batch_id', batchId);
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: projInsErr.message };
    }
    for (const p of insertedProjects ?? []) {
      // Reverse-lookup the customer name for the key. We have customer_id;
      // find its name from our running map.
      const cName = Array.from(customerNameToId.entries()).find(
        ([, id]) => id === (p.customer_id as string | null),
      )?.[0];
      if (cName) {
        projectKeyToId.set(projectKey(cName, p.name as string), p.id as string);
      }
    }
    projectsCreated = (insertedProjects ?? []).length;
  }

  // Step 4: invoices with FROZEN money math + resolved FKs.
  const invoiceRows = toCreate.map((r) => {
    const cName =
      r.customer.kind === 'matched'
        ? r.customer.existingName
        : r.customer.kind === 'create'
          ? r.customer.newName
          : '';
    const customerId = customerNameToId.get(normalizeName(cName)) ?? null;
    let projectId: string | null = null;
    if (r.project.kind === 'matched') {
      projectId = r.project.existingId;
    } else if (r.project.kind === 'create') {
      projectId = projectKeyToId.get(projectKey(cName, r.project.newName)) ?? null;
    }
    return {
      tenant_id: tenant.id,
      customer_id: customerId,
      project_id: projectId,
      status: r.proposed.status,
      // FROZEN MATH — do not recompute. amount_cents = subtotal,
      // tax_cents = tax, both straight from source. tax_inclusive=false
      // because every QB-style export breaks subtotal + tax separately.
      amount_cents: r.proposed.subtotalCents ?? 0,
      tax_cents: r.proposed.taxCents ?? 0,
      tax_inclusive: false,
      doc_type: 'invoice',
      sent_at: r.proposed.sentAtIso || r.proposed.invoiceDateIso || null,
      paid_at: r.proposed.paidAtIso,
      payment_method: r.proposed.paymentMethod,
      payment_reference: r.proposed.paymentReference,
      customer_note: r.proposed.customerNote,
      import_batch_id: batchId,
    };
  });

  if (invoiceRows.length > 0) {
    const { error: invInsErr } = await supabase.from('invoices').insert(invoiceRows);
    if (invInsErr) {
      // Cascade rollback the side-effects we created.
      await supabase.from('projects').delete().eq('import_batch_id', batchId);
      await supabase.from('customers').delete().eq('import_batch_id', batchId);
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: invInsErr.message };
    }
  }

  await supabase
    .from('import_batches')
    .update({
      summary: {
        created: toCreate.length,
        merged,
        skipped,
        customersCreated,
        projectsCreated,
      },
    })
    .eq('id', batchId);

  return {
    ok: true,
    batchId,
    created: toCreate.length,
    merged,
    skipped,
    customersCreated,
    projectsCreated,
  };
}

// ─── Rollback ───────────────────────────────────────────────────────────────

export async function rollbackInvoiceImportAction(batchId: string): Promise<
  | {
      ok: true;
      deletedInvoices: number;
      deletedProjects: number;
      deletedCustomers: number;
    }
  | { ok: false; error: string }
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const user = await getCurrentUser();

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .select('id, kind, rolled_back_at')
    .eq('id', batchId)
    .maybeSingle();
  if (batchErr || !batch) return { ok: false, error: 'Batch not found.' };
  if (batch.rolled_back_at) return { ok: false, error: 'Batch already rolled back.' };
  if (batch.kind !== 'invoices') {
    return {
      ok: false,
      error: `Cannot roll back ${batch.kind} batches with the invoice rollback action.`,
    };
  }

  const now = new Date().toISOString();

  const { data: deletedInvRows, error: invDelErr } = await supabase
    .from('invoices')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (invDelErr) return { ok: false, error: invDelErr.message };

  const { data: deletedProjRows, error: projDelErr } = await supabase
    .from('projects')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (projDelErr) return { ok: false, error: projDelErr.message };

  const { data: deletedCustRows, error: custDelErr } = await supabase
    .from('customers')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (custDelErr) return { ok: false, error: custDelErr.message };

  const { error: markErr } = await supabase
    .from('import_batches')
    .update({ rolled_back_at: now, rolled_back_by: user?.id ?? null })
    .eq('id', batchId);
  if (markErr) return { ok: false, error: markErr.message };

  return {
    ok: true,
    deletedInvoices: (deletedInvRows ?? []).length,
    deletedProjects: (deletedProjRows ?? []).length,
    deletedCustomers: (deletedCustRows ?? []).length,
  };
}
