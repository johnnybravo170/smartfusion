'use client';

/**
 * useHenryForm — registers a form with Henry's screen context so voice
 * dictation ("fill in my name, it's Mike Dawson") populates the fields
 * instead of going through a CRUD tool.
 *
 * Usage inside a form component:
 *   useHenryForm({
 *     formId: 'customer-create',
 *     title: 'Creating a new customer',
 *     fields: [
 *       { name: 'name', label: 'Full name', type: 'text', currentValue: form.watch('name') },
 *       ...
 *     ],
 *     setField: (name, value) => { form.setValue(name as keyof Input, value); return true; },
 *     submit: () => form.handleSubmit(onSubmit)(),
 *   });
 */

import { useEffect } from 'react';
import { type HenryFormRegistration, useHenryScreen } from '@/lib/henry/screen-context';

export function useHenryForm(reg: HenryFormRegistration) {
  const { register, unregister } = useHenryScreen();

  // Re-register whenever any of the field values or the registration itself
  // changes so Henry's view of the form is always fresh. JSON.stringify is
  // a deliberate deep-compare trigger so callers don't have to memoize the
  // fields array every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deep-compare trigger
  useEffect(() => {
    register(reg);
    return () => unregister(reg.formId);
  }, [register, unregister, reg, JSON.stringify(reg.fields)]);
}
