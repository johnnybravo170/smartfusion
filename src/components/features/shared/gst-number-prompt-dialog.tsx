'use client';

/**
 * Inline GST/HST number prompt — fired by the first-send gate on
 * estimates and invoices. The send actions return `requiresGstNumber:
 * true` when the tenant hasn't set a GST# yet; the caller swaps in this
 * dialog, the operator types the number, and the parent retries the
 * send. After it's saved once the prompt never fires again.
 */

import { Loader2, Send } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatGstNumber, GST_NUMBER_FORMAT_HINT, isValidGstNumber } from '@/lib/validators/tax-id';
import { setTenantGstNumberAction } from '@/server/actions/profile';

type Kind = 'estimate' | 'invoice';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Drives copy: "send the estimate" vs "send the invoice". */
  kind: Kind;
  /**
   * Called after the GST/HST number is saved. Parent re-issues the send
   * here (the gate will now pass).
   */
  onSaved: () => void;
};

export function GstNumberPromptDialog({ open, onOpenChange, kind, onSaved }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setValue('');
      setError(null);
    }
  }, [open]);

  function handleSave() {
    const trimmed = value.trim();
    if (!isValidGstNumber(trimmed)) {
      setError(GST_NUMBER_FORMAT_HINT);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setTenantGstNumberAction(trimmed);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onOpenChange(false);
      onSaved();
    });
  }

  const noun = kind === 'estimate' ? 'estimate' : 'invoice';
  const verb = kind === 'estimate' ? 'send the estimate' : 'send the invoice';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !pending) {
            e.preventDefault();
            handleSave();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Add your GST/HST number</AlertDialogTitle>
          <AlertDialogDescription>
            CRA requires your GST/HST number on every {noun}. Add it once and we'll show it on every{' '}
            {noun} from here on out.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="gst-number-prompt">GST/HST number</Label>
            <Input
              id="gst-number-prompt"
              ref={inputRef}
              autoFocus
              placeholder="123456789 RT0001"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onBlur={() => {
                // Re-format to "123456789 RT0001" once the operator
                // tabs away. Quiet polish — only fires when the value
                // is already valid; otherwise leave their input alone
                // so the format error stays meaningful.
                if (isValidGstNumber(value)) setValue(formatGstNumber(value));
              }}
              disabled={pending}
              autoComplete="off"
            />
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{GST_NUMBER_FORMAT_HINT}</p>
            )}
          </div>
        </div>

        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={pending || !value.trim()}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Save & {verb}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
