'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
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
import type { ReasonTag } from '@/lib/db/queries/worker-unavailability';
import { addUnavailabilityAction } from '@/server/actions/worker-unavailability';

type Props = {
  workerProfileId: string;
  /** Single date selected from the calendar. The form also allows a range for "through". */
  date: string;
};

export function UnavailabilityForm({ workerProfileId, date }: Props) {
  const [pending, startTransition] = useTransition();
  const [tag, setTag] = useState<ReasonTag>('vacation');
  const [through, setThrough] = useState<string>(date);
  const [text, setText] = useState('');

  function buildDateRange(from: string, to: string): string[] {
    const start = new Date(`${from}T00:00`);
    const end = new Date(`${to}T00:00`);
    if (end < start) return [from];
    const out: string[] = [];
    const d = new Date(start);
    // Symmetric runtime-tz YYYY-MM-DD round-trip — both endpoints constructed
    // and formatted in the same tz, used as opaque date keys for the server.
    const fmt = new Intl.DateTimeFormat('en-CA');
    while (d <= end) {
      out.push(fmt.format(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function handleSubmit() {
    const dates = buildDateRange(date, through || date);
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
      toast.success('Time off booked.');
      setText('');
    });
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <p className="text-xs font-semibold uppercase text-muted-foreground">Book time off</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Through (optional)</Label>
          <Input
            type="date"
            min={date}
            value={through}
            onChange={(e) => setThrough(e.target.value)}
          />
        </div>
        <div className="space-y-1">
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
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Note (optional)</Label>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Hawaii trip"
        />
      </div>
      <Button onClick={handleSubmit} disabled={pending} size="sm" className="w-full">
        {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Mark unavailable
      </Button>
    </div>
  );
}
