'use client';

/**
 * Clone-project dialog. Lives next to the delete button on the project
 * detail page. Lets the user pick a customer (or inline-create one), name
 * the new project, and choose which related data to bring over.
 *
 * Cost buckets and notes are the only categories cloned today; assignments
 * are date-bound and execution data (photos, worklog, invoices, jobs,
 * change orders) is intentionally excluded.
 */

import { Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  type CustomerOption,
  CustomerPickerWithCreate,
} from '@/components/features/customers/customer-picker-with-create';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cloneProjectAction } from '@/server/actions/projects';

type CloneOption = 'cost_buckets' | 'notes' | 'line_photos';

export function CloneProjectDialog({
  projectId,
  projectName,
  defaultCustomerId,
  customers,
}: {
  projectId: string;
  projectName: string;
  defaultCustomerId: string | null;
  customers: CustomerOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(`Copy of ${projectName}`);
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? '');
  const [customerList, setCustomerList] = useState(customers);
  const [include, setInclude] = useState<Record<CloneOption, boolean>>({
    cost_buckets: true,
    notes: true,
    line_photos: false,
  });

  // Reset state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setName(`Copy of ${projectName}`);
      setCustomerId(defaultCustomerId ?? '');
      setCustomerList(customers);
      setInclude({ cost_buckets: true, notes: true, line_photos: false });
    }
  }, [open, projectName, defaultCustomerId, customers]);

  function handleSubmit() {
    if (!customerId) {
      toast.error('Pick a customer.');
      return;
    }
    if (!name.trim()) {
      toast.error('Project name is required.');
      return;
    }
    startTransition(async () => {
      const res = await cloneProjectAction({
        source_id: projectId,
        customer_id: customerId,
        name: name.trim(),
        clone_cost_buckets: include.cost_buckets,
        clone_notes: include.notes,
        keep_line_photos: include.line_photos,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Project cloned.');
      setOpen(false);
      router.push(`/projects/${res.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Clone project"
          className="size-8 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Copy className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone {projectName}</DialogTitle>
          <DialogDescription>
            Creates a new project. Pick what to bring over. Photos, costs, invoices, and worklog
            history stay with the original.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="clone-name">New project name</Label>
            <Input
              id="clone-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Customer</Label>
            <CustomerPickerWithCreate
              customers={customerList}
              value={customerId}
              onChange={setCustomerId}
              onCustomerCreated={(c) => setCustomerList((cs) => [c, ...cs])}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Bring over</p>
            <label
              htmlFor="clone-cost-buckets"
              className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 hover:bg-muted/40"
            >
              <Checkbox
                id="clone-cost-buckets"
                checked={include.cost_buckets}
                onCheckedChange={(v) => setInclude((s) => ({ ...s, cost_buckets: v === true }))}
                disabled={pending}
              />
              <div className="flex-1">
                <p className="text-sm font-medium">Estimate (buckets + line items)</p>
                <p className="text-xs text-muted-foreground">
                  Bucket structure plus every line item with its quantity, cost, and price. Actuals
                  (time, expenses, bills) are not copied.
                </p>
              </div>
            </label>
            <label
              htmlFor="clone-notes"
              className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 hover:bg-muted/40"
            >
              <Checkbox
                id="clone-notes"
                checked={include.notes}
                onCheckedChange={(v) => setInclude((s) => ({ ...s, notes: v === true }))}
                disabled={pending}
              />
              <div className="flex-1">
                <p className="text-sm font-medium">Project notes</p>
                <p className="text-xs text-muted-foreground">
                  Plain-text notes from the Notes tab. Worklog history is not copied.
                </p>
              </div>
            </label>
            <label
              htmlFor="clone-line-photos"
              className={`flex items-start gap-2 rounded-md border p-2.5 ${
                include.cost_buckets
                  ? 'cursor-pointer hover:bg-muted/40'
                  : 'cursor-not-allowed opacity-60'
              }`}
            >
              <Checkbox
                id="clone-line-photos"
                checked={include.line_photos}
                onCheckedChange={(v) => setInclude((s) => ({ ...s, line_photos: v === true }))}
                disabled={pending || !include.cost_buckets}
              />
              <div className="flex-1">
                <p className="text-sm font-medium">Keep photo references on line items</p>
                <p className="text-xs text-muted-foreground">
                  Cost lines can have photos attached. Off (default) starts with a clean slate; on
                  keeps the original photos visible on the cloned lines. Only applies when the
                  estimate is being copied.
                </p>
              </div>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={pending}>
            {pending ? 'Cloning…' : 'Clone project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
