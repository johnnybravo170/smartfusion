'use client';

/**
 * Customer create/edit form.
 *
 * React Hook Form + Zod resolver. The same component powers `/contacts/new`
 * and `/contacts/[id]/edit`; the caller chooses which server action to
 * invoke and passes default values for the edit case.
 *
 * Layout is intentionally type-aware: the order of the blocks shifts so
 * residential contacts lead with the street address, commercial leads with
 * business notes, and agents lead with brokerage contact info. The fields
 * themselves are identical — this is pure presentation.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { Autocomplete, useJsApiLoader } from '@react-google-maps/api';
import { MapPin } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ExistingMatchesBanner } from '@/components/features/contacts/existing-matches-banner';
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
import { useHenryForm } from '@/hooks/use-henry-form';
import type { ContactMatch } from '@/lib/db/queries/contact-matches-types';
import {
  type ContactKind,
  type CustomerCreateInput,
  type CustomerType,
  contactKindLabels,
  contactKinds,
  customerCreateSchema,
  customerTypeLabels,
  customerTypes,
} from '@/lib/validators/customer';
import type { CustomerActionResult } from '@/server/actions/customers';

const LIBRARIES: 'places'[] = ['places'];

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
  kind: 'customer',
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
  const [duplicates, setDuplicates] = useState<ContactMatch[]>([]);

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
    libraries: LIBRARIES,
  });
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  const initialValues = useMemo<CustomerCreateInput>(() => {
    const defaultType = (defaults?.type as CustomerType | undefined) ?? EMPTY.type;
    // Infer default kind from legacy type if the caller didn't pass one:
    // 'agent' → kind=agent; residential/commercial → kind=customer.
    const inferredKind: ContactKind =
      (defaults?.kind as ContactKind | undefined) ??
      (defaultType === 'agent' ? 'agent' : 'customer');
    return {
      ...EMPTY,
      ...defaults,
      type: defaultType,
      kind: inferredKind,
    };
  }, [defaults]);

  // Cast the schema through `unknown` to bridge the zod-v4 / react-hook-form
  // resolver typing gap. Runtime validation is unaffected.
  const form = useForm<CustomerCreateInput>({
    // biome-ignore lint/suspicious/noExplicitAny: zodResolver v5 + zod v4 type narrowing
    resolver: zodResolver(customerCreateSchema as any),
    defaultValues: initialValues,
    mode: 'onBlur',
  });

  const watchedKind = form.watch('kind') ?? 'customer';
  const watchedType = form.watch('type');

  // The legacy form showed "Agent" as a type option; we've now promoted it to
  // a kind. Keep both in sync so submitting a form with kind=agent writes
  // type=agent (legacy shim) while kind=vendor/sub/etc writes a non-customer
  // kind with subtype NULL.
  const kindForSubtypeGate = watchedKind;
  const showCustomerSubtype = kindForSubtypeGate === 'customer';

  // Watch every field we want Henry to see + be able to populate.
  const watched = form.watch();

  // Register this form with Henry so voice dictation on /contacts/new (or
  // /contacts/[id]/edit) fills fields instead of invoking create_customer.
  useHenryForm({
    formId: mode === 'create' ? 'customer-create' : `customer-edit-${defaults?.id ?? ''}`,
    title: mode === 'create' ? 'Creating a new customer' : 'Editing customer details',
    fields: [
      {
        name: 'type',
        label: 'Customer type',
        type: 'enum',
        options: [...customerTypes],
        description: 'residential = homeowner, commercial = business, agent = realtor',
        currentValue: watched.type,
      },
      {
        name: 'name',
        label: 'Full name / business / agent name',
        type: 'text',
        currentValue: watched.name,
      },
      { name: 'phone', label: 'Phone', type: 'tel', currentValue: watched.phone },
      { name: 'email', label: 'Email', type: 'email', currentValue: watched.email },
      {
        name: 'addressLine1',
        label: 'Street address',
        type: 'text',
        currentValue: watched.addressLine1,
      },
      { name: 'city', label: 'City', type: 'text', currentValue: watched.city },
      {
        name: 'province',
        label: 'Province (2-letter, e.g. BC, ON)',
        type: 'text',
        currentValue: watched.province,
      },
      { name: 'postalCode', label: 'Postal code', type: 'text', currentValue: watched.postalCode },
      { name: 'notes', label: 'Notes', type: 'textarea', currentValue: watched.notes },
    ],
    setField: (name, value) => {
      const allowed: (keyof CustomerCreateInput)[] = [
        'type',
        'name',
        'phone',
        'email',
        'addressLine1',
        'city',
        'province',
        'postalCode',
        'notes',
      ];
      if (!(allowed as string[]).includes(name)) return false;
      form.setValue(name as keyof CustomerCreateInput, value, { shouldValidate: true });
      return true;
    },
    submit: () => {
      void form.handleSubmit(onSubmit)();
    },
  });

  const onPlaceChanged = useCallback(() => {
    const autocomplete = autocompleteRef.current;
    if (!autocomplete) return;

    const place = autocomplete.getPlace();
    if (!place.address_components) return;

    let streetNumber = '';
    let route = '';
    let city = '';
    let province = '';
    let postalCode = '';

    for (const component of place.address_components) {
      const type = component.types[0];
      if (type === 'street_number') streetNumber = component.long_name;
      else if (type === 'route') route = component.long_name;
      else if (type === 'locality') city = component.long_name;
      else if (type === 'administrative_area_level_1') province = component.short_name;
      else if (type === 'postal_code') postalCode = component.long_name;
    }

    const addressLine1 = streetNumber ? `${streetNumber} ${route}` : route;

    form.setValue('addressLine1', addressLine1, { shouldValidate: true });
    form.setValue('city', city, { shouldValidate: true });
    form.setValue('province', province, { shouldValidate: true });
    form.setValue('postalCode', postalCode, { shouldValidate: true });
  }, [form]);

  function submit(values: CustomerCreateInput, confirmCreate = false) {
    setFormError(null);
    if (!confirmCreate) setDuplicates([]);
    startTransition(async () => {
      const payload: CustomerCreateInput & { id?: string; confirmCreate?: boolean } = {
        ...values,
        ...(defaults?.id ? { id: defaults.id } : {}),
        ...(confirmCreate ? { confirmCreate: true } : {}),
      };
      const result = await action(payload);

      if (result.ok) {
        toast.success(mode === 'create' ? 'Contact added.' : 'Contact updated.');
        setDuplicates([]);
        if (mode === 'create') {
          router.push(`/contacts/${result.id}`);
          return;
        }
        router.push(`/contacts/${result.id}`);
        router.refresh();
        return;
      }

      setFormError(result.error);

      // Duplicate banner — operator can pick an existing contact to use, or
      // hit "Create anyway" which re-submits with confirmCreate=true.
      if (result.duplicates && result.duplicates.length > 0) {
        setDuplicates(result.duplicates);
        // Don't toast in this case — the banner is the signal.
        return;
      }

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

  function onSubmit(values: CustomerCreateInput) {
    submit(values, false);
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-6"
        aria-busy={pending || undefined}
      >
        {duplicates.length > 0 ? (
          <ExistingMatchesBanner
            matches={duplicates}
            onUseExisting={(id) => {
              setDuplicates([]);
              router.push(`/contacts/${id}`);
            }}
            onCreateAnyway={() => submit(form.getValues(), true)}
          />
        ) : null}

        <div className="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="kind"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Kind</FormLabel>
                <Select
                  value={field.value ?? 'customer'}
                  onValueChange={(next) => {
                    field.onChange(next);
                    // If they flip away from customer, clear the subtype so
                    // the DB invariant (type only when kind=customer) holds.
                    // If they flip back to customer, default to residential.
                    if (next === 'customer') {
                      if (!form.getValues('type') || form.getValues('type') === 'agent') {
                        form.setValue('type', 'residential', { shouldValidate: true });
                      }
                    } else if (next === 'agent') {
                      // Legacy shim: keep the `type` field writeable as 'agent'
                      // so the existing server path keeps working. It's
                      // translated back to kind=agent/subtype=null on save.
                      form.setValue('type', 'agent', { shouldValidate: true });
                    } else {
                      // Vendors, subs, inspectors, referrals, other — no subtype.
                      // Use 'residential' as a harmless placeholder; server
                      // ignores it when kind !== 'customer'.
                      form.setValue('type', 'residential', { shouldValidate: true });
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a kind" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {contactKinds.map((k) => (
                      <SelectItem key={k} value={k}>
                        {contactKindLabels[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  {watchedKind === 'customer' &&
                    'Someone you work for — residential or commercial.'}
                  {watchedKind === 'vendor' &&
                    'Supplier you buy materials from (e.g. Home Depot, local building centre).'}
                  {watchedKind === 'sub' &&
                    'Sub-trade you hire (electrician, plumber, drywaller, framer, etc).'}
                  {watchedKind === 'agent' && 'Real-estate agent who bills to their brokerage.'}
                  {watchedKind === 'inspector' && 'Municipal or private inspector.'}
                  {watchedKind === 'referral' && 'Someone who sends you leads.'}
                  {watchedKind === 'other' && 'Anyone else worth keeping notes on.'}
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
                  {watchedKind === 'customer' && watchedType === 'commercial'
                    ? 'Business name'
                    : watchedKind === 'agent'
                      ? 'Agent name'
                      : watchedKind === 'vendor' || watchedKind === 'sub'
                        ? 'Company name'
                        : 'Full name'}
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      watchedKind === 'customer' && watchedType === 'commercial'
                        ? 'Acme Supply Ltd.'
                        : watchedKind === 'agent'
                          ? 'Helen Fraser (ReMax)'
                          : watchedKind === 'vendor'
                            ? 'Home Depot Pro'
                            : watchedKind === 'sub'
                              ? "Joe's Plumbing"
                              : 'Sarah Chen'
                    }
                    autoComplete={
                      watchedKind === 'customer' && watchedType === 'commercial'
                        ? 'organization'
                        : watchedKind === 'vendor' || watchedKind === 'sub'
                          ? 'organization'
                          : 'name'
                    }
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {showCustomerSubtype ? (
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Customer type</FormLabel>
                  <Select
                    value={field.value === 'agent' ? 'residential' : field.value}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Pick a type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {customerTypes
                        .filter((t) => t !== 'agent')
                        .map((t) => (
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
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
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
            {watchedKind === 'agent'
              ? 'Brokerage address'
              : watchedKind === 'vendor' || watchedKind === 'sub'
                ? 'Business address'
                : watchedKind !== 'customer'
                  ? 'Address'
                  : 'Service address'}
          </h2>
          {isLoaded && (
            <div className="md:col-span-2 flex items-center gap-2">
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <Autocomplete
                onLoad={(auto) => {
                  autocompleteRef.current = auto;
                }}
                onPlaceChanged={onPlaceChanged}
                options={{
                  componentRestrictions: { country: 'ca' },
                  fields: ['address_components', 'formatted_address'],
                  types: ['address'],
                }}
                className="flex-1"
              >
                <input
                  type="text"
                  placeholder="Search address..."
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </Autocomplete>
            </div>
          )}
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
                    : 'Anything your crew needs before showing up on-site.'}
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
              : (submitLabel ?? (mode === 'create' ? 'Create contact' : 'Save changes'))}
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
