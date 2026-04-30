'use client';

/**
 * Starter-template picker on the Budget page (Editing mode), shown
 * only when the project has no buckets / lines yet. Apply seeds a
 * structured starting point — cold-start solution per the rollup.
 *
 * Lands on the page as a small banner above the (empty) budget table.
 * Once the operator picks a template, the page revalidates and the
 * banner disappears (replaced by the populated table).
 */

import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  applyStarterTemplateAction,
  listStarterTemplatesAction,
} from '@/server/actions/starter-templates';

type Template = {
  slug: string;
  label: string;
  description: string;
  bucketCount: number;
  lineCount: number;
};

export function StarterTemplatePicker({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open || templates !== null) return;
    listStarterTemplatesAction().then(setTemplates);
  }, [open, templates]);

  function apply(slug: string) {
    startTransition(async () => {
      const res = await applyStarterTemplateAction({ projectId, templateSlug: slug });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Seeded ${res.bucketCount} buckets · ${res.lineCount} line items.`);
      setOpen(false);
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <div>
            <p className="font-medium">Start from a template</p>
            <p className="text-xs text-muted-foreground">
              Pick a job type — bathroom, kitchen, basement, deck — to seed buckets and line items.
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Browse templates
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start from a template</DialogTitle>
          </DialogHeader>
          {templates === null ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading templates…
            </div>
          ) : (
            <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
              {templates.map((t) => (
                <li
                  key={t.slug}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t.label}</p>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t.bucketCount} buckets · {t.lineCount} line items · prices empty
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => apply(t.slug)}
                    disabled={pending}
                    className="shrink-0"
                  >
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Use this
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
