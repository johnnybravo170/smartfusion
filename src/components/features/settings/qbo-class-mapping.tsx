'use client';

/**
 * QBO Class → HH Project mapping UI.
 *
 * One row per distinct QBO class name found across bills/expenses,
 * sorted by total spend. Per row: a project picker + apply button.
 * The picker stages a selection locally; "Apply" runs the bulk update.
 * Toggle "Overwrite existing" lets the user re-assign rows that were
 * already manually classified to a different project (default: off).
 */

import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  applyClassMappingAction,
  type ClassMappingSummary,
} from '@/server/actions/qbo-class-mapping';

const UNMAPPED = '__none__';

type Props = {
  classes: ClassMappingSummary[];
  projects: Array<{ id: string; name: string }>;
};

export function QboClassMapping({ classes, projects }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeClass, setActiveClass] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of classes) {
      init[c.qbo_class_name] = c.current_project_id ?? UNMAPPED;
    }
    return init;
  });

  function apply(className: string) {
    const projectChoice = selections[className] ?? UNMAPPED;
    const projectId = projectChoice === UNMAPPED ? null : projectChoice;
    setActiveClass(className);
    startTransition(async () => {
      const result = await applyClassMappingAction({
        qboClassName: className,
        projectId,
        preserveExisting: !overwrite,
      });
      if (result.ok) {
        const total = result.bills_updated + result.expenses_updated;
        toast.success(
          total === 0
            ? 'Nothing to update.'
            : `Tagged ${total} record${total === 1 ? '' : 's'} (${result.bills_updated} bills, ${result.expenses_updated} expenses).`,
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
      setActiveClass(null);
    });
  }

  if (classes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No QBO Classes in your imports</CardTitle>
          <CardDescription>
            Either your QuickBooks company doesn&rsquo;t use Classes, or no bills / purchases in
            your imports had one set. Class assignment lives on each line in QBO — the importer
            captures the first non-empty class it finds on each record.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Map QBO Classes to projects</CardTitle>
            <CardDescription>
              {classes.length} distinct class{classes.length === 1 ? '' : 'es'} across your imported
              bills and expenses. Pick the HH project each one belongs to. Records get tagged in
              bulk.
            </CardDescription>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Overwrite existing
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {classes.map((c) => {
          const isPending = pending && activeClass === c.qbo_class_name;
          const currentSelection = selections[c.qbo_class_name] ?? UNMAPPED;
          return (
            <div
              key={c.qbo_class_name}
              className="grid grid-cols-1 items-center gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-[1fr_240px_auto]"
            >
              <div className="min-w-0">
                <p className="font-medium">{c.qbo_class_name}</p>
                <p className="text-xs text-muted-foreground">
                  {c.bill_count} bill{c.bill_count === 1 ? '' : 's'} · {c.expense_count} expense
                  {c.expense_count === 1 ? '' : 's'} · {formatCurrency(c.total_cents)}
                  {c.current_project_name && (
                    <>
                      {' · '}
                      <Badge variant="outline" className="ml-1 font-normal">
                        currently → {c.current_project_name}
                      </Badge>
                    </>
                  )}
                </p>
              </div>
              <Select
                value={currentSelection}
                onValueChange={(v) => setSelections((s) => ({ ...s, [c.qbo_class_name]: v }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                  <ChevronDown className="size-3.5 opacity-50" aria-hidden="true" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNMAPPED}>— No project —</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => apply(c.qbo_class_name)}
                disabled={isPending}
                className="justify-self-end"
              >
                {isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Apply
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
