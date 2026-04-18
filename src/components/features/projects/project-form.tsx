'use client';

/**
 * Project create/edit form.
 *
 * React Hook Form + Zod. Same component for /projects/new and /projects/[id]/edit.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { CustomerPicker } from '@/components/features/customers/customer-picker';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useHenryForm } from '@/hooks/use-henry-form';
import { type ProjectInput, projectCreateSchema } from '@/lib/validators/project';
import type { ProjectActionResult } from '@/server/actions/projects';

export type ProjectFormCustomerOption = {
  id: string;
  name: string;
};

export type ProjectFormDefaults = Partial<ProjectInput> & { id?: string };

export type ProjectFormProps = {
  mode: 'create' | 'edit';
  customers: ProjectFormCustomerOption[];
  defaults?: ProjectFormDefaults;
  action: (input: ProjectInput & { id?: string }) => Promise<ProjectActionResult>;
  submitLabel?: string;
  cancelHref?: string;
};

const EMPTY: ProjectInput = {
  customer_id: '',
  name: '',
  description: '',
  start_date: '',
  target_end_date: '',
  management_fee_rate: 0.12,
};

export function ProjectForm({
  mode,
  customers,
  defaults,
  action,
  submitLabel,
  cancelHref = '/projects',
}: ProjectFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(projectCreateSchema),
    defaultValues: { ...EMPTY, ...defaults },
  });

  const watched = form.watch();
  const selectedCustomer = customers.find((c) => c.id === watched.customer_id);

  useHenryForm({
    formId: mode === 'create' ? 'project-create' : `project-edit-${defaults?.id ?? ''}`,
    title: mode === 'create' ? 'Creating a new renovation project' : 'Editing a project',
    fields: [
      {
        name: 'customer_id',
        label: 'Customer',
        type: 'text',
        description:
          'Give the customer name; setField resolves to the UUID. If no match, call list_customers first.',
        currentValue: selectedCustomer?.name ?? watched.customer_id,
      },
      { name: 'name', label: 'Project name', type: 'text', currentValue: watched.name },
      {
        name: 'description',
        label: 'Description / scope overview',
        type: 'textarea',
        currentValue: watched.description,
      },
      {
        name: 'start_date',
        label: 'Start date (YYYY-MM-DD)',
        type: 'text',
        currentValue: watched.start_date,
      },
      {
        name: 'target_end_date',
        label: 'Target end date (YYYY-MM-DD)',
        type: 'text',
        currentValue: watched.target_end_date,
      },
      {
        name: 'management_fee_rate',
        label: 'Management fee rate (decimal, e.g. 0.12 for 12%)',
        type: 'number',
        currentValue:
          typeof watched.management_fee_rate === 'number' ? watched.management_fee_rate : null,
      },
    ],
    setField: (name, value) => {
      if (name === 'customer_id') {
        if (customers.some((c) => c.id === value)) {
          form.setValue('customer_id', value, { shouldValidate: true });
          return true;
        }
        const needle = value.trim().toLowerCase();
        const match = customers.find((c) => c.name.toLowerCase().includes(needle));
        if (match) {
          form.setValue('customer_id', match.id, { shouldValidate: true });
          return true;
        }
        return false;
      }
      if (name === 'management_fee_rate') {
        const n = Number.parseFloat(value);
        if (Number.isNaN(n)) return false;
        // Accept either decimal (0.12) or percent (12). Stored as decimal.
        const decimal = n > 1 ? n / 100 : n;
        form.setValue('management_fee_rate', decimal, { shouldValidate: true });
        return true;
      }
      const allowed: (keyof ProjectInput)[] = [
        'name',
        'description',
        'start_date',
        'target_end_date',
      ];
      if (!(allowed as string[]).includes(name)) return false;
      form.setValue(name as keyof ProjectInput, value, { shouldValidate: true });
      return true;
    },
    submit: () => {
      void form.handleSubmit(onSubmit)();
    },
  });

  function onSubmit(values: ProjectInput) {
    setServerError(null);
    startTransition(async () => {
      const payload = defaults?.id ? { ...values, id: defaults.id } : values;
      const result = await action(payload);
      if (result.ok) {
        toast.success(mode === 'create' ? 'Project created' : 'Project updated');
        router.push(`/projects/${result.id}`);
      } else {
        setServerError(result.error);
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            form.setError(field as keyof ProjectInput, { message: msgs[0] });
          }
        }
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {serverError ? (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{serverError}</p>
        ) : null}

        <FormField
          control={form.control}
          name="customer_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Customer</FormLabel>
              <FormControl>
                <CustomerPicker
                  customers={customers}
                  value={field.value}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Project name</FormLabel>
              <FormControl>
                <Input placeholder="e.g. 123 Main St Renovation" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea placeholder="Scope overview..." rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="start_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="target_end_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Target end date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="management_fee_rate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Management fee rate (%)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  placeholder="12"
                  value={field.value ? Math.round(Number(field.value) * 100) : ''}
                  onChange={(e) => field.onChange(Number(e.target.value) / 100)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-3">
          <Button type="submit" disabled={isPending}>
            {isPending
              ? 'Saving...'
              : (submitLabel ?? (mode === 'create' ? 'Create project' : 'Save changes'))}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push(cancelHref)}>
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
}
