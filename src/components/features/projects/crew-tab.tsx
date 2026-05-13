'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { formatCurrency } from '@/lib/pricing/calculator';
import { assignWorkerAction, removeAssignmentAction } from '@/server/actions/project-assignments';

export type CrewWorker = {
  profile_id: string;
  display_name: string;
  worker_type: 'employee' | 'subcontractor';
  default_hourly_rate_cents: number | null;
  default_charge_rate_cents: number | null;
};

export type CrewAssignment = {
  id: string;
  worker_profile_id: string;
  scheduled_date: string | null;
  hourly_rate_cents: number | null;
  charge_rate_cents: number | null;
  notes: string | null;
};

type Props = {
  projectId: string;
  workers: CrewWorker[];
  assignments: CrewAssignment[];
};

export function CrewTab({ projectId, workers, assignments }: Props) {
  const tz = useTenantTimezone();
  const [pending, startTransition] = useTransition();
  const [workerId, setWorkerId] = useState<string>(workers[0]?.profile_id ?? '');
  const [payRate, setPayRate] = useState<string>('');
  const [chargeRate, setChargeRate] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  const workerById = useMemo(() => new Map(workers.map((w) => [w.profile_id, w])), [workers]);

  function handleAssign() {
    if (!workerId) {
      toast.error('Pick a worker.');
      return;
    }
    startTransition(async () => {
      const result = await assignWorkerAction({
        project_id: projectId,
        worker_profile_id: workerId,
        scheduled_date: null,
        pay_rate_dollars: payRate,
        charge_rate_dollars: chargeRate,
        notes,
      });
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to assign.');
        return;
      }
      toast.success('Worker assigned.');
      setPayRate('');
      setChargeRate('');
      setNotes('');
    });
  }

  function handleRemove(assignmentId: string) {
    startTransition(async () => {
      const result = await removeAssignmentAction(assignmentId);
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to remove.');
        return;
      }
      toast.success('Removed.');
    });
  }

  const ongoing = assignments.filter((a) => a.scheduled_date === null);
  const scheduled = assignments
    .filter((a) => a.scheduled_date !== null)
    .sort((a, b) => (a.scheduled_date ?? '').localeCompare(b.scheduled_date ?? ''));

  return (
    <div className="space-y-6">
      {workers.length === 0 ? (
        <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No workers yet. Invite one from{' '}
          <a href="/settings/team" className="underline">
            Settings &rsaquo; Team
          </a>
          .
        </p>
      ) : (
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-semibold">Assign worker</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <div className="space-y-1">
              <Label className="text-xs">Worker</Label>
              <Select value={workerId} onValueChange={setWorkerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick worker" />
                </SelectTrigger>
                <SelectContent>
                  {workers.map((w) => (
                    <SelectItem key={w.profile_id} value={w.profile_id}>
                      {w.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Pay override ($/hr)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={payRate}
                onChange={(e) => setPayRate(e.target.value)}
                placeholder="—"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Charge override ($/hr)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={chargeRate}
                onChange={(e) => setChargeRate(e.target.value)}
                placeholder="—"
              />
            </div>
            <div className="space-y-1 md:col-span-1">
              <Label className="text-xs">Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="" />
            </div>
            <div className="flex items-end">
              <Button onClick={handleAssign} disabled={pending} className="w-full">
                {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Assign
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Adds the worker as ongoing crew. Use the schedule grid below to assign specific dates.
          </p>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Ongoing crew</h3>
        <AssignmentTable
          assignments={ongoing}
          workerById={workerById}
          onRemove={handleRemove}
          showDate={false}
          emptyLabel="No ongoing assignments."
          tz={tz}
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Scheduled days</h3>
        <AssignmentTable
          assignments={scheduled}
          workerById={workerById}
          onRemove={handleRemove}
          showDate={true}
          emptyLabel="No scheduled days."
          tz={tz}
        />
      </section>
    </div>
  );
}

function AssignmentTable({
  assignments,
  workerById,
  onRemove,
  showDate,
  emptyLabel,
  tz,
}: {
  assignments: CrewAssignment[];
  workerById: Map<string, CrewWorker>;
  onRemove: (id: string) => void;
  showDate: boolean;
  emptyLabel: string;
  tz: string;
}) {
  if (assignments.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Worker</TableHead>
          {showDate ? <TableHead>Date</TableHead> : null}
          <TableHead>Pay</TableHead>
          <TableHead>Charge</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead className="w-[60px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {assignments.map((a) => {
          const w = workerById.get(a.worker_profile_id);
          const pay = a.hourly_rate_cents ?? w?.default_hourly_rate_cents ?? null;
          const charge = a.charge_rate_cents ?? w?.default_charge_rate_cents ?? null;
          return (
            <TableRow key={a.id}>
              <TableCell className="text-sm">
                {w?.display_name ?? 'Unknown'}
                <span className="ml-2 text-xs text-muted-foreground">
                  {w?.worker_type === 'subcontractor' ? 'sub' : 'employee'}
                </span>
              </TableCell>
              {showDate ? (
                <TableCell className="text-sm">
                  {a.scheduled_date
                    ? new Intl.DateTimeFormat('en-CA', {
                        timeZone: tz,
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      }).format(new Date(`${a.scheduled_date}T00:00`))
                    : '—'}
                </TableCell>
              ) : null}
              <TableCell className="text-sm">
                {pay !== null ? formatCurrency(pay) : '—'}
                {a.hourly_rate_cents !== null &&
                a.hourly_rate_cents !== w?.default_hourly_rate_cents ? (
                  <span className="ml-1 text-xs text-muted-foreground">(override)</span>
                ) : null}
              </TableCell>
              <TableCell className="text-sm">
                {charge !== null ? formatCurrency(charge) : '—'}
                {a.charge_rate_cents !== null &&
                a.charge_rate_cents !== w?.default_charge_rate_cents ? (
                  <span className="ml-1 text-xs text-muted-foreground">(override)</span>
                ) : null}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{a.notes ?? ''}</TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(a.id)}
                  aria-label="Remove assignment"
                >
                  <Trash2 className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
