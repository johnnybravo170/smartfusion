'use client';

import { FileText } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { updateCustomerSummaryAction } from '@/server/actions/project-customer-view';

type Props = {
  projectId: string;
  initialSummaryMd: string | null;
};

export function CustomerSummaryCard({ projectId, initialSummaryMd }: Props) {
  const [value, setValue] = useState<string>(initialSummaryMd ?? '');
  const [saved, setSaved] = useState<string>(initialSummaryMd ?? '');
  const [pending, startTransition] = useTransition();

  function handleSave() {
    const next = value;
    if (next === saved) return;
    startTransition(async () => {
      const res = await updateCustomerSummaryAction({
        projectId,
        summaryMd: next.trim() ? next : null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSaved(next);
      toast.success('Customer summary saved.');
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="size-5" />
          <div>
            <CardTitle>Customer summary</CardTitle>
            <CardDescription>
              Narrative shown to the customer in <em>Lump sum</em> mode. Use it to explain what the
              total covers when no breakdown is visible.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <RichTextEditor
          value={value}
          onChange={setValue}
          onBlur={handleSave}
          placeholder="What's included in this project. Supports **bold**, *italic*, lists."
          rows={5}
          disabled={pending}
        />
      </CardContent>
    </Card>
  );
}
