'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Socials } from '@/lib/db/queries/profile';
import { updateSocialsAction } from '@/server/actions/profile';

const FIELDS: Array<{ key: keyof Socials; label: string; placeholder: string }> = [
  { key: 'googleBusiness', label: 'Google Business', placeholder: 'g.page/your-business' },
  { key: 'instagram', label: 'Instagram', placeholder: 'instagram.com/yourhandle' },
  { key: 'facebook', label: 'Facebook', placeholder: 'facebook.com/yourbusiness' },
  { key: 'tiktok', label: 'TikTok', placeholder: 'tiktok.com/@yourhandle' },
  { key: 'youtube', label: 'YouTube', placeholder: 'youtube.com/@yourchannel' },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'linkedin.com/company/yours' },
  { key: 'x', label: 'X / Twitter', placeholder: 'x.com/yourhandle' },
];

export function SocialsForm({ socials }: { socials: Socials }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of FIELDS) out[f.key] = (socials[f.key] as string | null | undefined) ?? '';
    return out;
  });
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await updateSocialsAction(values);
      if (result.ok) toast.success('Links saved.');
      else toast.error(result.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {FIELDS.map((f) => (
        <div key={f.key}>
          <Label htmlFor={`soc-${f.key}`} className="mb-1.5 block text-sm">
            {f.label}
          </Label>
          <Input
            id={`soc-${f.key}`}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
            placeholder={f.placeholder}
          />
        </div>
      ))}
      <div className="pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save links'}
        </Button>
      </div>
    </form>
  );
}
