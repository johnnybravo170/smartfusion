'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BusinessProfile } from '@/lib/db/queries/profile';
import { PROVINCE_OPTIONS } from '@/lib/tax/provinces';
import { updateBusinessProfileAction } from '@/server/actions/profile';

export function BusinessProfileForm({ profile }: { profile: BusinessProfile }) {
  const [name, setName] = useState(profile.name);
  const [addressLine1, setAddressLine1] = useState(profile.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(profile.addressLine2 ?? '');
  const [city, setCity] = useState(profile.city ?? '');
  const [province, setProvince] = useState(profile.province ?? '');
  const [postalCode, setPostalCode] = useState(profile.postalCode ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [contactEmail, setContactEmail] = useState(profile.contactEmail ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(profile.websiteUrl ?? '');
  const [reviewUrl, setReviewUrl] = useState(profile.reviewUrl ?? '');
  const [gstNumber, setGstNumber] = useState(profile.gstNumber ?? '');
  const [wcbNumber, setWcbNumber] = useState(profile.wcbNumber ?? '');

  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await updateBusinessProfileAction({
        name,
        addressLine1,
        addressLine2,
        city,
        province,
        postalCode,
        phone,
        contactEmail,
        websiteUrl,
        reviewUrl,
        gstNumber,
        wcbNumber,
      });
      if (result.ok) toast.success('Business profile saved.');
      else toast.error(result.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Business name" id="bp-name" required>
        <Input id="bp-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Phone" id="bp-phone">
          <Input
            id="bp-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(604) 555-0100"
          />
        </Field>
        <Field label="Contact email" id="bp-email">
          <Input
            id="bp-email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="hello@yourbusiness.com"
          />
        </Field>
      </div>

      <Field label="Address line 1" id="bp-addr1">
        <Input
          id="bp-addr1"
          value={addressLine1}
          onChange={(e) => setAddressLine1(e.target.value)}
        />
      </Field>
      <Field label="Address line 2" id="bp-addr2">
        <Input
          id="bp-addr2"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="City" id="bp-city">
          <Input id="bp-city" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Province" id="bp-prov">
          <select
            id="bp-prov"
            value={province}
            onChange={(e) => setProvince(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">— Pick —</option>
            {PROVINCE_OPTIONS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Postal code" id="bp-post">
          <Input id="bp-post" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        </Field>
      </div>

      <Field label="Website" id="bp-web">
        <Input
          id="bp-web"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          placeholder="yourbusiness.com"
        />
      </Field>

      <Field
        label="Review URL"
        id="bp-review"
        help="The link customers follow to leave a review (e.g. your Google Business review link)."
      >
        <Input
          id="bp-review"
          value={reviewUrl}
          onChange={(e) => setReviewUrl(e.target.value)}
          placeholder="https://g.page/your-business/review"
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="GST number" id="bp-gst" help="Shown on estimates and invoices.">
          <Input
            id="bp-gst"
            value={gstNumber}
            onChange={(e) => setGstNumber(e.target.value)}
            placeholder="123456789 RT0001"
          />
        </Field>
        <Field label="WCB account number" id="bp-wcb" help="Shown on estimates and invoices.">
          <Input
            id="bp-wcb"
            value={wcbNumber}
            onChange={(e) => setWcbNumber(e.target.value)}
            placeholder="WCB-XXXXXXX"
          />
        </Field>
      </div>

      <div className="pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save business info'}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  id,
  help,
  required,
  children,
}: {
  label: string;
  id: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-sm">
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      {children}
      {help ? <p className="mt-1 text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
