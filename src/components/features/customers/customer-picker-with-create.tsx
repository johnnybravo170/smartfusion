'use client';

/**
 * CustomerPicker + inline "Create new customer" panel.
 *
 * Standardizes the pick-or-create customer flow used by the new-project
 * form, the clone-project dialog, and any future place that needs to
 * select an existing customer or quickly create one without leaving the
 * current screen.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { ExistingMatchesBanner } from '@/components/features/contacts/existing-matches-banner';
import { CustomerPicker } from '@/components/features/customers/customer-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ContactMatch } from '@/lib/db/queries/contact-matches-types';
import { createCustomerAction } from '@/server/actions/customers';

export type CustomerOption = { id: string; name: string };

export type CustomerPickerWithCreateProps = {
  customers: CustomerOption[];
  value: string;
  onChange: (id: string) => void;
  /** Called after a new customer is created so the parent can update its picker list. */
  onCustomerCreated?: (customer: CustomerOption) => void;
  placeholder?: string;
};

export function CustomerPickerWithCreate({
  customers,
  value,
  onChange,
  onCustomerCreated,
  placeholder,
}: CustomerPickerWithCreateProps) {
  const [showInline, setShowInline] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<ContactMatch[]>([]);

  async function submitCreate(confirmCreate: boolean) {
    setSaving(true);
    const res = await createCustomerAction({
      type: 'residential',
      name: draft.name.trim(),
      email: draft.email.trim(),
      phone: draft.phone.trim(),
      ...(confirmCreate ? { confirmCreate: true } : {}),
    });
    setSaving(false);
    if (!res.ok) {
      if (res.duplicates && res.duplicates.length > 0) {
        setDuplicates(res.duplicates);
        return;
      }
      toast.error(res.error);
      return;
    }
    const created = { id: res.id, name: draft.name.trim() };
    onCustomerCreated?.(created);
    onChange(res.id);
    setShowInline(false);
    setDuplicates([]);
    toast.success('Customer added');
  }

  return (
    <div>
      <CustomerPicker
        customers={customers}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        onAddNew={() => {
          setDraft({ name: '', email: '', phone: '' });
          setShowInline(true);
        }}
      />
      {showInline ? (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
          {duplicates.length > 0 ? (
            <ExistingMatchesBanner
              matches={duplicates}
              onUseExisting={(id) => {
                const match = duplicates.find((m) => m.id === id);
                onCustomerCreated?.({ id, name: match?.name ?? '' });
                onChange(id);
                setShowInline(false);
                setDuplicates([]);
              }}
              onCreateAnyway={() => submitCreate(true)}
            />
          ) : null}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            New customer
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              placeholder="Name *"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <Input
              placeholder="Email"
              value={draft.email}
              onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
            />
            <Input
              placeholder="Phone"
              value={draft.phone}
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowInline(false);
                setDuplicates([]);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || !draft.name.trim()}
              onClick={() => submitCreate(false)}
            >
              {saving ? 'Saving…' : 'Save customer'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
