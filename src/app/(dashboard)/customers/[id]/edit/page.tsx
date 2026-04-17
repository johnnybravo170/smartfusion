import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomerForm } from '@/components/features/customers/customer-form';
import { getCustomer } from '@/lib/db/queries/customers';
import type { CustomerCreateInput, CustomerType } from '@/lib/validators/customer';
import { type CustomerActionResult, updateCustomerAction } from '@/server/actions/customers';

export const metadata = {
  title: 'Edit customer — HeyHenry',
};

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const customer = await getCustomer(id);
  if (!customer) notFound();

  const defaults: CustomerCreateInput & { id: string } = {
    id: customer.id,
    type: customer.type as CustomerType,
    name: customer.name,
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    addressLine1: customer.address_line1 ?? '',
    city: customer.city ?? '',
    province: customer.province ?? '',
    postalCode: customer.postal_code ?? '',
    notes: customer.notes ?? '',
  };

  // Thin wrapper that matches the form's action signature (always has an id
  // in edit mode). Declared inline as an arrow-free function so React can
  // serialize it for the client component.
  async function action(
    input: CustomerCreateInput & { id?: string },
  ): Promise<CustomerActionResult> {
    'use server';
    return updateCustomerAction({ ...input, id: id });
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/customers/${customer.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to {customer.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit customer</h1>
        <p className="text-sm text-muted-foreground">Update contact and address details.</p>
      </header>

      <CustomerForm
        mode="edit"
        defaults={defaults}
        action={action}
        cancelHref={`/customers/${customer.id}`}
      />
    </div>
  );
}
