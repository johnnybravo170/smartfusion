'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/**
 * Per-send checkbox for the quote follow-up autopilot. Used inside the
 * estimate preview send dialog (project flow) and the legacy quotes
 * Send/Resend dialogs.
 */
export function AutoFollowupRow({
  checked,
  onCheckedChange,
  disabled,
  available,
  id = 'confirm-auto-followup',
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
  available: boolean;
  id?: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <Label
        htmlFor={id}
        className="flex-1 cursor-pointer text-xs font-normal text-muted-foreground"
      >
        Auto follow up if no response —{' '}
        <span className="text-foreground">SMS at 24h, email at 48h.</span>{' '}
        {!available ? (
          <span className="text-amber-700">Available on Growth plan and up.</span>
        ) : null}
      </Label>
    </div>
  );
}
