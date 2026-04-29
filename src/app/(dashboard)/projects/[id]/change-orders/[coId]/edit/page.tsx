import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ChangeOrderDiffForm,
  type ChangeOrderFormInitialState,
} from '@/components/features/change-orders/change-order-diff-form';
import {
  type ChangeOrderLineRow,
  type ChangeOrderRow,
  getChangeOrder,
  listChangeOrderLines,
} from '@/lib/db/queries/change-orders';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { getProject } from '@/lib/db/queries/projects';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; coId: string }>;
}) {
  const { coId } = await params;
  const co = await getChangeOrder(coId);
  return {
    title: co ? `Edit ${co.title} — HeyHenry` : 'Edit Change Order — HeyHenry',
  };
}

export default async function EditChangeOrderPage({
  params,
}: {
  params: Promise<{ id: string; coId: string }>;
}) {
  const { id, coId } = await params;

  const [project, co] = await Promise.all([getProject(id), getChangeOrder(coId)]);
  if (!project || !co) notFound();

  // Edit is only valid for v2 drafts. Sent / approved / applied COs are
  // part of the audit trail; legacy v1 drafts use a separate form.
  if (co.status !== 'draft' || co.flow_version !== 2) {
    redirect(`/projects/${id}/change-orders/${coId}`);
  }

  const [diffLines, existingLines] = await Promise.all([
    listChangeOrderLines(coId),
    listCostLines(id),
  ]);

  const initialState = buildInitialState(co, diffLines);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link
        href={`/projects/${id}/change-orders/${coId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to preview
      </Link>

      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Edit Change Order</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Project: {project.name}. Saving updates the customer-facing preview only — nothing is sent
        until you click &ldquo;Send for Approval&rdquo;.
      </p>

      <ChangeOrderDiffForm
        projectId={id}
        budgetCategories={project.budget_categories}
        existingLines={existingLines}
        defaultManagementFeeRate={project.management_fee_rate}
        mode={{ kind: 'edit', changeOrderId: coId, initialState }}
      />
    </div>
  );
}

/**
 * Reverse-map a saved CO + its `change_order_lines` back into the form's
 * state shape so the operator picks up exactly where they left off.
 */
function buildInitialState(
  co: ChangeOrderRow,
  diffLines: ChangeOrderLineRow[],
): ChangeOrderFormInitialState {
  const editsById: Record<string, { qty?: string; unit_price_dollars?: string; notes?: string }> =
    {};
  const removedIds: string[] = [];
  const added: ChangeOrderFormInitialState['added'] = [];
  const envelopeEdits: Record<string, string> = {};

  for (const line of diffLines) {
    if (line.action === 'modify' && line.original_line_id) {
      editsById[line.original_line_id] = {
        qty: line.qty != null ? String(line.qty) : undefined,
        unit_price_dollars:
          line.unit_price_cents != null ? (line.unit_price_cents / 100).toString() : undefined,
        notes: line.notes ?? undefined,
      };
    } else if (line.action === 'remove' && line.original_line_id) {
      removedIds.push(line.original_line_id);
      if (line.notes) {
        editsById[line.original_line_id] = { notes: line.notes };
      }
    } else if (line.action === 'add' && line.budget_category_id) {
      added.push({
        tempId: line.id, // reuse the persisted line id as the temp id
        budget_category_id: line.budget_category_id,
        label: line.label ?? '',
        qty: line.qty != null ? String(line.qty) : '1',
        unit: line.unit ?? 'ea',
        unit_price_dollars:
          line.unit_price_cents != null ? (line.unit_price_cents / 100).toString() : '0',
        notes: line.notes ?? '',
      });
    } else if (line.action === 'modify_envelope' && line.budget_category_id) {
      if (line.line_price_cents != null) {
        envelopeEdits[line.budget_category_id] = (line.line_price_cents / 100).toString();
      }
    }
  }

  const notesByCategory: Record<string, string> = {};
  for (const n of co.category_notes ?? []) {
    if (n.budget_category_id && n.note) notesByCategory[n.budget_category_id] = n.note;
  }

  const mgmtFeePct =
    co.management_fee_override_rate != null
      ? (co.management_fee_override_rate * 100).toFixed(2).replace(/\.?0+$/, '')
      : null;

  return {
    title: co.title,
    description: co.description,
    reason: co.reason ?? '',
    timelineDays: String(co.timeline_impact_days ?? 0),
    mgmtFeePct,
    mgmtFeeReason: co.management_fee_override_reason ?? '',
    editsById,
    removedIds,
    added,
    notesByCategory,
    envelopeEdits,
  };
}
