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
import { updateWorkerCapabilitiesAction } from '@/server/actions/worker-profiles';

type WorkerProfile = {
  id: string;
  worker_type: 'employee' | 'subcontractor';
  can_log_expenses: boolean | null;
  can_invoice: boolean | null;
  default_hourly_rate_cents: number | null;
  default_charge_rate_cents: number | null;
};

function boolToTri(v: boolean | null): 'inherit' | 'yes' | 'no' {
  if (v === null) return 'inherit';
  return v ? 'yes' : 'no';
}

export function WorkerSettingsRow({ profile }: { profile: WorkerProfile }) {
  const [pending, startTransition] = useTransition();
  const [workerType, setWorkerType] = useState(profile.worker_type);
  const [canLogExpenses, setCanLogExpenses] = useState(boolToTri(profile.can_log_expenses));
  const [canInvoice, setCanInvoice] = useState(boolToTri(profile.can_invoice));
  const [payRate, setPayRate] = useState(
    profile.default_hourly_rate_cents !== null
      ? (profile.default_hourly_rate_cents / 100).toFixed(2)
      : '',
  );
  const [chargeRate, setChargeRate] = useState(
    profile.default_charge_rate_cents !== null
      ? (profile.default_charge_rate_cents / 100).toFixed(2)
      : '',
  );

  function handleSave() {
    startTransition(async () => {
      const result = await updateWorkerCapabilitiesAction({
        profile_id: profile.id,
        worker_type: workerType,
        can_log_expenses: canLogExpenses,
        can_invoice: canInvoice,
        default_pay_rate_dollars: payRate,
        default_charge_rate_dollars: chargeRate,
      });
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to save.');
        return;
      }
      toast.success('Worker settings saved.');
    });
  }

  return (
    <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3 text-sm md:grid-cols-6">
      <div className="space-y-1">
        <Label className="text-xs">Type</Label>
        <Select value={workerType} onValueChange={(v) => setWorkerType(v as typeof workerType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="employee">Employee</SelectItem>
            <SelectItem value="subcontractor">Subcontractor</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Log expenses</Label>
        <Select
          value={canLogExpenses}
          onValueChange={(v) => setCanLogExpenses(v as typeof canLogExpenses)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Default</SelectItem>
            <SelectItem value="yes">Allow</SelectItem>
            <SelectItem value="no">Block</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Submit invoices</Label>
        <Select value={canInvoice} onValueChange={(v) => setCanInvoice(v as typeof canInvoice)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Default</SelectItem>
            <SelectItem value="yes">Allow</SelectItem>
            <SelectItem value="no">Block</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Pay ($/hr)</Label>
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
        <Label className="text-xs">Charge ($/hr)</Label>
        <Input
          type="number"
          step="0.01"
          min="0"
          value={chargeRate}
          onChange={(e) => setChargeRate(e.target.value)}
          placeholder="—"
        />
      </div>
      <div className="flex items-end">
        <Button onClick={handleSave} disabled={pending} size="sm" className="w-full">
          {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
