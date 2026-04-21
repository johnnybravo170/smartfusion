'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ReasonTag } from '@/lib/db/queries/worker-unavailability';
import { addUnavailabilityAction } from '@/server/actions/worker-unavailability';

export type ScheduleCell =
  | { type: 'scheduled'; projectName: string }
  | { type: 'unavailable'; reasonLabel: string; reasonText: string | null }
  | { type: 'both'; projectName: string; reasonLabel: string }
  | { type: 'empty' };

type Props = {
  projectId: string;
  startDate: string; // yyyy-mm-dd (first day shown)
  days: number; // e.g. 14
  workers: Array<{ profile_id: string; display_name: string }>;
  /** Map key = `${worker_profile_id}|${iso_date}` */
  cells: Record<string, ScheduleCell>;
};

function addDays(iso: string, offset: number): string {
  const d = new Date(`${iso}T00:00`);
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
}

export function CrewScheduleGrid({
  projectId: _projectId,
  startDate,
  days,
  workers,
  cells,
}: Props) {
  const dates: string[] = Array.from({ length: days }, (_, i) => addDays(startDate, i));

  if (workers.length === 0) {
    return <p className="text-sm text-muted-foreground">No workers assigned yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">
              Worker
            </th>
            {dates.map((d) => {
              const dt = new Date(`${d}T00:00`);
              const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
              return (
                <th
                  key={d}
                  className={`px-1 py-2 text-center font-medium ${isWeekend ? 'text-muted-foreground/70' : ''}`}
                >
                  <div>{dt.toLocaleDateString('en-CA', { weekday: 'short' }).slice(0, 2)}</div>
                  <div>{dt.getDate()}</div>
                </th>
              );
            })}
            <th className="w-[120px] px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.profile_id} className="border-b last:border-0">
              <td className="sticky left-0 z-10 whitespace-nowrap bg-background px-3 py-2 font-medium">
                {w.display_name}
              </td>
              {dates.map((d) => {
                const key = `${w.profile_id}|${d}`;
                const cell = cells[key] ?? { type: 'empty' };
                const title = cellTitle(cell);
                return (
                  <td key={d} className="p-1 text-center align-middle" title={title}>
                    <CellContent cell={cell} />
                  </td>
                );
              })}
              <td className="px-2 py-1 text-right">
                <MarkUnavailableDialog
                  workerProfileId={w.profile_id}
                  workerName={w.display_name}
                  defaultDate={startDate}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellTitle(c: ScheduleCell): string {
  if (c.type === 'scheduled') return `Scheduled: ${c.projectName}`;
  if (c.type === 'unavailable')
    return `Unavailable: ${c.reasonLabel}${c.reasonText ? ` — ${c.reasonText}` : ''}`;
  if (c.type === 'both') return `Scheduled (${c.projectName}) and unavailable (${c.reasonLabel})`;
  return '';
}

function CellContent({ cell }: { cell: ScheduleCell }) {
  const base = 'mx-auto flex size-6 items-center justify-center rounded text-[10px] font-medium';
  if (cell.type === 'empty') return <div className={`${base} text-muted-foreground/30`}>·</div>;
  if (cell.type === 'scheduled')
    return <div className={`${base} bg-blue-500/20 text-blue-900 dark:text-blue-200`}>✓</div>;
  if (cell.type === 'unavailable')
    return <div className={`${base} bg-amber-500/20 text-amber-900 dark:text-amber-200`}>×</div>;
  return <div className={`${base} bg-red-500/30 text-red-900 dark:text-red-200`}>!</div>;
}

function MarkUnavailableDialog({
  workerProfileId,
  workerName,
  defaultDate,
}: {
  workerProfileId: string;
  workerName: string;
  defaultDate: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(defaultDate);
  const [to, setTo] = useState(defaultDate);
  const [tag, setTag] = useState<ReasonTag>('vacation');
  const [text, setText] = useState('');
  const [pending, startTransition] = useTransition();

  function handleSubmit() {
    const dates: string[] = [];
    const start = new Date(`${from}T00:00`);
    const end = new Date(`${to}T00:00`);
    if (end < start) {
      toast.error('End date is before start date.');
      return;
    }
    const d = new Date(start);
    while (d <= end) {
      dates.push(d.toLocaleDateString('en-CA'));
      d.setDate(d.getDate() + 1);
    }
    startTransition(async () => {
      const res = await addUnavailabilityAction({
        worker_profile_id: workerProfileId,
        dates,
        reason_tag: tag,
        reason_text: text,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Marked unavailable.');
      setOpen(false);
      setText('');
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs">
          Time off
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {workerName} unavailable</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Reason</Label>
            <Select value={tag} onValueChange={(v) => setTag(v as ReasonTag)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vacation">Vacation</SelectItem>
                <SelectItem value="sick">Sick</SelectItem>
                <SelectItem value="other_job">Other job</SelectItem>
                <SelectItem value="personal">Personal</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Note (optional)</Label>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Hawaii trip"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
