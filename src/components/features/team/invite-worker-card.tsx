'use client';

/**
 * Card for creating worker invites. Collects name, email, and pre-set worker
 * settings so the owner can configure the worker before they even sign up.
 */

import { Check, ChevronDown, ChevronUp, Copy, Loader2, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { InvitePrefs } from '@/lib/db/queries/worker-invites';
import { createWorkerInviteAction } from '@/server/actions/team';

export function InviteWorkerCard() {
  const [pending, startTransition] = useTransition();

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [workerType, setWorkerType] = useState<'employee' | 'subcontractor'>('employee');
  const [canExpenses, setCanExpenses] = useState<'inherit' | 'yes' | 'no'>('inherit');
  const [canInvoice, setCanInvoice] = useState<'inherit' | 'yes' | 'no'>('inherit');
  const [payRate, setPayRate] = useState('');
  const [chargeRate, setChargeRate] = useState('');

  // Result state
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleCreate() {
    startTransition(async () => {
      const prefs: InvitePrefs = {
        worker_type: workerType,
        can_log_expenses: canExpenses,
        can_invoice: canInvoice,
        default_hourly_rate_cents: payRate ? Math.round(Number(payRate) * 100) : null,
        default_charge_rate_cents: chargeRate ? Math.round(Number(chargeRate) * 100) : null,
      };

      const result = await createWorkerInviteAction({
        invited_name: name.trim() || undefined,
        invited_email: email.trim() || undefined,
        invite_prefs: prefs,
      });

      if (!result.ok) {
        toast.error(result.error ?? 'Failed to create invite.');
        return;
      }

      setJoinUrl(result.joinUrl ?? null);
      setSentTo(email.trim() || null);
      if (email.trim()) {
        toast.success(`Invite sent to ${email.trim()}.`);
      } else {
        toast.success('Invite link created.');
      }
    });
  }

  async function handleCopy() {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleReset() {
    setJoinUrl(null);
    setSentTo(null);
    setName('');
    setEmail('');
  }

  if (joinUrl) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite created</CardTitle>
          <CardDescription>
            {sentTo ? `Invite email sent to ${sentTo}.` : 'Share this link with the worker.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border bg-muted px-3 py-2 text-sm">
              {joinUrl}
            </code>
            <Button variant="outline" size="icon" onClick={handleCopy} title="Copy link">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={handleReset}>
            <Plus className="size-3.5" />
            Invite another worker
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite a Worker</CardTitle>
        <CardDescription>Generate an invite link. Links expire after 7 days.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-name" className="text-xs">
              Name <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="invite-name"
              placeholder="Jane Smith"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-email" className="text-xs">
              Email <span className="text-muted-foreground">(sends invite automatically)</span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="jane@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowSettings((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {showSettings ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          Worker settings
        </button>

        {showSettings ? (
          <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3 text-sm md:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select
                value={workerType}
                onValueChange={(v) => setWorkerType(v as typeof workerType)}
              >
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
                value={canExpenses}
                onValueChange={(v) => setCanExpenses(v as typeof canExpenses)}
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
              <Select
                value={canInvoice}
                onValueChange={(v) => setCanInvoice(v as typeof canInvoice)}
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
          </div>
        ) : null}

        <Button onClick={handleCreate} disabled={pending} size="sm">
          {pending ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Plus className="mr-2 size-4" />
              {email.trim() ? 'Create & send invite' : 'Create invite link'}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
