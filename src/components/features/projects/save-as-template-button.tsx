'use client';

/**
 * "Save as template" button on the Budget page (Editing mode).
 * Captures the current scope into the quote_templates table so the
 * operator can re-apply it on future projects.
 *
 * Per the rollup: prices DEFAULT TO OFF (templates are about structure
 * not pricing — JobTread research walk-back). Operator can toggle on
 * if they really want prices baked in (rare).
 */

import { Loader2, Save } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { saveProjectAsTemplateAction } from '@/server/actions/quote-templates';

export function SaveAsTemplateButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'tenant'>('tenant');
  const [includePrices, setIncludePrices] = useState(false);
  const [pending, startTransition] = useTransition();

  function reset() {
    setLabel('');
    setDescription('');
    setVisibility('tenant');
    setIncludePrices(false);
  }

  function save() {
    startTransition(async () => {
      const res = await saveProjectAsTemplateAction({
        projectId,
        label,
        description: description.trim() || undefined,
        visibility,
        includePrices,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Template "${label}" saved.`);
      setOpen(false);
      reset();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5"
      >
        <Save className="size-3.5" />
        Save as template
      </Button>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save scope as a template</DialogTitle>
          <DialogDescription>
            Reuse this structure on future projects. By default, prices stay out so they don&rsquo;t
            go stale — the next operator fills them in fresh.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="t-label">Template name</Label>
            <Input
              id="t-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Standard bathroom reno"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="t-desc">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="t-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="When to use this template, footprint assumptions, etc."
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">Visibility</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setVisibility('tenant')}
                className={
                  visibility === 'tenant'
                    ? 'rounded-md border-2 border-foreground px-3 py-2 text-xs'
                    : 'rounded-md border px-3 py-2 text-xs hover:bg-muted'
                }
              >
                Whole team
              </button>
              <button
                type="button"
                onClick={() => setVisibility('private')}
                className={
                  visibility === 'private'
                    ? 'rounded-md border-2 border-foreground px-3 py-2 text-xs'
                    : 'rounded-md border px-3 py-2 text-xs hover:bg-muted'
                }
              >
                Just me
              </button>
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <input
              type="checkbox"
              checked={includePrices}
              onChange={(e) => setIncludePrices(e.target.checked)}
              className="mt-0.5"
            />
            <span className="flex-1 text-xs">
              <span className="font-medium">Include current prices</span>
              <span className="block text-muted-foreground">
                Off by default. Prices drift; structure-only templates age better.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending || !label.trim()}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
