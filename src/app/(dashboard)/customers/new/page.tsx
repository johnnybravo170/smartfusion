import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { CustomerForm } from '@/components/features/customers/customer-form';
import { createCustomerAction } from '@/server/actions/customers';

export const metadata = {
  title: 'New customer — Smartfusion',
};

export default function NewCustomerPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to customers
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Add a customer</h1>
        <p className="text-sm text-muted-foreground">
          Start with the basics — you can always come back and add more detail.
        </p>
      </header>

      <CustomerForm mode="create" action={createCustomerAction} cancelHref="/customers" />
    </div>
  );
}
