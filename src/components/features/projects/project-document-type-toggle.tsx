'use client';

/**
 * Toggle between customer-facing "Estimate" and "Quote" on a project.
 *
 * Estimate = ballpark, non-binding, subject to change.
 * Quote    = fixed-price, binding unless scope changes formally.
 *
 * The toggle only affects the heading / framing on the customer-facing
 * page. Internal UX (cost breakdown, approval flow, etc.) is identical
 * between the two.
 */

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { patchProjectDocumentTypeAction } from '@/server/actions/estimate-snippets';

export type ProjectDocumentType = 'estimate' | 'quote';

export function ProjectDocumentTypeToggle({
  projectId,
  initialValue,
}: {
  projectId: string;
  initialValue: ProjectDocumentType;
}) {
  const [value, setValue] = useState<ProjectDocumentType>(initialValue);
  const [pending, startTransition] = useTransition();

  function handleChange(next: string) {
    if (next !== 'estimate' && next !== 'quote') return;
    if (next === value) return;
    const prev = value;
    setValue(next);
    startTransition(async () => {
      const res = await patchProjectDocumentTypeAction(projectId, next);
      if (!res.ok) {
        toast.error(res.error);
        setValue(prev);
        return;
      }
      toast.success(
        next === 'quote'
          ? 'Now a fixed-price quote — heading updated.'
          : 'Back to an estimate — heading updated.',
      );
    });
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="doc-type" className="text-xs font-medium text-muted-foreground">
        Document type
      </label>
      <Select value={value} onValueChange={handleChange} disabled={pending}>
        <SelectTrigger id="doc-type" className="h-8 w-[180px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="estimate">Estimate (ballpark)</SelectItem>
          <SelectItem value="quote">Quote (fixed price)</SelectItem>
        </SelectContent>
      </Select>
      {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}
