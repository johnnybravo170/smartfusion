'use client';

/**
 * Plan-change UI: pick a plan + cycle, preview proration, confirm. Server
 * action calls `subscriptions.update` with `proration_behavior:
 * 'create_prorations'`. Webhook flips local plan once Stripe acks.
 */

import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { Plan } from '@/lib/billing/features';
import { type BillingCycle, formatCad, PLAN_CATALOG } from '@/lib/billing/plans';
import {
  changePlanAction,
  type PlanChangePreview,
  previewPlanChangeAction,
} from '@/server/actions/billing-management';

type Preview = Extract<PlanChangePreview, { ok: true }>;

const PLANS: Plan[] = ['starter', 'growth', 'pro', 'scale'];

export function ChangePlanCard({
  currentPlan,
  currentCycle,
}: {
  currentPlan: Plan;
  currentCycle: BillingCycle;
}) {
  const tz = useTenantTimezone();
  const [plan, setPlan] = useState<Plan>(currentPlan);
  const [cycle, setCycle] = useState<BillingCycle>(currentCycle);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const [confirming, startConfirm] = useTransition();
  const router = useRouter();

  const isUnchanged = plan === currentPlan && cycle === currentCycle;

  function handlePreview() {
    setPreview(null);
    setPreviewError(null);
    startPreview(async () => {
      const r = await previewPlanChangeAction({ plan, cycle });
      if (!r.ok) {
        setPreviewError(r.error);
        return;
      }
      setPreview(r);
    });
  }

  function handleConfirm() {
    startConfirm(async () => {
      const r = await changePlanAction({ plan, cycle });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success('Plan updated.');
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2">
          <Sparkles className="size-5 mt-0.5" />
          <div>
            <CardTitle>Change plan</CardTitle>
            <CardDescription>
              Switch tier or billing cycle. Upgrades charge a prorated difference now; downgrades
              credit the unused portion against the next invoice.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="plan-select">Plan</Label>
            <Select
              value={plan}
              onValueChange={(v) => {
                setPlan(v as Plan);
                setPreview(null);
                setPreviewError(null);
              }}
            >
              <SelectTrigger id="plan-select" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLANS.map((p) => {
                  const copy = PLAN_CATALOG[p];
                  return (
                    <SelectItem key={p} value={p}>
                      {copy.name} — {formatCad(copy.monthlyCadCents)}/mo
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="cycle-select">Billing cycle</Label>
            <Select
              value={cycle}
              onValueChange={(v) => {
                setCycle(v as BillingCycle);
                setPreview(null);
                setPreviewError(null);
              }}
            >
              <SelectTrigger id="cycle-select" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly (20% off)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {preview ? (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
            {preview.immediateChargeCents > 0 ? (
              <p>
                Charging{' '}
                <strong>{formatCents(preview.immediateChargeCents, preview.currency)}</strong> now
                (prorated difference).
              </p>
            ) : preview.immediateChargeCents < 0 ? (
              <p>
                You'll receive a credit of{' '}
                <strong>
                  {formatCents(Math.abs(preview.immediateChargeCents), preview.currency)}
                </strong>{' '}
                against the next invoice.
              </p>
            ) : (
              <p>No immediate charge.</p>
            )}
            <p className="text-muted-foreground">
              Next renewal: {formatDate(preview.nextRenewalDate, tz)} for{' '}
              {formatCents(preview.nextRenewalAmountCents, preview.currency)}.
            </p>
          </div>
        ) : previewError ? (
          <p className="text-sm text-destructive">{previewError}</p>
        ) : null}

        <div className="flex gap-2 flex-wrap">
          {preview ? (
            <>
              <Button type="button" onClick={handleConfirm} disabled={confirming}>
                {confirming ? 'Updating…' : 'Confirm change'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPreview(null)}
                disabled={confirming}
              >
                Back
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={handlePreview}
              disabled={isUnchanged || previewing}
              variant="outline"
            >
              {previewing ? 'Calculating…' : 'Preview change'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}
