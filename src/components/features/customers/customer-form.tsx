'use client';

/**
 * Customer create/edit form.
 *
 * React Hook Form + Zod resolver. The same component powers `/customers/new`
 * and `/customers/[id]/edit`; the caller chooses which server action to
 * invoke and passes default values for the edit case.
 *
 * Layout is intentionally type-aware: the order of the blocks shifts so
 * residential contacts lead with the street address, commercial leads with
 * business notes, and agents lead with brokerage contact info. The fields
 * themselves are identical — this is pure presentation.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  type CustomerCreateInput,
  type CustomerType,
  customerCreateSchema,
  customerTypeLabels,
  customerTypes,
} from '@/lib/validators/customer';
import type { CustomerActionResult } from '@/server/actions/customers';

export type CustomerFormDefaults = Partial<CustomerCreateInput> & { id?: string };

export type CustomerFormProps = {
  mode: 'create' | 'edit';
  defaults?: CustomerFormDefaults;
  action: (input: CustomerCreateInput & { id?: string }) => Promise<CustomerActionResult>;
  submitLabel?: string;
  cancelHref?: string;
};

const EMPTY: CustomerCreateInput = {
  type: 'residential',
  name: '',
  email: '',
  phone: '',
  addressLine1: '',
  city: '',
  province: 'BC',
  postalCode: '',
  notes: '',
};

export function CustomerForm({
  mode,
  defaults,
  action,
  submitLabel,
  cancelHref,
}: CustomerFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const initialValues = useMemo<CustomerCreateInput>(
    () => ({
      ...EMPTY,
      ...defaults,
      type: (defaults?.type as CustomerType | undefined) ?? EMPTY.type,
    }),
    [defaults],
  );

  // Cast the schema through `unknown` to bridge the zod-v4 / react-hook-form
  // resolver typing gap. Runtime validation is unaffected.
  const form = useForm<CustomerCreateInput>({
    // biome-ignore lint/suspicious/noExplicitAny: zodResolver v5 + zod v4 type narrowing
    resolver: zodResolver(customerCreateSchema as any),
    defaultValues: initialValues,
    mode: 'onBlur',
  });

  const watchedType = form.watch('type');

  function onSubmit(values: CustomerCreateInput) {
    setFormError(null);
    startTransition(async () => {
      const payload: CustomerCreateInput & { id?: string } = {
        ...values,
        ...(defaults?.id ? { id: defaults.id } : {}),
      };
      const result = await action(payload);

      if (result.ok) {
        toast.success(mode === 'create' ? 'Customer added.' : 'Customer updated.');
        if (mode === 'create') {
          router.push(`/customers/${result.id}`);
          return;
        }
        router.push(`/customers/${result.id}`);
        router.refresh();
        return;
      }

      setFormError(result.error);
      toast.error(result.error);

      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          const msg = messages?.[0];
          if (msg) {
            form.setError(field as keyof CustomerCreateInput, { message: msg });
          }
        }
      }
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-6"
        aria-busy={pending || undefined}
      >
        <div className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer type</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {customerTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {customerTypeLabels[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  {watchedType === 'residential' && 'A homeowner or tenant at a single address.'}
                  {watchedType === 'commercial' &&
                    'A business, strata, or property manager. Notes capture ongoing agreements.'}
                  {watchedType === 'agent' &&
                    'A real-estate agent who bills to their brokerage, often for pre-listing rushes.'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {watchedType === 'commercial'
                    ? 'Business name'
                    : watchedType === 'agent'
                      ? 'Agent name'
                      : 'Full name'}
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      watchedType === 'commercial'
                        ? 'Acme Supply Ltd.'
                        : watchedType === 'agent'
                          ? 'Helen Fraser (ReMax)'
                          : 'Sarah Chen'
                    }
                    autoComplete={watchedType === 'commercial' ? 'organization' : 'name'}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Contact
          </h2>
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    placeholder="604-555-0100"
                    autoComplete="tel"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    placeholder="customer@example.com"
                    autoComplete="email"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {watchedType === 'agent' ? 'Brokerage address' : 'Service address'}
          </h2>
          <FormField
            control={form.control}
            name="addressLine1"
            render={({ field }) => (
              <FormItem className="md:col-span-2">
                <FormLabel>Street address</FormLabel>
                <FormControl>
                  <Input
                    placeholder="1234 Maple Crescent"
                    autoComplete="address-line1"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>City</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Abbotsford"
                    autoComplete="address-level2"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="province"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Province</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="BC"
                      autoComplete="address-level1"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="postalCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Postal code</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="V2S 7K9"
                      autoComplete="postal-code"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {watchedType === 'commercial'
                    ? 'Agreement notes'
                    : watchedType === 'agent'
                      ? 'Billing + brokerage notes'
                      : 'Notes'}
                </FormLabel>
                <FormControl>
                  <Textarea
                    rows={watchedType === 'commercial' ? 5 : 4}
                    placeholder={
                      watchedType === 'commercial'
                        ? 'Net-30 billing. Quarterly recurring service on the first Monday.'
                        : watchedType === 'agent'
                          ? 'Bill ReMax directly. Rush service 48-hour turnaround.'
                          : 'Gate code 4821. Dog in the yard — text before arriving.'
                    }
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormDescription>
                  {watchedType === 'commercial'
                    ? 'Capture recurring terms and contact expectations.'
                    : 'Anything Will needs before showing up on-site.'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {formError ? (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? mode === 'create'
                ? 'Saving…'
                : 'Updating…'
              : (submitLabel ?? (mode === 'create' ? 'Create customer' : 'Save changes'))}
          </Button>
          {cancelHref ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push(cancelHref)}
              disabled={pending}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Form>
  );
}
