'use client';

/**
 * Job create/edit form.
 *
 * React Hook Form + Zod. The same component powers `/jobs/new` and
 * `/jobs/[id]/edit`; the caller chooses which server action to invoke and
 * passes default values for the edit case.
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
import { type JobInput, jobCreateSchema, jobStatuses, jobStatusLabels } from '@/lib/validators/job';
import type { JobActionResult } from '@/server/actions/jobs';

export type JobFormCustomerOption = {
  id: string;
  name: string;
};

export type JobFormDefaults = Partial<JobInput> & { id?: string };

export type JobFormProps = {
  mode: 'create' | 'edit';
  customers: JobFormCustomerOption[];
  defaults?: JobFormDefaults;
  action: (input: JobInput & { id?: string }) => Promise<JobActionResult>;
  submitLabel?: string;
  cancelHref?: string;
};

const EMPTY: JobInput = {
  customer_id: '',
  quote_id: '',
  status: 'booked',
  scheduled_at: '',
  notes: '',
};

export function JobForm({
  mode,
  customers,
  defaults,
  action,
  submitLabel,
  cancelHref,
}: JobFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const initialValues = useMemo<JobInput>(
    () => ({
      ...EMPTY,
      ...defaults,
      status: defaults?.status ?? EMPTY.status,
    }),
    [defaults],
  );

  const form = useForm<JobInput>({
    // biome-ignore lint/suspicious/noExplicitAny: zodResolver v5 + zod v4 type narrowing
    resolver: zodResolver(jobCreateSchema as any),
    defaultValues: initialValues,
    mode: 'onBlur',
  });

  function onSubmit(values: JobInput) {
    setFormError(null);
    startTransition(async () => {
      const payload: JobInput & { id?: string } = {
        ...values,
        ...(defaults?.id ? { id: defaults.id } : {}),
      };
      const result = await action(payload);

      if (result.ok) {
        toast.success(mode === 'create' ? 'Job created.' : 'Job updated.');
        router.push(`/jobs/${result.id}`);
        router.refresh();
        return;
      }

      setFormError(result.error);
      toast.error(result.error);

      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          const msg = messages?.[0];
          if (msg) {
            form.setError(field as keyof JobInput, { message: msg });
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
            name="customer_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer</FormLabel>
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a customer" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {customers.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No customers yet. Add one first.
                      </SelectItem>
                    ) : (
                      customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select value={field.value ?? 'booked'} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {jobStatuses.map((s) => (
                      <SelectItem key={s} value={s}>
                        {jobStatusLabels[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  New jobs usually start as Booked. You can move them through the board after.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="rounded-xl border bg-card p-4">
          <FormField
            control={form.control}
            name="scheduled_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scheduled for</FormLabel>
                <FormControl>
                  <Input
                    type="datetime-local"
                    {...field}
                    value={field.value ?? ''}
                    className="w-full md:w-[260px]"
                  />
                </FormControl>
                <FormDescription>
                  Optional. Leave blank if the date isn't locked in yet.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="rounded-xl border bg-card p-4">
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl>
                  <Textarea
                    rows={5}
                    placeholder="Gate code 4821. Bring the long wand for the second-story siding."
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
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
              : (submitLabel ?? (mode === 'create' ? 'Create job' : 'Save changes'))}
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
