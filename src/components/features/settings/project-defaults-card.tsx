'use client';

import { Briefcase, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateDefaultManagementFeeRateAction } from '@/server/actions/project-defaults';

type Props = {
  defaultManagementFeeRate: number;
};

function ratePct(rate: number) {
  return Math.round(rate * 1000) / 10;
}

export function ProjectDefaultsCard({ defaultManagementFeeRate }: Props) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(String(ratePct(defaultManagementFeeRate)));

  function handleSave() {
    const pct = Number.parseFloat(value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
      toast.error('Enter a percentage between 0 and 50.');
      return;
    }
    const newRate = Math.round(pct * 10) / 1000;
    if (Math.abs(newRate - defaultManagementFeeRate) < 0.0001) {
      toast.success('No changes to save.');
      return;
    }
    startTransition(async () => {
      const res = await updateDefaultManagementFeeRateAction({ rate: newRate });
      if (res.ok) {
        toast.success('Default management fee saved.');
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Briefcase className="size-5" />
          <div>
            <CardTitle>Project defaults</CardTitle>
            <CardDescription>
              Starting values for new projects. You can override on any individual project.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="default_management_fee_rate" className="text-sm font-medium">
            Default management fee
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="default_management_fee_rate"
              type="number"
              min={0}
              max={50}
              step={0.1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-24"
              disabled={pending}
              aria-label="Default management fee percentage"
            />
            <span className="text-sm text-muted-foreground">%</span>
            <Button onClick={handleSave} disabled={pending} size="sm" className="ml-2">
              {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Applied to new projects at creation. Existing projects keep their current rate.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
