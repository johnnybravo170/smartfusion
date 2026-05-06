import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MakeRecurringButton } from '@/components/features/expenses/make-recurring-button';
import { OverheadExpenseForm } from '@/components/features/expenses/overhead-expense-form';
import { requireTenant } from '@/lib/auth/helpers';
import {
  buildCategoryTree,
  buildPickerOptions,
  listExpenseCategories,
} from '@/lib/db/queries/expense-categories';
import { listPaymentSources, toLite } from '@/lib/db/queries/payment-sources';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata = {
  title: 'Edit overhead expense — HeyHenry',
};

export default async function EditOverheadExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { tenant } = await requireTenant();
  if (tenant.member.role === 'worker') redirect('/w');

  const admin = createAdminClient();

  // Pull the expense, confirming it belongs to this tenant and is an
  // overhead row (project_id null). Project expenses have their own
  // edit flow on the project page.
  const { data: expense } = await admin
    .from('expenses')
    .select(
      'id, tenant_id, project_id, category_id, amount_cents, tax_cents, vendor, vendor_gst_number, description, expense_date, receipt_storage_path, payment_source_id, card_last4',
    )
    .eq('id', id)
    .maybeSingle();
  if (!expense || expense.tenant_id !== tenant.id) notFound();
  if (expense.project_id !== null) {
    // Nudge toward the right place rather than silently 404.
    redirect(`/projects/${expense.project_id}`);
  }

  const [rows, taxCtx, sourceRows] = await Promise.all([
    listExpenseCategories(),
    canadianTax.getContext(tenant.id).catch(() => null),
    listPaymentSources(),
  ]);
  const pickerOptions = buildPickerOptions(buildCategoryTree(rows));
  const paymentSources = toLite(sourceRows);

  // Sign the receipt so the form can link to it for review/download.
  let receiptUrl: string | null = null;
  if (expense.receipt_storage_path) {
    const { data: signed } = await admin.storage
      .from('receipts')
      .createSignedUrl(expense.receipt_storage_path as string, 3600);
    receiptUrl = signed?.signedUrl ?? null;
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href="/expenses"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Expenses
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Edit overhead expense</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fix the category, tweak the amount, or replace the receipt.
          </p>
        </div>
        <MakeRecurringButton expenseId={expense.id as string} />
      </header>

      <OverheadExpenseForm
        categories={pickerOptions}
        paymentSources={paymentSources}
        gstRate={taxCtx?.gstRate ?? 0}
        gstLabel={
          taxCtx?.breakdown.find((b) => b.label.startsWith('GST') || b.label.startsWith('HST'))
            ?.label ?? 'GST'
        }
        initialValues={{
          id: expense.id as string,
          categoryId: (expense.category_id as string | null) ?? null,
          amountCents: expense.amount_cents as number,
          taxCents: (expense.tax_cents as number) ?? 0,
          vendor: (expense.vendor as string | null) ?? null,
          vendorGstNumber: (expense.vendor_gst_number as string | null) ?? null,
          description: (expense.description as string | null) ?? null,
          expenseDate: expense.expense_date as string,
          existingReceiptPath: (expense.receipt_storage_path as string | null) ?? null,
          existingReceiptUrl: receiptUrl,
          paymentSourceId: (expense.payment_source_id as string | null) ?? null,
          cardLast4: (expense.card_last4 as string | null) ?? null,
        }}
      />
    </div>
  );
}
